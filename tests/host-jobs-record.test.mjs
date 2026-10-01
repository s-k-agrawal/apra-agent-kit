// tests/host-jobs-record.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rec = await import('../host/jobs/record.mjs');
const iface = await import('../host/jobs/interface.mjs');

const NOW = new Date('2026-09-17T10:00:00.000Z');

test('createRecord produces the spec shape with queued status', () => {
  const r = rec.createRecord({ goal: 'g', inputs: { a: 1 } }, { id: 'job-1', callbackUrl: null, metadata: { p: 1 }, now: NOW });
  assert.equal(r.id, 'job-1');
  assert.equal(r.status, 'queued');
  assert.deepEqual(r.task, { goal: 'g', inputs: { a: 1 }, constraints: {}, budget: {} });
  assert.equal(r.submittedAt, NOW.toISOString());
  assert.equal(r.startedAt, null);
  assert.equal(r.finishedAt, null);
  assert.equal(r.attempts, 1);
  assert.equal(r.result, null);
  assert.deepEqual(r.history, []);
  assert.equal(r.budget, null);
  assert.deepEqual(r.progress, { iteration: 0, message: null, at: null });
  assert.equal(r.callbackUrl, null);
  assert.deepEqual(r.metadata, { p: 1 });
  assert.equal(r.error, null);
});

test('createRecord keeps strategy and workflow when present', () => {
  const r = rec.createRecord(
    { goal: 'g', workflow: 'city-briefing', inputs: { city: 'Tokyo' }, strategy: 'workflow' },
    { id: 'job-wf', now: NOW },
  );
  assert.deepEqual(r.task, {
    goal: 'g',
    inputs: { city: 'Tokyo' },
    constraints: {},
    budget: {},
    strategy: 'workflow',
    workflow: 'city-briefing',
  });
});

test('newJobId has the job- prefix and is unique', () => {
  const a = rec.newJobId(); const b = rec.newJobId();
  assert.match(a, /^job-[a-f0-9]{12}$/);
  assert.notEqual(a, b);
});

test('transitions follow the spec state machine', () => {
  assert.equal(rec.canTransition('queued', 'processing'), true);
  assert.equal(rec.canTransition('queued', 'cancelled'), true);
  assert.equal(rec.canTransition('queued', 'completed'), false);
  for (const t of ['completed', 'failed', 'cancelled', 'budget_exceeded']) {
    assert.equal(rec.canTransition('processing', t), true);
  }
  assert.equal(rec.canTransition('completed', 'processing'), false);
  assert.equal(rec.canTransition('cancelled', 'completed'), false);
  assert.throws(() => rec.assertTransition('completed', 'failed'), iface.IllegalTransitionError);
});

test('event constructors produce the spec shapes', () => {
  assert.deepEqual(rec.queuedEvent('j', 3, NOW), { type: 'queued', jobId: 'j', at: NOW.toISOString(), position: 3 });
  assert.deepEqual(rec.startedEvent('j', NOW), { type: 'started', jobId: 'j', at: NOW.toISOString() });
  assert.deepEqual(rec.progressEvent('j', 2, 'calling weather', NOW),
    { type: 'progress', jobId: 'j', at: NOW.toISOString(), iteration: 2, message: 'calling weather' });
  assert.deepEqual(rec.settledEvent('j', { status: 'completed', result: { x: 1 }, error: null }, NOW),
    { type: 'settled', jobId: 'j', at: NOW.toISOString(), status: 'completed', result: { x: 1 }, error: null });
});

test('ringEvents drops oldest progress events but keeps lifecycle events', () => {
  const events = [rec.queuedEvent('j', 1, NOW), rec.startedEvent('j', NOW)];
  for (let i = 1; i <= 60; i++) events.push(rec.progressEvent('j', i, `step ${i}`, NOW));
  events.push(rec.settledEvent('j', { status: 'completed', result: 1, error: null }, NOW));
  const out = rec.ringEvents(events, 50);
  assert.equal(out.length, 50);
  assert.equal(out[0].type, 'queued');
  assert.equal(out[1].type, 'started');
  assert.equal(out.at(-1).type, 'settled');
  assert.equal(out[2].iteration, 14); // 60 progress - 47 kept = first 13 dropped
});

test('settleFromRunResult maps run loop outcomes', () => {
  assert.deepEqual(
    rec.settleFromRunResult({ status: 'completed', result: 'ok', history: [1], budget: { iterations: 2 } }),
    { status: 'completed', result: 'ok', error: null, history: [1], budget: { iterations: 2 } });
  assert.deepEqual(
    rec.settleFromRunResult({ status: 'failed', result: { error: 'no_action', message: 'm' }, history: [], budget: null }),
    { status: 'failed', result: null, error: { code: 'run_failed', message: 'no_action: m' }, history: [], budget: null });
  assert.equal(rec.settleFromRunResult({ status: 'budget_exceeded', result: { budgetReason: 'max_iterations' }, history: [], budget: null }).status, 'budget_exceeded');
  assert.equal(rec.settleFromRunResult({ status: 'cancelled', result: null, history: [], budget: null }).status, 'cancelled');
});

test('validateCallbackUrl enforces https unless allowHttp', () => {
  assert.equal(iface.validateCallbackUrl('https://x.test/hook', { allowHttp: false }), 'https://x.test/hook');
  assert.throws(() => iface.validateCallbackUrl('http://x.test/hook', { allowHttp: false }), iface.InvalidCallbackUrlError);
  assert.equal(iface.validateCallbackUrl('http://x.test/hook', { allowHttp: true }), 'http://x.test/hook');
  assert.throws(() => iface.validateCallbackUrl('not a url', { allowHttp: true }), iface.InvalidCallbackUrlError);
  assert.equal(iface.validateCallbackUrl(undefined, { allowHttp: false }), null);
});

test('assertJobsBackend rejects incomplete objects', () => {
  assert.throws(() => iface.assertJobsBackend({ submit() {} }), /jobs backend missing/);
  const ok = { start() {}, stop() {}, submit() {}, get() {}, cancel() {}, subscribe() {}, events() {}, stats() {} };
  assert.doesNotThrow(() => iface.assertJobsBackend(ok));
});

test('a fresh record declares the pause pointer and no snapshot', () => {
  // The snapshot retired into host/checkpoint/. Leaving a dead `snapshot: null`
  // on the record is not harmless: planResume once read identity off
  // `record.snapshot`, which became permanently undefined, and the
  // authorization check passed for everyone as a result. A field nothing
  // writes should not be there to be read.
  const r = rec.createRecord({ jobId: 'job-1', goal: 'g' });
  assert.ok(!('snapshot' in r), 'no snapshot field on the record');

  // `pendingBatchId` is the pointer park() writes. It was set ad hoc without
  // ever being declared, so a fresh record and a parked one had different
  // shapes.
  assert.equal(r.pendingBatchId, null);
  assert.equal(r.pendingInput, null);
});
