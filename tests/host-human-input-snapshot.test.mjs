// tests/host-human-input-snapshot.test.mjs
//
// The snapshot is a cache. The tests that matter are the ones that prove it:
// delete it, rebuild from history, and require the same answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  SNAPSHOT_VERSION, capture, restore, rebuildFromHistory, resumeState, scrub,
} = await import('../host/human-input/snapshot.mjs');

const rec = await import('../host/jobs/record.mjs');

const at = (s) => new Date(s);

// A run that: started, planned three steps, did two, then asked a question.
function historyOfAPausedRun(batch) {
  return [
    rec.runStartedEntry('job-1', { task: { goal: 'Plan a trip' }, traceId: 'trace-9' }, at('2026-09-24T09:00:00Z')),
    rec.plannedEntry('job-1', { plan: ['search', 'price', 'book'] }, at('2026-09-24T09:00:01Z')),
    rec.stepStartedEntry('job-1', { stepIndex: 0, stepType: 'tool', tool: 'search' }, at('2026-09-24T09:00:02Z')),
    rec.stepCompletedEntry('job-1', { stepIndex: 0, result: { hits: 4 }, reversible: true }, at('2026-09-24T09:00:03Z')),
    rec.stepStartedEntry('job-1', { stepIndex: 1, stepType: 'tool', tool: 'price' }, at('2026-09-24T09:00:04Z')),
    rec.stepCompletedEntry('job-1', { stepIndex: 1, result: { total: 412 }, reversible: true }, at('2026-09-24T09:00:05Z')),
    rec.questionAskedEntry('job-1', { batch }, at('2026-09-24T09:00:06Z')),
  ];
}

const aBatch = (batchId = 'inp-a3f19c284d61') => ({
  batchId,
  jobId: 'job-1',
  askedBy: 'guardrail',
  questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' }],
  askedAt: '2026-09-24T09:00:06.000Z',
  staleAfter: '2026-09-25T09:00:06.000Z',
  expiresAt: '2026-10-01T09:00:06.000Z',
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('snapshot: a captured snapshot restores unchanged', () => {
  const snap = capture({
    jobId: 'job-1',
    traceId: 'trace-9',
    kitVersion: '0.1.0',
    task: { goal: 'Plan a trip' },
    conversation: [{ role: 'user', content: 'Paris in October' }],
    plan: { steps: ['search', 'price', 'book'], cursor: 2 },
    observations: [{ stepIndex: 0, result: { hits: 4 } }],
    budget: { iterations: 3, elapsedMs: 1200 },
    interruptions: 1,
    identity: { personId: 'person-6f2a' },
    pendingBatchId: 'inp-a3f19c284d61',
    writtenAt: at('2026-09-24T09:00:06Z'),
  });

  const out = restore(snap);
  assert.equal(out.ok, true);
  assert.deepEqual(out.snapshot, snap);
  assert.equal(out.snapshot.version, SNAPSHOT_VERSION);
});

test('snapshot: it survives JSON, because that is how it is stored', () => {
  const snap = capture({ jobId: 'job-1', task: { goal: 'g' }, plan: { steps: ['a'], cursor: 1 } });
  const out = restore(JSON.parse(JSON.stringify(snap)));
  assert.equal(out.ok, true);
  assert.deepEqual(out.snapshot, snap);
});

test('snapshot: interruptions persists - otherwise maxInterruptions never trips', () => {
  // A run that resumes with interruptions reset to 0 can ask forever, one
  // question per resume, and the limit is decorative.
  const snap = capture({ jobId: 'job-1', task: {}, interruptions: 7 });
  assert.equal(restore(snap).snapshot.interruptions, 7);
});

// ---------------------------------------------------------------------------
// Refusing rather than guessing
// ---------------------------------------------------------------------------

test('snapshot: an incompatible version is refused, not coerced', () => {
  // A different build may have meant something different by the same field
  // name. Resuming on a misread plan cursor re-executes work that already ran.
  const res = restore({ version: 99, jobId: 'job-1' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'incompatible_version');
  assert.deepEqual(res.detail, { found: 99, expected: SNAPSHOT_VERSION });
});

test('snapshot: absent and unreadable are distinguishable', () => {
  assert.equal(restore(null).reason, 'absent');
  assert.equal(restore(undefined).reason, 'absent');
  assert.equal(restore('not a snapshot').reason, 'unreadable');
  assert.equal(restore([]).reason, 'unreadable');
  assert.equal(restore({ version: SNAPSHOT_VERSION }).reason, 'unreadable');
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test('snapshot: identity records who, never the bearer that proves it', () => {
  const snap = capture({
    jobId: 'job-1',
    task: {},
    identity: { personId: 'person-6f2a', tenantId: 't-1', accessToken: 'eyJhbGciOi...', cookie: 'sid=abc' },
  });
  assert.deepEqual(snap.identity, { personId: 'person-6f2a', tenantId: 't-1' });
});

test('snapshot: credential-shaped keys are stripped at every depth', () => {
  // conversation and observations carry whatever the strategies put there,
  // which we do not control, and this sits in storage for a week.
  const snap = capture({
    jobId: 'job-1',
    task: { goal: 'g', inputs: { apiKey: 'sk-live-1', city: 'Paris' } },
    conversation: [{ role: 'system', headers: { Authorization: 'Bearer abc' }, content: 'hi' }],
    observations: [{ result: { nested: { refresh_token: 'rt-1', ok: true } } }],
  });

  const serialised = JSON.stringify(snap);
  for (const leak of ['sk-live-1', 'Bearer abc', 'rt-1']) {
    assert.equal(serialised.includes(leak), false, `leaked: ${leak}`);
  }
  // Everything that is not a credential survives.
  assert.equal(snap.task.inputs.city, 'Paris');
  assert.equal(snap.conversation[0].content, 'hi');
  assert.equal(snap.observations[0].result.nested.ok, true);
});

test('snapshot: scrub handles a cycle rather than throwing', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.deepEqual(scrub(a), { name: 'a', self: null });
});

// ---------------------------------------------------------------------------
// The rebuild rule - the point of the whole file
// ---------------------------------------------------------------------------

test('rebuild: deleting the snapshot gives an identical resume', () => {
  const batch = aBatch();
  const history = historyOfAPausedRun(batch);
  const writtenAt = at('2026-09-24T09:00:06Z');

  const fromHistory = rebuildFromHistory(history, { jobId: 'job-1', writtenAt, now: writtenAt });

  // What a pause would have written at that moment.
  const fromSnapshot = capture({
    jobId: 'job-1',
    traceId: 'trace-9',
    task: { goal: 'Plan a trip' },
    conversation: [{ role: 'assistant', kind: 'question', batch }],
    plan: { steps: ['search', 'price', 'book'], cursor: 2 },
    observations: [
      { stepIndex: 0, result: { hits: 4 }, reversible: true },
      { stepIndex: 1, result: { total: 412 }, reversible: true },
    ],
    interruptions: 1,
    pendingBatchId: batch.batchId,
    writtenAt,
  });

  assert.deepEqual(fromHistory, fromSnapshot);
});

test('rebuild: the cursor sits after the last completed step - work is never redone', () => {
  const history = historyOfAPausedRun(aBatch());
  const state = rebuildFromHistory(history, { jobId: 'job-1' });
  assert.equal(state.plan.cursor, 2, 'steps 0 and 1 are done; the next work is step 2');
});

test('rebuild: an answer clears the pending batch and becomes an observation', () => {
  const batch = aBatch();
  const history = [
    ...historyOfAPausedRun(batch),
    rec.answerReceivedEntry('job-1', {
      batchId: batch.batchId, answers: { proceed: 'approve' }, answeredBy: 'person-6f2a',
    }, at('2026-09-24T10:00:00Z')),
  ];

  const state = rebuildFromHistory(history, { jobId: 'job-1' });
  assert.equal(state.pendingBatchId, null);
  assert.deepEqual(
    state.observations.at(-1),
    { kind: 'answer', batchId: batch.batchId, answers: { proceed: 'approve' } },
  );
  assert.equal(state.interruptions, 1, 'the interruption still counts once answered');
});

test('rebuild: interruptions counts batches, not questions', () => {
  // Ten fields in one form is one stop; two forms of one field each is two.
  const history = [
    rec.runStartedEntry('job-1', { task: {}, traceId: 't' }),
    rec.questionAskedEntry('job-1', {
      batch: { ...aBatch('inp-1'), questions: [{ fieldId: 'a' }, { fieldId: 'b' }, { fieldId: 'c' }] },
    }),
    rec.answerReceivedEntry('job-1', { batchId: 'inp-1', answers: {}, answeredBy: 'p' }),
    rec.questionAskedEntry('job-1', { batch: aBatch('inp-2') }),
  ];
  assert.equal(rebuildFromHistory(history, { jobId: 'job-1' }).interruptions, 2);
});

test('rebuild: a replan replaces the plan and the cursor follows the real work', () => {
  const history = [
    rec.runStartedEntry('job-1', { task: { goal: 'g' }, traceId: 't' }),
    rec.plannedEntry('job-1', { plan: ['a', 'b', 'c'] }),
    rec.stepCompletedEntry('job-1', { stepIndex: 0, result: 1, reversible: true }),
    rec.questionAskedEntry('job-1', { batch: aBatch() }),
    rec.answerReceivedEntry('job-1', { batchId: aBatch().batchId, answers: {}, answeredBy: 'p' }),
    rec.plannedEntry('job-1', { plan: ['x', 'y'], replanOf: aBatch().batchId }),
  ];
  const state = rebuildFromHistory(history, { jobId: 'job-1' });
  assert.deepEqual(state.plan.steps, ['x', 'y'], 'the revised plan wins outright');
  assert.equal(state.plan.cursor, 0, 'the new steps are new work');
});

test('rebuild: an undone step stops being something the run believes it holds', () => {
  const history = [
    rec.runStartedEntry('job-1', { task: {}, traceId: 't' }),
    rec.plannedEntry('job-1', { plan: ['search', 'book'] }),
    rec.stepCompletedEntry('job-1', { stepIndex: 0, result: { hits: 4 }, reversible: true }),
    rec.stepCompletedEntry('job-1', { stepIndex: 1, result: { bookingRef: 'BR-991' }, reversible: false }),
    rec.reversalStepEntry('job-1', { stepIndex: 1, outcome: 'undone' }),
  ];
  const state = rebuildFromHistory(history, { jobId: 'job-1' });

  assert.equal(state.observations.some(o => o.stepIndex === 1 && o.result), false,
    'a cancelled booking must not resume as a held one');
  assert.equal(state.plan.cursor, 1, 'step 1 is work to do again, or not at all');
  assert.equal(state.observations.some(o => o.stepIndex === 0), true, 'step 0 is untouched');
});

test('rebuild: a failed reversal leaves the step recorded as done', () => {
  // The booking is still live. Pretending otherwise is worse than admitting it.
  const history = [
    rec.runStartedEntry('job-1', { task: {}, traceId: 't' }),
    rec.plannedEntry('job-1', { plan: ['book'] }),
    rec.stepCompletedEntry('job-1', { stepIndex: 0, result: { bookingRef: 'BR-991' }, reversible: false }),
    rec.reversalStepEntry('job-1', { stepIndex: 0, outcome: 'failed', error: { code: 'upstream_down' } }),
  ];
  const state = rebuildFromHistory(history, { jobId: 'job-1' });
  assert.equal(state.observations.some(o => o.stepIndex === 0 && o.result), true);
  assert.equal(state.plan.cursor, 1);
});

test('rebuild: an expired question resolves the pending batch as unanswered', () => {
  const batch = aBatch();
  const history = [
    ...historyOfAPausedRun(batch),
    rec.questionExpiredEntry('job-1', { batchId: batch.batchId }),
  ];
  const state = rebuildFromHistory(history, { jobId: 'job-1' });
  assert.equal(state.pendingBatchId, null);
  assert.deepEqual(state.observations.at(-1), { kind: 'answer_expired', batchId: batch.batchId });
});

test('rebuild: a rebuilt snapshot is itself restorable', () => {
  const state = rebuildFromHistory(historyOfAPausedRun(aBatch()), { jobId: 'job-1' });
  assert.equal(restore(state).ok, true);
});

// ---------------------------------------------------------------------------
// resumeState - which of the two a caller actually got
// ---------------------------------------------------------------------------

test('resumeState: a usable snapshot is used, and says so', () => {
  const snap = capture({ jobId: 'job-1', task: { goal: 'g' }, interruptions: 3 });
  const out = resumeState({ id: 'job-1', snapshot: snap }, []);
  assert.equal(out.source, 'snapshot');
  assert.equal(out.state.interruptions, 3);
});

test('resumeState: a missing or stale snapshot falls back to history, with a reason', () => {
  const history = historyOfAPausedRun(aBatch());

  const missing = resumeState({ id: 'job-1', snapshot: null }, history);
  assert.equal(missing.source, 'history');
  assert.equal(missing.reason, 'absent');
  assert.equal(missing.state.plan.cursor, 2);

  // A rebuild is worth logging: it means a snapshot was lost.
  const stale = resumeState({ id: 'job-1', snapshot: { version: 0, jobId: 'job-1' } }, history);
  assert.equal(stale.source, 'history');
  assert.equal(stale.reason, 'incompatible_version');
  assert.deepEqual(stale.state.plan.steps, ['search', 'price', 'book']);
});
