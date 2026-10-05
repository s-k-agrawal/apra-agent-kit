// tests/comm-azure-activity-retry.test.mjs
//
// Retrying the step activity, and auditing what went wrong when it did.
//
// A workflow route runs to completion inside ONE activity — `maxSteps` reaches
// `runTask` and never reaches `executeWorkflow` (tasks.mjs:309-317) — so there
// is no checkpoint between its phases. A worker recycle, deploy, scale-in or
// OOM mid-workflow therefore loses the whole thing, and without a retry policy
// nothing tries again.
//
// Durable's own `callActivityWithRetry` cannot help here: it retries on a
// *thrown* exception, and the activity deliberately catches and returns a
// failed envelope instead so the orchestrator can settle cleanly. The retry
// therefore lives in the orchestrator, over the returned envelope — which has
// the side benefit that the orchestrator knows the attempt number and can hand
// it to the activity.
//
// Default is 1 attempt: no retry, same behaviour as before. What is new even at
// 1 is that a failure is recorded with enough detail to audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator, ADVANCE_NAME } = await import('../comm/azure-functions/orchestrator.mjs');
const { resolveDispatchConfig } = await import('../host/jobs/config.mjs');
const { buildFailureAudit } = await import('../comm/azure-functions/advance.mjs');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('retry defaults to a single attempt — no retry unless asked for', () => {
  const cfg = resolveDispatchConfig({ backend: 'durable' }, { env: {} });
  assert.equal(cfg.durable.activityRetry.maxAttempts, 1);
});

test('the attempt count is configurable', () => {
  const cfg = resolveDispatchConfig(
    { backend: 'durable', durable: { activityRetry: { maxAttempts: 3 } } },
    { env: {} },
  );
  assert.equal(cfg.durable.activityRetry.maxAttempts, 3);
});

test('an attempt count below one is refused rather than silently floored', () => {
  // 0 would mean "never run the activity", which is not a retry policy.
  assert.throws(
    () => resolveDispatchConfig({ backend: 'durable', durable: { activityRetry: { maxAttempts: 0 } } }, { env: {} }),
    /maxAttempts/,
  );
});

test('the environment can override it', () => {
  const cfg = resolveDispatchConfig({ backend: 'durable' }, { env: { DURABLE_ACTIVITY_MAX_ATTEMPTS: '4' } });
  assert.equal(cfg.durable.activityRetry.maxAttempts, 4);
});

// ---------------------------------------------------------------------------
// The orchestrator's retry loop
// ---------------------------------------------------------------------------

/** Drives the generator, scripting one activity result per call. */
function drive(results, opts = {}) {
  const calls = [];
  const statuses = [];
  const ctx = {
    df: {
      instanceId: 'job-1',
      currentUtcDateTime: new Date('2026-10-05T09:00:00Z'),
      getInput: () => ({ task: { goal: 'g' } }),
      setCustomStatus: (s) => statuses.push(structuredClone(s)),
      callActivity: (name, input) => { calls.push({ name, input }); return { __t: 'activity' }; },
      callEntity: () => ({ __t: 'entity' }),
      createTimer: () => ({ __t: 'timer' }),
      EntityId: function EntityId(name, key) { return { name, key }; },
    },
  };
  const gen = buildOrchestrator(opts)(ctx);
  let step = gen.next();
  let i = 0;
  let guard = 0;
  while (!step.done) {
    step = gen.next(step.value?.__t === 'activity' ? results[i++] : undefined);
    if ((guard += 1) > 400) throw new Error('did not terminate');
  }
  return { calls, statuses, output: step.value };
}

const failed = (over = {}) => ({
  status: 'failed', done: true, delta: null, cleared: false,
  error: { code: 'advance_failed', message: 'boom' }, ...over,
});
const ok = () => ({ status: 'completed', done: true, delta: null, cleared: true, result: 'r' });

test('by default a failure is not retried', () => {
  const { calls, output } = drive([failed()], { activityRetry: { maxAttempts: 1 } });
  assert.equal(calls.filter(c => c.name === ADVANCE_NAME).length, 1);
  assert.equal(output.status, 'failed');
});

test('with three attempts a failing step is tried three times', () => {
  const { calls, output } = drive([failed(), failed(), failed()], { activityRetry: { maxAttempts: 3 } });
  assert.equal(calls.filter(c => c.name === ADVANCE_NAME).length, 3);
  assert.equal(output.status, 'failed');
});

test('a retry that succeeds stops retrying', () => {
  const { calls, output } = drive([failed(), ok()], { activityRetry: { maxAttempts: 3 } });
  assert.equal(calls.filter(c => c.name === ADVANCE_NAME).length, 2, 'it stopped as soon as it worked');
  assert.equal(output.status, 'completed');
});

test('the activity is told which attempt it is on, and how many there are', () => {
  // So the audit record can say "2 of 3" rather than just "it failed".
  const { calls } = drive([failed(), failed()], { activityRetry: { maxAttempts: 2 } });
  const advances = calls.filter(c => c.name === ADVANCE_NAME);
  assert.deepEqual(advances.map(c => c.input.attempt), [1, 2]);
  assert.equal(advances[0].input.maxAttempts, 2);
});

test('a paused run is never retried', () => {
  // A pause is not a failure. Retrying it would ask the person twice.
  const paused = { status: 'paused', done: true, delta: null, cleared: false, batchId: 'inp-1', batch: { batchId: 'inp-1', questions: [] } };
  const { calls } = drive([paused], { activityRetry: { maxAttempts: 3 } });
  assert.equal(calls.filter(c => c.name === ADVANCE_NAME).length, 1);
});

test('a cancelled run is never retried', () => {
  const cancelled = { status: 'cancelled', done: true, delta: null, cleared: true, result: null };
  const { calls } = drive([cancelled], { activityRetry: { maxAttempts: 3 } });
  assert.equal(calls.filter(c => c.name === ADVANCE_NAME).length, 1);
});

test('each attempt is recorded for audit, not just the last', () => {
  // The whole point of the default of 1: even with no retry, the failure is
  // now on the record with enough detail to chase.
  const { statuses } = drive([failed(), failed()], { activityRetry: { maxAttempts: 2 } });
  const attempts = statuses.at(-1).events.filter(e => e.type === 'activity_failed');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(e => e.attempt), [1, 2]);
  assert.equal(attempts[0].willRetry, true, 'the first says another is coming');
  assert.equal(attempts[1].willRetry, false, 'the last says it is giving up');
});

// ---------------------------------------------------------------------------
// The audit record itself
// ---------------------------------------------------------------------------

test('the audit captures what somebody would need to chase the failure', () => {
  const err = new Error('socket hang up');
  err.name = 'FetchError';
  const audit = buildFailureAudit({
    jobId: 'job-9', attempt: 2, maxAttempts: 3, startedAt: Date.now() - 1500, err,
    logs: ['phase: weather', 'phase: timezone'],
  });

  assert.equal(audit.jobId, 'job-9');
  assert.equal(audit.attempt, 2);
  assert.equal(audit.maxAttempts, 3);
  assert.equal(audit.errorName, 'FetchError');
  assert.match(audit.message, /socket hang up/);
  assert.ok(audit.durationMs >= 1000, 'how long it ran before dying');
  assert.ok(Array.isArray(audit.logs) && audit.logs.length === 2, 'what it had got through');
  assert.ok(audit.stack, 'and where');
});

test('the audit carries no credential, whatever the error said', () => {
  // An error message is arbitrary text from arbitrary code. It reaches a log
  // and a job record, both of which outlive the run.
  const err = new Error('auth failed for token=sk-live-SECRET');
  const audit = buildFailureAudit({
    jobId: 'j', attempt: 1, maxAttempts: 1, startedAt: Date.now(), err,
    logs: ['Authorization: Bearer sk-live-SECRET'],
  });
  assert.equal(JSON.stringify(audit).includes('sk-live-SECRET'), false);
});

test('the audit is bounded, so a huge stack cannot blow the payload', () => {
  const err = new Error('x'.repeat(50_000));
  err.stack = 'y'.repeat(100_000);
  const audit = buildFailureAudit({ jobId: 'j', attempt: 1, maxAttempts: 1, startedAt: Date.now(), err, logs: [] });
  assert.ok(JSON.stringify(audit).length < 4_000, `audit was ${JSON.stringify(audit).length} characters`);
});

test('an error with nothing useful on it still produces a record', () => {
  const audit = buildFailureAudit({ jobId: 'j', attempt: 1, maxAttempts: 1, startedAt: Date.now(), err: 'just a string', logs: null });
  assert.equal(audit.jobId, 'j');
  assert.ok(audit.message);
  assert.deepEqual(audit.logs, []);
});
