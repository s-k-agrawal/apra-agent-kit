// tests/host-human-input-record.test.mjs
//
// The status model once `waiting_input` exists, and the history entries a
// paused run is rebuilt from.
//
// Existing record behaviour is covered by tests/host-jobs-record.test.mjs;
// this file covers only what durable human input adds, plus the invariants it
// must not break.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const rec = await import('../host/jobs/record.mjs');
const iface = await import('../host/jobs/store/interface.mjs');

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

test('status: waiting_input is a status but is NOT terminal', () => {
  // Every terminal check in the notifier, the SSE handler and the store purge
  // reads TERMINAL_STATUSES. A paused run must not look finished to any of them.
  assert.ok(rec.STATUSES.includes('waiting_input'));
  assert.equal(rec.TERMINAL_STATUSES.has('waiting_input'), false);
});

test('status: TERMINAL_STATUSES is unchanged', () => {
  assert.deepEqual(
    [...rec.TERMINAL_STATUSES].sort(),
    ['budget_exceeded', 'cancelled', 'completed', 'failed'],
  );
});

test('status: adding waiting_input did not mutate the shared terminal Set', () => {
  // TRANSITIONS.processing used to *be* TERMINAL_STATUSES. If it still were,
  // adding waiting_input to it would have made a paused run terminal everywhere.
  assert.equal(rec.canTransition('processing', 'waiting_input'), true);
  assert.equal(rec.TERMINAL_STATUSES.has('waiting_input'), false);
});

test('status: processing may pause, and every old transition still holds', () => {
  assert.equal(rec.canTransition('processing', 'waiting_input'), true);
  for (const t of rec.TERMINAL_STATUSES) {
    assert.equal(rec.canTransition('processing', t), true, `processing -> ${t}`);
  }
  assert.equal(rec.canTransition('queued', 'processing'), true);
  assert.equal(rec.canTransition('queued', 'cancelled'), true);
  assert.equal(rec.canTransition('queued', 'completed'), false);
});

test('status: waiting_input resumes, cancels, or expires into failed', () => {
  assert.equal(rec.canTransition('waiting_input', 'processing'), true, 'an answer resumes it');
  assert.equal(rec.canTransition('waiting_input', 'cancelled'), true, 'cancel while waiting is free');
  // The expiry sweep settles an unanswered batch without a worker ever picking
  // the job back up, so `failed` has to be reachable directly.
  assert.equal(rec.canTransition('waiting_input', 'failed'), true);
});

test('status: a paused run cannot jump straight to completed', () => {
  // Completing from `waiting_input` would mean finishing work that is still
  // blocked on an answer nobody gave.
  assert.equal(rec.canTransition('waiting_input', 'completed'), false);
  assert.equal(rec.canTransition('waiting_input', 'budget_exceeded'), false);
  assert.throws(() => rec.assertTransition('waiting_input', 'completed'), iface.IllegalTransitionError);
});

test('status: you cannot pause a job that never started', () => {
  assert.equal(rec.canTransition('queued', 'waiting_input'), false);
  for (const t of rec.TERMINAL_STATUSES) {
    assert.equal(rec.canTransition(t, 'waiting_input'), false, `${t} -> waiting_input`);
  }
});

// ---------------------------------------------------------------------------
// Record fields
// ---------------------------------------------------------------------------

test('record: a new record carries pendingInput and snapshot, both null', () => {
  const r = rec.createRecord({ goal: 'go' });
  assert.equal(r.pendingInput, null);
  assert.equal(r.snapshot, null);
  assert.equal(r.status, 'queued');
});

// ---------------------------------------------------------------------------
// Notification events
// ---------------------------------------------------------------------------

const batch = {
  batchId: 'inp-a3f19c284d61',
  jobId: 'job-1',
  askedBy: 'guardrail',
  askedByDetail: null,
  questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?' }],
  askedAt: '2026-09-24T09:14:22.104Z',
  staleAfter: '2026-09-25T09:14:22.104Z',
  expiresAt: '2026-10-01T09:14:22.104Z',
};

test('events: input_required carries what a client needs to render the form', () => {
  const e = rec.inputRequiredEvent('job-1', batch, new Date('2026-09-24T09:14:22.104Z'));
  assert.deepEqual(e, {
    type: 'input_required',
    jobId: 'job-1',
    at: '2026-09-24T09:14:22.104Z',
    batchId: batch.batchId,
    questions: batch.questions,
    askedBy: 'guardrail',
    staleAfter: batch.staleAfter,
    expiresAt: batch.expiresAt,
  });
});

test('events: input_resolved names which of the three ways it ended', () => {
  assert.deepEqual(rec.INPUT_RESOLUTIONS, ['answered', 'timeout', 'cancelled']);
  for (const resolution of rec.INPUT_RESOLUTIONS) {
    const e = rec.inputResolvedEvent('job-1', { batchId: batch.batchId, resolution });
    assert.equal(e.type, 'input_resolved');
    assert.equal(e.resolution, resolution);
    assert.equal(e.batchId, batch.batchId);
  }
});

// ---------------------------------------------------------------------------
// History entries
// ---------------------------------------------------------------------------

const at = new Date('2026-09-24T09:14:22.104Z');

test('history: every declared type has a builder that stamps type, jobId and at', () => {
  const built = [
    rec.runStartedEntry('j', { task: { goal: 'g' }, traceId: 't' }, at),
    rec.plannedEntry('j', { plan: [] }, at),
    rec.stepStartedEntry('j', { stepIndex: 0, stepType: 'tool' }, at),
    rec.stepCompletedEntry('j', { stepIndex: 0, result: 'ok', reversible: true }, at),
    rec.stepFailedEntry('j', { stepIndex: 0, error: { code: 'boom' } }, at),
    rec.questionAskedEntry('j', { batch }, at),
    rec.answerReceivedEntry('j', { batchId: batch.batchId, answers: {}, answeredBy: 'p' }, at),
    rec.questionExpiredEntry('j', { batchId: batch.batchId }, at),
    rec.reversalPlannedEntry('j', { batchId: batch.batchId, steps: [], undoable: [], notUndoable: [] }, at),
    rec.reversalStepEntry('j', { stepIndex: 0, outcome: 'undone' }, at),
    rec.reversalFinishedEntry('j', { undone: 1, failed: 0, skipped: 0 }, at),
    rec.runSettledEntry('j', { status: 'completed', result: 'done' }, at),
  ];

  assert.deepEqual(built.map(e => e.type), rec.HISTORY_TYPES);
  for (const e of built) {
    assert.equal(e.jobId, 'j');
    assert.equal(e.at, at.toISOString());
  }
});

test('history: seq is not assigned by the builders - the store owns ordering', () => {
  const e = rec.runStartedEntry('j', { task: {}, traceId: 't' }, at);
  assert.equal('seq' in e, false);
});

test('history: planned records which batch caused a revision', () => {
  const fresh = rec.plannedEntry('j', { plan: ['a'] }, at);
  assert.equal(fresh.replanOf, null);

  const revised = rec.plannedEntry('j', { plan: ['b'], replanOf: batch.batchId }, at);
  assert.equal(revised.replanOf, batch.batchId, 'a plan change traces to the question that prompted it');
});

test('history: step_completed captures undo at execution time', () => {
  // The arguments needed to reverse a step are often derivable only from its
  // result, which is gone by the time a reversal runs.
  const e = rec.stepCompletedEntry('j', {
    stepIndex: 2,
    result: { bookingRef: 'BR-991' },
    reversible: false,
    undo: { tool: 'cancel-booking', args: { ref: 'BR-991' } },
  }, at);
  assert.deepEqual(e.undo, { tool: 'cancel-booking', args: { ref: 'BR-991' } });
  assert.equal(e.reversible, false);
});

test('history: question_asked stores the batch whole', () => {
  // A question rendered to a person and then lost is an audit gap - nobody can
  // later say what they were actually agreeing to.
  const e = rec.questionAskedEntry('j', { batch }, at);
  assert.deepEqual(e.batch, batch);
  assert.deepEqual(e.batch.questions, batch.questions);
});

test('history: ringEvents is not applied to history entries', () => {
  // ringEvents exists for the size-capped Azure customStatus view. It drops
  // `progress` events; history has no such type, so running it over history
  // would be a no-op that silently becomes lossy the day a type is renamed.
  // The guard is that history is never passed through it - asserted here by
  // showing 200 history entries survive a call that would trim live events.
  const history = Array.from({ length: 200 }, (_, i) =>
    rec.stepCompletedEntry('j', { stepIndex: i, result: i, reversible: true }, at));

  assert.equal(rec.ringEvents(history, 50).length, 200,
    'no history type is ring-buffered; the cap only ever drops `progress`');

  const live = Array.from({ length: 200 }, (_, i) => rec.progressEvent('j', i, 'tick'));
  assert.ok(rec.ringEvents(live, 50).length < 200, 'live progress events are still capped');
});
