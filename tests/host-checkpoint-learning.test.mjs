// tests/host-checkpoint-learning.test.mjs
//
// What a person tells the agent becomes a remembered preference — so it stops
// asking the same question on every run. Permission never does.
//
// A remembered approval is a guardrail that silently stopped working.
// Permission is per-action and per-moment: somebody who approved one booking
// has not approved the next one, and an agent that learns otherwise is worse
// than one that asks every time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { learnableAnswers } = await import('../host/memory/learner.mjs');
const rec = await import('../host/jobs/record.mjs');

const batch = (over = {}) => ({
  batchId: 'inp-1',
  jobId: 'job-1',
  askedBy: 'tool',
  questions: [{ fieldId: 'pace', kind: 'pick_one', prompt: 'How full should the days be?' }],
  askedAt: '2026-09-30T00:00:00Z',
  staleAfter: '2026-10-01T00:00:00Z',
  expiresAt: '2026-10-07T00:00:00Z',
  ...over,
});

const answered = (b, answers) => [
  rec.questionAskedEntry('job-1', { batch: b }),
  rec.answerReceivedEntry('job-1', { batchId: b.batchId, answers, answeredBy: 'p-1' }),
];

// ---------------------------------------------------------------------------
// What is learnt
// ---------------------------------------------------------------------------

test('a tool question is learnable', () => {
  const out = learnableAnswers(answered(batch(), { pace: 'relaxed' }));
  assert.equal(out.length, 1);
  assert.equal(out[0].prompt, 'How full should the days be?');
  assert.equal(out[0].answer, 'relaxed');
});

test('an agent question is learnable too', () => {
  const out = learnableAnswers(answered(batch({ askedBy: 'agent' }), { pace: 'packed' }));
  assert.equal(out.length, 1);
});

test('a free-text answer is learnable', () => {
  const b = batch({ questions: [{ fieldId: 'notes', kind: 'text', prompt: 'Anything to avoid?' }] });
  const out = learnableAnswers(answered(b, { notes: 'no early starts' }));
  assert.equal(out[0].answer, 'no early starts');
});

test('an Other answer is unwrapped to what the person actually wrote', () => {
  const b = batch({ questions: [{ fieldId: 'budget', kind: 'pick_one_or_text', prompt: 'How much a day?' }] });
  const out = learnableAnswers(answered(b, { budget: { other: 'about 6000 rupees' } }));
  assert.equal(out[0].answer, 'about 6000 rupees');
});

test('a multi-select answer keeps all of its choices', () => {
  const b = batch({ questions: [{ fieldId: 'interests', kind: 'pick_many', prompt: 'Built around what?' }] });
  const out = learnableAnswers(answered(b, { interests: ['art', 'food'] }));
  assert.deepEqual(out[0].answer, ['art', 'food']);
});

// ---------------------------------------------------------------------------
// What is never learnt
// ---------------------------------------------------------------------------

test('a guardrail question is never learnable', () => {
  const b = batch({ askedBy: 'guardrail', questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' }] });
  assert.deepEqual(learnableAnswers(answered(b, { proceed: 'approve' })), []);
});

test('a TOOL-raised approval is never learnable either', () => {
  // The clause that matters. Nothing in the kit stops a tool raising an
  // approval question of its own, and `askedBy` alone would let a standing
  // permission through.
  const b = batch({ askedBy: 'tool', questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' }] });
  assert.deepEqual(learnableAnswers(answered(b, { proceed: 'approve' })), []);
});

test('a guardrail question is not learnable even when it is not an approval', () => {
  // Belt and braces the other way round: the safety layer is excluded whatever
  // shape its question takes.
  const b = batch({ askedBy: 'guardrail', questions: [{ fieldId: 'why', kind: 'text', prompt: 'Why?' }] });
  assert.deepEqual(learnableAnswers(answered(b, { why: 'because' })), []);
});

test('a mixed batch learns the preferences and drops the approval', () => {
  const b = batch({
    askedBy: 'agent',
    questions: [
      { fieldId: 'pace', kind: 'pick_one', prompt: 'How full?' },
      { fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' },
    ],
  });
  const out = learnableAnswers(answered(b, { pace: 'relaxed', proceed: 'approve' }));
  assert.deepEqual(out.map(a => a.answer), ['relaxed']);
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

test('an unanswered batch contributes nothing', () => {
  assert.deepEqual(learnableAnswers([rec.questionAskedEntry('job-1', { batch: batch() })]), []);
});

test('an answer whose batch was never recorded is ignored, not guessed at', () => {
  // Without the batch there is no way to know who asked or what kind it was,
  // and guessing would be guessing about permission.
  assert.deepEqual(
    learnableAnswers([rec.answerReceivedEntry('job-1', { batchId: 'inp-gone', answers: { x: 'y' }, answeredBy: 'p' })]),
    [],
  );
});

test('a field the person left out is not invented', () => {
  const b = batch({
    questions: [
      { fieldId: 'pace', kind: 'pick_one', prompt: 'How full?' },
      { fieldId: 'notes', kind: 'text', prompt: 'Anything else?' },
    ],
  });
  const out = learnableAnswers(answered(b, { pace: 'relaxed' }));
  assert.equal(out.length, 1);
});

test('several batches across one run are all collected', () => {
  const history = [
    ...answered(batch({ batchId: 'inp-1' }), { pace: 'relaxed' }),
    ...answered(batch({ batchId: 'inp-2', questions: [{ fieldId: 'budget', kind: 'text', prompt: 'Budget?' }] }), { budget: 'premium' }),
  ];
  assert.deepEqual(learnableAnswers(history).map(a => a.answer), ['relaxed', 'premium']);
});

test('empty history is empty, not an error', () => {
  assert.deepEqual(learnableAnswers([]), []);
  assert.deepEqual(learnableAnswers(), []);
});

// ---------------------------------------------------------------------------
// The answers reach the prompt
//
// learnableAnswers picking the right batches is only half of it. If the block
// never lands in the prompt, the model learns nothing from it and every test
// above passes anyway.
// ---------------------------------------------------------------------------

const { createLearner } = await import('../host/memory/learner.mjs');

/** Runs a real extract and hands back the prompt the learner actually sent. */
async function promptFor(answers) {
  let sent = null;
  const learner = createLearner({
    longTermMemory: { async store(e) { return { entry: e }; }, async promote() {} },
    fleetApi: {
      async executePrompt({ prompt }) {
        sent = prompt;
        return '```json\n{"newFacts": [], "usedRecalledIds": []}\n```';
      },
    },
    logger: { info() {}, warn() {} },
  });
  await learner.extract({
    task: { id: 'job-1', goal: 'Plan a trip' },
    history: [],
    recalledFacts: [],
    answers,
  });
  return sent;
}

test('the answers reach the prompt as their own block', async () => {
  const prompt = await promptFor(learnableAnswers(answered(batch(), { pace: 'relaxed' })));
  assert.match(prompt, /stated preferences, not inferred ones/);
  assert.match(prompt, /asked "How full should the days be\?" → relaxed/);
  // And the placeholder is spent, not left sitting in the text sent to a model.
  assert.ok(!prompt.includes('{{ANSWERS}}'));
});

test('a multi-select answer is rendered readably, not as JSON', async () => {
  const b = batch({ questions: [{ fieldId: 'interests', kind: 'pick_many', prompt: 'Built around what?' }] });
  const prompt = await promptFor(learnableAnswers(answered(b, { interests: ['art', 'food'] })));
  assert.match(prompt, /asked "Built around what\?" → art, food/);
  assert.ok(!prompt.includes('["art"'), 'no raw array syntax reaches the model');
});

test('a run with no answers says so rather than leaving a gap', async () => {
  // An empty block would read as a truncated prompt. "(none)" matches how the
  // recalled-facts block already handles the same case.
  const prompt = await promptFor([]);
  assert.match(prompt, /stated preferences, not inferred ones\):\n\(none\)/);
  assert.ok(!prompt.includes('{{ANSWERS}}'));
});

test('an unexpected answer shape reaches the model as text, not [object Object]', async () => {
  // learnableAnswers unwraps `{other: '...'}`, but a question kind added later
  // could hand back any object. Rendering it with string interpolation put
  // "[object Object]" in the prompt — the model learns nothing and nobody
  // notices, because the prompt still looks well-formed.
  const prompt = await promptFor([{ prompt: 'When?', answer: { from: '2026-10-01', to: '2026-10-07' } }]);
  assert.equal(prompt.includes('[object Object]'), false);
  assert.match(prompt, /2026-10-01/);
});
