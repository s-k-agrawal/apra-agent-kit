// tests/host-human-input-pause.test.mjs
//
// The pause mechanism end to end through the run loop: askUser unwinds a run,
// the run loop reports `paused` rather than failed, the guardrail uses askUser
// only when there is no approvalCallback, and a resumed run replays the
// answers it already has instead of asking again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi } from './helpers/mock-fleet.mjs';

const {
  createAskUser, PauseRequested, TooManyInterruptions, InvalidQuestion,
  isPauseRequested, answeredBatchesFromHistory, approvalQuestion, isApproved,
  DEFAULT_MAX_INTERRUPTIONS,
} = await import('../host/human-input/ask.mjs');

const { runTask } = await import('../host/run-loop.mjs');
const { createGuardrails } = await import('../host/guardrails.mjs');
const { createBatch } = await import('../host/human-input/batch.mjs');
const { executeTool } = await import('../host/tools/executor.mjs');
const rec = await import('../host/jobs/record.mjs');

const oneQuestion = [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?', required: true }];

// ---------------------------------------------------------------------------
// askUser
// ---------------------------------------------------------------------------

test('askUser: asking throws PauseRequested carrying the batch', async () => {
  const ask = createAskUser({ jobId: 'job-1' });
  await assert.rejects(
    () => ask({ askedBy: 'agent', questions: oneQuestion }),
    (err) => {
      assert.ok(isPauseRequested(err));
      assert.equal(err.batch.jobId, 'job-1');
      assert.equal(err.batch.askedBy, 'agent');
      assert.deepEqual(err.batch.questions, oneQuestion);
      return true;
    },
  );
});

test('askUser: the batch is persisted before the pause is thrown', async () => {
  // An unpersisted question is one nobody will ever see.
  const seen = [];
  const ask = createAskUser({ jobId: 'job-1', onQuestion: (b) => { seen.push(b); } });
  await assert.rejects(() => ask({ questions: oneQuestion }), PauseRequested);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].questions[0].fieldId, 'proceed');
});

test('askUser: if persisting fails, the pause fails - it never proceeds as refused', async () => {
  // Continuing as though the person had said no would run the opposite of
  // what they were never asked.
  const ask = createAskUser({
    jobId: 'job-1',
    onQuestion: () => { throw new Error('store down'); },
  });
  await assert.rejects(() => ask({ questions: oneQuestion }), /store down/);
});

test('askUser: an unanswerable question is refused rather than shown', async () => {
  const ask = createAskUser({ jobId: 'job-1' });
  await assert.rejects(
    () => ask({ questions: [{ fieldId: 'pick', kind: 'pick_one', prompt: 'Which?' }] }),
    InvalidQuestion,
  );
});

test('askUser: a replayed answer is returned instead of pausing', async () => {
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-1', answers: { proceed: 'approve' } }],
  });
  const answer = await ask({ questions: oneQuestion });
  assert.equal(answer.replayed, true);
  assert.equal(answer.batchId, 'inp-1');
  assert.equal(isApproved(answer), true);
});

test('askUser: a replayed answer is not a new interruption', async () => {
  // Nobody is being stopped, so nothing should count against the limit.
  const ask = createAskUser({
    jobId: 'job-1',
    interruptions: 0,
    answered: [{ batchId: 'inp-1', answers: { proceed: 'approve' } }],
  });
  await ask({ questions: oneQuestion });
  assert.equal(ask.interruptions(), 0);
});

test('askUser: answers replay in the order they were asked, then it pauses again', async () => {
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [
      { batchId: 'inp-1', answers: { proceed: 'approve' } },
      { batchId: 'inp-2', answers: { proceed: 'deny' } },
    ],
  });
  assert.equal((await ask({ questions: oneQuestion })).batchId, 'inp-1');
  assert.equal((await ask({ questions: oneQuestion })).batchId, 'inp-2');
  await assert.rejects(() => ask({ questions: oneQuestion }), PauseRequested);
});

// ---------------------------------------------------------------------------
// Interruption limit
// ---------------------------------------------------------------------------

test('askUser: the limit counts batches and defaults to ten', async () => {
  assert.equal(DEFAULT_MAX_INTERRUPTIONS, 10);
  const ask = createAskUser({ jobId: 'job-1', config: { maxInterruptions: 2 } });

  await assert.rejects(() => ask({ questions: oneQuestion }), PauseRequested);
  await assert.rejects(() => ask({ questions: oneQuestion }), PauseRequested);
  await assert.rejects(
    () => ask({ questions: oneQuestion }),
    (err) => {
      assert.equal(err.name, 'TooManyInterruptions');
      assert.equal(err.limit, 2);
      return true;
    },
  );
});

test('askUser: a ten-field form is one interruption, not ten', async () => {
  const ask = createAskUser({ jobId: 'job-1', config: { maxInterruptions: 1 } });
  const tenFields = Array.from({ length: 10 }, (_, i) => ({
    fieldId: `f${i}`, kind: 'text', prompt: `Question ${i}?`, required: true,
  }));
  await assert.rejects(() => ask({ questions: tenFields }), PauseRequested);
  assert.equal(ask.interruptions(), 1);
});

test('askUser: the counter continues across a resume rather than resetting', async () => {
  // A counter that lives only in memory resets on every resume, and the limit
  // never trips - a run could ask forever, one question per resume.
  const ask = createAskUser({ jobId: 'job-1', config: { maxInterruptions: 3 }, interruptions: 3 });
  await assert.rejects(() => ask({ questions: oneQuestion }), TooManyInterruptions);
});

test('answeredBatchesFromHistory: reads answers in order from history', () => {
  const history = [
    rec.runStartedEntry('job-1', { task: {}, traceId: 't' }),
    rec.questionAskedEntry('job-1', { batch: { batchId: 'inp-1' } }),
    rec.answerReceivedEntry('job-1', { batchId: 'inp-1', answers: { a: '1' }, answeredBy: 'p' }),
    rec.questionAskedEntry('job-1', { batch: { batchId: 'inp-2' } }),
    rec.answerReceivedEntry('job-1', { batchId: 'inp-2', answers: { b: '2' }, answeredBy: 'p' }),
  ];
  assert.deepEqual(answeredBatchesFromHistory(history), [
    { batchId: 'inp-1', answers: { a: '1' } },
    { batchId: 'inp-2', answers: { b: '2' } },
  ]);
});

// ---------------------------------------------------------------------------
// The executor must not swallow a pause
// ---------------------------------------------------------------------------

test('executor: a pause from inside a tool propagates, it is not a tool_error', async () => {
  // executeTool turns every throw into { ok: false }. If it did that here the
  // run would carry on past a question nobody had answered.
  const ask = createAskUser({ jobId: 'job-1' });
  const tool = { name: 'book', run: ({ askUser }) => askUser({ questions: oneQuestion }) };

  await assert.rejects(
    () => executeTool(tool, { args: {}, askUser: ask }),
    PauseRequested,
  );
});

test('executor: an unaskable question propagates too, it is not a tool_error', async () => {
  // This one bites harder than the pause. Degraded to `{ ok: false }` the
  // strategy treats it as a failed tool call, the model proposes the same call
  // again, and the run loops on a question that can never be asked.
  const ask = createAskUser({ jobId: 'job-1' });
  const tool = {
    name: 'ask-badly',
    run: ({ askUser }) => askUser({ questions: [{ fieldId: 'x', kind: 'pick_one', prompt: 'Which?' }] }),
  };
  await assert.rejects(() => executeTool(tool, { args: {}, askUser: ask }), InvalidQuestion);
});

test('executor: hitting the interruption limit inside a tool propagates', async () => {
  const ask = createAskUser({ jobId: 'job-1', config: { maxInterruptions: 0 } });
  const tool = { name: 'ask', run: ({ askUser }) => askUser({ questions: oneQuestion }) };
  await assert.rejects(() => executeTool(tool, { args: {}, askUser: ask }), TooManyInterruptions);
});

test('executor: ordinary tool failures are still values, not throws', async () => {
  const tool = { name: 'boom', run: () => { throw new Error('nope'); } };
  const res = await executeTool(tool, { args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'tool_error');
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

const irreversible = (over = {}) => ({ name: 'book', reversible: false, run: async () => 'booked', ...over });
const ran = async (t, opts) => ({ ok: true, result: await t.run(opts) });

test('guardrails: with neither callback nor askUser, behaviour is exactly today\'s', async () => {
  const g = createGuardrails({}, [], ran);
  const res = await g.execute(irreversible(), { args: {} });
  assert.deepEqual(res, { ok: false, error: 'guardrail_denied', reason: 'approval_denied' });
});

test('guardrails: approvalCallback keeps precedence over askUser', async () => {
  // Silently rerouting an adopter who already has a callback would send their
  // approvals to a screen they do not run.
  let asked = false;
  const ask = async () => { asked = true; throw new PauseRequested({ batchId: 'x' }); };
  const g = createGuardrails({ approvalCallback: async () => 'approve' }, [], ran);

  const res = await g.execute(irreversible(), { args: {}, askUser: ask });
  assert.equal(res.ok, true);
  assert.equal(asked, false, 'askUser must not be consulted when a callback exists');
});

test('guardrails: askUser is used when no callback is configured', async () => {
  const g = createGuardrails({}, [], ran);
  const ask = createAskUser({ jobId: 'job-1' });

  await assert.rejects(
    () => g.execute(irreversible(), { args: {}, askUser: ask }),
    (err) => {
      assert.ok(isPauseRequested(err));
      assert.equal(err.batch.askedBy, 'guardrail');
      assert.equal(err.batch.askedByDetail, 'book');
      assert.equal(err.batch.questions[0].kind, 'approval');
      return true;
    },
  );
});

test('guardrails: a pause is never converted into a denial', async () => {
  // Catching PauseRequested here would run the tool's opposite: the person
  // said nothing, and "nothing" would be read as "no".
  const g = createGuardrails({}, [], ran);
  const ask = createAskUser({ jobId: 'job-1' });
  let settled = null;
  try {
    settled = await g.execute(irreversible(), { args: {}, askUser: ask });
  } catch (err) {
    assert.ok(isPauseRequested(err));
  }
  assert.equal(settled, null, 'execute must not return at all when it pauses');
});

test('guardrails: a replayed approve runs the tool and records who allowed it', async () => {
  const g = createGuardrails({}, [], ran);
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-7', answers: { proceed: 'approve' } }],
  });
  const res = await g.execute(irreversible(), { args: {}, askUser: ask });
  assert.equal(res.ok, true);
  assert.deepEqual(res.approval, { decision: 'approve', batchId: 'inp-7' });
});

test('guardrails: a replayed deny refuses, and says which batch refused it', async () => {
  const g = createGuardrails({}, [], ran);
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-7', answers: { proceed: 'deny' } }],
  });
  const res = await g.execute(irreversible(), { args: {}, askUser: ask });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'approval_denied');
  assert.deepEqual(res.approval, { decision: 'deny', batchId: 'inp-7' });
});

test('guardrails: a run with no human input produces the results it always did', async () => {
  const g = createGuardrails({}, [], ran);
  const res = await g.execute({ name: 'read', reversible: true, run: async () => 'ok' }, { args: {} });
  assert.deepEqual(res, { ok: true, result: 'ok' }, 'no approval key is added');
});

test('guardrails: freeze still wins over askUser', async () => {
  // The kill switch exists so an operator can stop writes without a redeploy.
  // Asking someone whether to override it would defeat that.
  const g = createGuardrails({ freeze: true }, [], ran);
  const ask = createAskUser({ jobId: 'job-1' });
  const res = await g.execute(irreversible(), { args: {}, askUser: ask });
  assert.equal(res.reason, 'frozen');
});

test('guardrails: a denying policy is not negotiable by asking', async () => {
  const g = createGuardrails({ policies: { book: 'deny' } }, [], ran);
  const ask = createAskUser({ jobId: 'job-1' });
  const res = await g.execute(irreversible(), { args: {}, askUser: ask });
  assert.equal(res.reason, 'policy_denied');
});

test('guardrails: the question is plain language, with no identifiers in it', async () => {
  // A question nobody understands trains people to approve reflexively, and
  // internal structure on a screen is an information-disclosure surface.
  const g = createGuardrails({}, [], ran);
  const ask = createAskUser({ jobId: 'job-1' });
  const tool = irreversible({
    name: 'flight_booking_api_v2',
    approvalPrompt: (args) => `Book the flight to ${args.city} for 412 dollars?`,
  });

  await assert.rejects(
    () => g.execute(tool, { args: { city: 'Paris', fare_class_id: 'Y-77' }, askUser: ask }),
    (err) => {
      const prompt = err.batch.questions[0].prompt;
      assert.equal(prompt, 'Book the flight to Paris for 412 dollars?');
      assert.equal(prompt.includes('flight_booking_api_v2'), false);
      assert.equal(prompt.includes('fare_class_id'), false);
      return true;
    },
  );
});

test('guardrails: a tool with no self-description falls back to vague, not to its name', async () => {
  const g = createGuardrails({}, [], ran);
  const ask = createAskUser({ jobId: 'job-1' });

  await assert.rejects(
    () => g.execute(irreversible({ name: 'internal_purge_v3' }), { args: {}, askUser: ask }),
    (err) => {
      assert.equal(err.batch.questions[0].prompt.includes('internal_purge_v3'), false);
      assert.match(err.batch.questions[0].prompt, /cannot be undone/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------

const toolCall = (tool, args = {}) =>
  '```tool_call\n' + JSON.stringify({ tool, args }) + '\n```';

const done = (result) => '```done\n' + JSON.stringify({ result, summary: 's' }) + '\n```';

function fleetSaying(...responses) {
  return createMockFleetApi({ members: ['doer', 'reviewer'], promptResponses: responses });
}

test('run loop: a pause unwinds cleanly and reports paused, not failed', async () => {
  const ask = createAskUser({ jobId: 'job-1' });
  const tools = [irreversible({ approvalPrompt: 'Book the flight?' })];
  const guardrails = createGuardrails({}, tools, ran);

  const out = await runTask({ goal: 'book a flight' }, {
    strategy: 'open-ended',
    tools,
    guardrails,
    askUser: ask,
    fleetApi: fleetSaying(toolCall('book')),
  });

  assert.equal(out.status, 'paused');
  assert.equal(out.result, null, 'a pause is not a result');
  assert.match(out.batchId, /^inp-/);
  assert.equal(out.batch.questions[0].prompt, 'Book the flight?');
  assert.ok(out.progress, 'the caller needs somewhere to resume from');
  assert.equal(out.traceId != null, true);
});

test('run loop: a paused run is not a terminal status', () => {
  assert.equal(rec.TERMINAL_STATUSES.has('paused'), false);
});

test('run loop: exceeding the interruption limit fails with its own code', async () => {
  const ask = createAskUser({ jobId: 'job-1', config: { maxInterruptions: 0 } });
  const tools = [irreversible()];

  const out = await runTask({ goal: 'book a flight' }, {
    strategy: 'open-ended',
    tools,
    guardrails: createGuardrails({}, tools, ran),
    askUser: ask,
    fleetApi: fleetSaying(toolCall('book')),
  });

  assert.equal(out.status, 'failed');
  assert.equal(out.result.error, 'too_many_interruptions');
  assert.equal(out.result.limit, 0);
});

test('run loop: an unanswerable question fails the run rather than looping on it', async () => {
  // Regression. When the executor swallowed this into `{ ok: false }` the
  // strategy read it as a failed tool call, the model proposed the same call
  // again, and the run span until the process died.
  const ask = createAskUser({ jobId: 'job-1' });
  const tools = [{
    name: 'ask-badly',
    reversible: true,
    run: ({ askUser }) => askUser({ questions: [{ fieldId: 'x', kind: 'pick_one', prompt: 'Which?' }] }),
  }];

  const out = await runTask({ goal: 'g' }, {
    strategy: 'open-ended',
    tools,
    askUser: ask,
    fleetApi: fleetSaying(toolCall('ask-badly')),
  });

  assert.equal(out.status, 'failed');
  assert.equal(out.result.error, 'invalid_question');
});

test('run loop: hitting the limit inside a tool fails the run, it does not loop', async () => {
  const ask = createAskUser({ jobId: 'job-1', config: { maxInterruptions: 0 } });
  const tools = [{ name: 'ask', reversible: true, run: ({ askUser }) => askUser({ questions: oneQuestion }) }];

  const out = await runTask({ goal: 'g' }, {
    strategy: 'open-ended',
    tools,
    askUser: ask,
    fleetApi: fleetSaying(toolCall('ask')),
  });

  assert.equal(out.status, 'failed');
  assert.equal(out.result.error, 'too_many_interruptions');
});

test('run loop: with no askUser, an irreversible tool is denied exactly as before', async () => {
  const tools = [irreversible()];
  const out = await runTask({ goal: 'g' }, {
    strategy: 'open-ended',
    tools,
    guardrails: createGuardrails({}, tools, ran),
    fleetApi: fleetSaying(toolCall('book'), done('gave up')),
  });

  assert.equal(out.status, 'completed');
  const observation = out.history.find(o => o.type === 'observation');
  assert.equal(observation.result.reason, 'approval_denied');
});

test('run loop: a resumed run replays its answer and carries on', async () => {
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-7', answers: { proceed: 'approve' } }],
  });
  const tools = [irreversible()];

  const out = await runTask({ goal: 'book a flight' }, {
    strategy: 'open-ended',
    tools,
    guardrails: createGuardrails({}, tools, ran),
    askUser: ask,
    fleetApi: fleetSaying(toolCall('book'), done('booked')),
  });

  assert.equal(out.status, 'completed');
  assert.equal(out.result, 'booked');
});

test('run loop: resumeFrom seeds the observations a run had before it paused', async () => {
  const before = [{ type: 'observation', tool: 'search', args: {}, result: { ok: true, result: { hits: 4 } } }];

  const out = await runTask({ goal: 'g' }, {
    strategy: 'open-ended',
    tools: [],
    resumeFrom: { observations: before },
    fleetApi: fleetSaying(done('carried on')),
  });

  assert.equal(out.status, 'completed');
  assert.deepEqual(out.history, before, 'the earlier work is still there');
});

test('run loop: absent resumeFrom, a run starts from nothing exactly as before', async () => {
  const out = await runTask({ goal: 'g' }, {
    strategy: 'open-ended',
    tools: [],
    fleetApi: fleetSaying(done('fresh')),
  });
  assert.deepEqual(out.history, []);
});

// ---------------------------------------------------------------------------
// Replay safety
//
// Regression. A resumed run is seeded with the observations it already had, so
// the tool calls that raised earlier questions are NOT repeated. A queue
// replayed blindly by position therefore hands the next question the previous
// one's answer — which once turned an approval into a denial nobody gave.
// ---------------------------------------------------------------------------

test('replay: an answer that does not fit the question is not consumed', async () => {
  // The destination answer is queued; the questions being asked are about
  // pace. Consuming it would answer a question nobody was asked.
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-1', answers: { destination: 'geo-1' } }],
  });

  await assert.rejects(
    () => ask({ questions: [{ fieldId: 'pace', kind: 'pick_one', prompt: 'How fast?', options: [{ value: 'slow', label: 'Slow' }], required: true }] }),
    PauseRequested,
    'a mismatched answer must produce a fresh question, not a wrong one',
  );
});

test('replay: an approval is never satisfied by an answer to something else', async () => {
  // The sharpest form of the bug: `{ destination: ... }` has no `proceed`
  // field, so consuming it left `answers.proceed` undefined and the guardrail
  // read that as a denial.
  const g = createGuardrails({}, [], ran);
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-1', answers: { destination: 'geo-1' } }],
  });

  await assert.rejects(
    () => g.execute(irreversible(), { args: {}, askUser: ask }),
    (err) => {
      assert.ok(isPauseRequested(err), 'it asks again rather than inventing a decision');
      assert.equal(err.batch.questions[0].kind, 'approval');
      return true;
    },
  );
});

test('replay: a fitting answer is still consumed', async () => {
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-1', answers: { proceed: 'approve' } }],
  });
  const answer = await ask({ questions: oneQuestion });
  assert.equal(answer.replayed, true);
  assert.equal(isApproved(answer), true);
});

test('replay: an extra field in a replayed answer blocks it', async () => {
  // Unknown keys fail whole-set validation, and that is the right call here:
  // an answer carrying fields this question never asked about is an answer to
  // a different question.
  const ask = createAskUser({
    jobId: 'job-1',
    answered: [{ batchId: 'inp-1', answers: { proceed: 'approve', pace: 'slow' } }],
  });
  await assert.rejects(() => ask({ questions: oneQuestion }), PauseRequested);
});

test('replay: planResume queues only the answer to the batch it was parked on', async () => {
  const { planResume } = await import('../host/human-input/resume.mjs');

  const batch = createBatch({
    jobId: 'job-1', askedBy: 'guardrail', questions: oneQuestion, batchId: 'inp-3',
  });
  const history = [
    rec.answerReceivedEntry('job-1', { batchId: 'inp-1', answers: { destination: 'geo-1' }, answeredBy: 'p' }),
    rec.answerReceivedEntry('job-1', { batchId: 'inp-2', answers: { pace: 'slow' }, answeredBy: 'p' }),
  ];
  const record = {
    id: 'job-1',
    status: 'waiting_input',
    pendingInput: batch,
    // A snapshot with real observations: the earlier questions' effects are
    // already folded in, so their answers must not be replayed again.
    snapshot: {
      version: 1, jobId: 'job-1', interruptions: 2, plan: null, budget: null, identity: null,
      observations: [{ stepIndex: 0, result: 'done' }],
    },
  };

  const plan = planResume(record, { batchId: 'inp-3', answers: { proceed: 'approve' } }, { history });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.resumeFrom.answered, [{ batchId: 'inp-3', answers: { proceed: 'approve' } }]);
});

test('replay: even a cold rebuild queues only the parked answer', async () => {
  // Losing a snapshot may mean a tool re-runs and asks its question again.
  // That is annoying and safe. Replaying a queue positionally to avoid it is
  // neither - it answers questions with the wrong answers.
  const { planResume } = await import('../host/human-input/resume.mjs');

  const batch = createBatch({ jobId: 'job-1', askedBy: 'guardrail', questions: oneQuestion, batchId: 'inp-2' });
  const history = [
    rec.answerReceivedEntry('job-1', { batchId: 'inp-1', answers: { destination: 'geo-1' }, answeredBy: 'p' }),
  ];
  const record = { id: 'job-1', status: 'waiting_input', pendingInput: batch, snapshot: null };

  const plan = planResume(record, { batchId: 'inp-2', answers: { proceed: 'approve' } }, { history });
  assert.deepEqual(plan.resumeFrom.answered, [{ batchId: 'inp-2', answers: { proceed: 'approve' } }]);
});
