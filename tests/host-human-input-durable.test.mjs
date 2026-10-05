// tests/host-human-input-durable.test.mjs
//
// Pausing and resuming through the task hub.
//
// The crux of the Azure design: **we do not resume an orchestration, we start
// another one.** The orchestration completes at the pause, its output carries
// the state, and answering starts a fresh one seeded with it. No
// `waitForExternalEvent`, no `Task.any`, no growing replay history, nothing
// billed while a person thinks — and the replay bug documented in
// orchestrator.mjs cannot come back, because the generator still yields once.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');
const { isLivePausedInstance, purgeStaleOrchestrations } = await import('../comm/azure-functions/index.mjs');
const { createDurableJobs, mapDurableStatus, ORCHESTRATOR_NAME } = await import('../host/jobs/durable.mjs');

const DAY = 86_400_000;
const NOW = new Date('2026-09-28T00:00:00.000Z');
const ahead = (ms) => new Date(NOW.getTime() + ms).toISOString();
const behind = (ms) => new Date(NOW.getTime() - ms).toISOString();

const aBatch = (over = {}) => ({
  batchId: 'inp-a3f19c284d61',
  jobId: 'job-1',
  askedBy: 'guardrail',
  askedByDetail: 'book',
  questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?', required: true }],
  askedAt: behind(1000),
  staleAfter: ahead(DAY),
  expiresAt: ahead(7 * DAY),
  ...over,
});

// The output is a pointer now: the state lives in the memory store.
// What `advance` returns for a run that parked. `done` ends the loop; a paused
// run keeps its checkpoint, so it is not cleared.
const pausedOutput = (over = {}) => ({
  status: 'paused',
  done: true,
  cleared: false,
  delta: null,
  batchId: aBatch().batchId,
  batch: aBatch(),
  checkpointKey: 'cp-job-1',
  asked: [{ type: 'question_asked', jobId: 'job-1', batch: aBatch() }],
  ...over,
});

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

function runOrchestrator(activityOutput) {
  const customStatuses = [];
  const scheduled = [];
  const context = {
    df: {
      instanceId: 'job-1',
      currentUtcDateTime: NOW,
      getInput: () => ({ task: { goal: 'g' } }),
      setCustomStatus: (s) => customStatuses.push(structuredClone(s)),
      callActivity: (name, input) => { scheduled.push({ name, input }); return { __activity: true }; },
      // The orchestrator commits each step's delta before the next one runs.
      callEntity: () => ({ __entity: true }),
      EntityId: function EntityId(name, key) { return { name, key }; },
    },
  };

  const gen = buildOrchestrator()(context);
  let step = gen.next();
  assert.equal(step.done, false, 'the orchestrator yields before it does anything');
  let guard = 0;
  while (!step.done) {
    step = gen.next(step.value?.__activity ? activityOutput : undefined);
    if ((guard += 1) > 200) throw new Error('orchestrator did not terminate');
  }

  return { done: step.done, output: step.value, customStatuses, scheduled, gen };
}

test('orchestrator: a pause completes the orchestration rather than waiting', async () => {
  const { done, output, scheduled } = runOrchestrator(pausedOutput());
  assert.equal(done, true, 'it returns; it does not park on an external event');
  assert.equal(output.status, 'paused');
  assert.equal(scheduled.length, 1, 'exactly one activity was ever scheduled');
});

test('orchestrator: one activity per step, and a replay schedules no more', async () => {
  // The old for(;;) loop consumed waitForExternalEvent('progress'), and each
  // replay shifted the SDK's event-ID counter so callActivity scheduled a NEW
  // activity every replay. N progress events -> N+1 activities -> pool
  // exhaustion.
  //
  // The orchestrator drives the run loop now, so "exactly one yield" is no
  // longer the property. The property that matters is unchanged: what it
  // schedules depends only on history, so a replay schedules exactly the same.
  const first = runOrchestrator(pausedOutput());
  assert.equal(first.scheduled.length, 1, 'a run that pauses on its first step runs one activity');
  assert.equal(first.gen.next().done, true, 'nothing further is yielded after the return');

  const second = runOrchestrator(pausedOutput());
  assert.deepEqual(second.scheduled.map(x => x.name), first.scheduled.map(x => x.name));
});

test('orchestrator: the output carries a pointer to where the state is', async () => {
  // It used to carry the state itself, which is why a long run could not pause
  // at all — Durable caps the output at 16KB. The state is in the memory store
  // now and this is the key to it.
  const { output } = runOrchestrator(pausedOutput());
  assert.equal(output.checkpointKey, 'cp-job-1');
  assert.equal(output.snapshot, undefined, 'no state in the output');
  assert.equal(output.batch.questions[0].fieldId, 'proceed');
});

test('orchestrator: customStatus carries a small marker, not the state', async () => {
  // customStatus has a hard size limit and is a live view, never a source of
  // truth. Putting the snapshot there is how you lose it.
  const { customStatuses } = runOrchestrator(pausedOutput());
  const last = customStatuses.at(-1);

  assert.equal(last.status, 'waiting_input');
  assert.equal(last.pendingInput.batchId, aBatch().batchId);
  assert.equal(last.pendingInput.expiresAt, aBatch().expiresAt);
  assert.equal('snapshot' in last, false, 'the snapshot must not be in customStatus');
  assert.equal('questions' in last.pendingInput, false, 'nor the questions');
});

test('orchestrator: a paused run is not given a finishedAt', async () => {
  const { customStatuses } = runOrchestrator(pausedOutput());
  assert.equal(customStatuses.at(-1).finishedAt, null, 'it is completed, but it has not finished');
});

test('orchestrator: input_required is pushed as an event for a watching client', async () => {
  const { customStatuses } = runOrchestrator(pausedOutput());
  const event = customStatuses.at(-1).events.find(e => e.type === 'input_required');
  assert.ok(event);
  assert.equal(event.batchId, aBatch().batchId);
  assert.equal(event.questions.length, 1);
});

test('orchestrator: an oversized paused output still fails loudly', async () => {
  // The state moved to the memory store, so this is now an assertion rather
  // than a path: if it fires, something is writing state into the output
  // again, and failing beats truncating a pointer into nonsense.
  // The paused output is constructed from named fields now, so a stray one
  // cannot bloat it. If state comes back it arrives inside the batch, which is
  // the field that does travel — so that is where the guard has to still bite.
  const huge = pausedOutput({
    batch: { ...aBatch(), questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'x'.repeat(20_000) }] },
  });
  const { output } = runOrchestrator(huge);

  assert.equal(output.status, 'failed');
  assert.equal(output.error.code, 'pause_too_large');
  assert.match(output.error.message, /pointer, not state/);
});

test('orchestrator: a normal settle is unchanged', async () => {
  const { output, customStatuses } = runOrchestrator({ status: 'completed', done: true, cleared: true, delta: null, result: 'done' });
  assert.equal(output.status, 'completed');
  assert.equal(customStatuses.at(-1).status, 'completed');
  assert.ok(customStatuses.at(-1).finishedAt);
  assert.ok(customStatuses.at(-1).events.some(e => e.type === 'settled'));
});

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

test('map: a Completed instance whose output is paused reads as waiting_input', async () => {
  // A paused run *is* a Completed orchestration. Believing the runtime status
  // alone reports it as finished.
  const record = mapDurableStatus({
    instanceId: 'job-1',
    runtimeStatus: 'Completed',
    output: pausedOutput(),
    customStatus: { status: 'waiting_input' },
    input: { record: { id: 'job-1', task: { goal: 'g' } } },
  });

  assert.equal(record.status, 'waiting_input');
  assert.equal(record.pendingInput.batchId, aBatch().batchId);
  assert.equal(record.checkpointKey, 'cp-job-1', 'a pointer, not the state');
  assert.equal(record.result, null);
  assert.equal(record.error, null);
});

test('map: an ordinary Completed instance is untouched', async () => {
  const record = mapDurableStatus({
    instanceId: 'job-1', runtimeStatus: 'Completed',
    output: { status: 'completed', result: 'done', history: [] },
    customStatus: {}, input: { record: { id: 'job-1' } },
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.result, 'done');
  assert.equal(record.pendingInput, undefined);
});

// ---------------------------------------------------------------------------
// Answering - a new orchestration, not a revived one
// ---------------------------------------------------------------------------

function fakeClient({ instance }) {
  const started = [];
  const terminated = [];
  return {
    started, terminated,
    getStatus: async () => instance,
    getStatusBy: async ({ runtimeStatus }) =>
      (runtimeStatus.includes(instance?.runtimeStatus) ? [instance] : []),
    startNew: async (name, opts) => { started.push({ name, ...opts }); return opts.instanceId; },
    terminate: async (id, reason) => { terminated.push({ id, reason }); },
    raiseEvent: async () => {},
    purgeInstanceHistory: async () => {},
  };
}

const pausedInstance = (over = {}) => ({
  instanceId: 'job-1',
  runtimeStatus: 'Completed',
  output: pausedOutput(),
  customStatus: { status: 'waiting_input', pendingInput: { batchId: aBatch().batchId, expiresAt: aBatch().expiresAt } },
  input: { task: { id: 'job-1', goal: 'book a flight' }, record: { id: 'job-1', task: { goal: 'book a flight' } }, callbackUrl: null, metadata: {} },
  ...over,
});

const makeJobs = (client) => createDurableJobs({
  client, config: { maxQueueSize: 10, durable: { pollMs: 10_000 } },
  logger: { warn() {}, info() {} }, now: () => NOW,
});

test('answer: starts a NEW orchestration rather than reviving the old one', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  const jobs = makeJobs(client);

  const res = await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } });
  assert.equal(res.ok, true);
  assert.equal(client.started.length, 1);
  assert.equal(client.started[0].name, ORCHESTRATOR_NAME);
  assert.equal(client.started[0].instanceId, 'job-1', 'the job keeps its id');
});

test('answer: the new orchestration is seeded with the answer and the old state', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  const jobs = makeJobs(client);
  await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } }, { identity: { personId: 'p-1' } });

  const { resume } = client.started[0].input;
  assert.deepEqual(resume.answered, [{ batchId: aBatch().batchId, answers: { proceed: 'approve' } }]);
  assert.ok(resume.resumeFrom, 'the run comes back with where it had got to');
  assert.equal(resume.history.at(-1).type, 'answer_received');
  assert.equal(resume.history.at(-1).answeredBy, 'p-1');
});

test('answer: the previous output is read before it is overwritten', async () => {
  // startNew on the same instance id replaces the output, and that output is
  // the only copy of the run's state.
  const order = [];
  const instance = pausedInstance();
  const client = {
    getStatus: async () => { order.push('read'); return instance; },
    startNew: async (n, o) => { order.push('write'); return o.instanceId; },
    getStatusBy: async () => [],
    terminate: async () => {},
  };
  await makeJobs(client).provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } });
  assert.deepEqual(order, ['read', 'write']);
});

test('answer: the task is carried over so the run has something to do', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  await makeJobs(client).provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } });
  assert.equal(client.started[0].input.task.goal, 'book a flight');
});

test('answer: a wrong batch is refused and nothing is started', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  const res = await makeJobs(client).provideInput('job-1', { batchId: 'inp-000000000000', answers: {} });
  assert.equal(res.code, 'batch_mismatch');
  assert.equal(client.started.length, 0);
});

test('answer: an invalid answer is refused and nothing is started', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  const res = await makeJobs(client).provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'maybe' } });
  assert.equal(res.code, 'validation_failed');
  assert.equal(client.started.length, 0);
});

test('answer: a run that is not waiting is refused', async () => {
  const client = fakeClient({
    instance: { instanceId: 'job-1', runtimeStatus: 'Completed', output: { status: 'completed', result: 'x' }, customStatus: {}, input: {} },
  });
  const res = await makeJobs(client).provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } });
  assert.equal(res.ok, false);
  assert.equal(client.started.length, 0);
});

test('pendingInput: reads the batch off the paused output', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  const pending = await makeJobs(client).pendingInput('job-1');
  assert.equal(pending.batchId, aBatch().batchId);
  assert.equal(pending.stale, false);
  assert.equal(pending.expired, false);
});

test('listWaiting: finds paused runs among Completed instances', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  const waiting = await makeJobs(client).listWaiting();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].status, 'waiting_input');
});

test('expireInput: settles a run nobody answered in time', async () => {
  const client = fakeClient({
    instance: pausedInstance({ output: pausedOutput({ batch: aBatch({ expiresAt: behind(DAY) }) }) }),
  });
  const res = await makeJobs(client).expireInput('job-1');
  assert.equal(res.ok, true);
  assert.equal(client.terminated.length, 1);
  assert.match(client.terminated[0].reason, /input expired/);
});

test('expireInput: a question still inside its window is left alone', async () => {
  const client = fakeClient({ instance: pausedInstance() });
  const res = await makeJobs(client).expireInput('job-1');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not_expired');
  assert.equal(client.terminated.length, 0);
});

// ---------------------------------------------------------------------------
// Purge safety - the sharpest hazard in the whole design
// ---------------------------------------------------------------------------

test('purge: a paused instance is recognised from either marker', () => {
  assert.equal(isLivePausedInstance(pausedInstance(), { now: NOW }), true);
  assert.equal(isLivePausedInstance({ output: pausedOutput(), customStatus: {} }, { now: NOW }), true);
  assert.equal(isLivePausedInstance({ runtimeStatus: 'Completed', output: { status: 'completed' } }, { now: NOW }), false);
});

test('purge: the skip is bounded - past expiry plus grace it is purgeable', () => {
  // An unconditional "never purge a waiting run" means a broken question sweep
  // shields instances forever and the task hub grows without bound - the very
  // thing that breaks the sweep.
  const old = pausedInstance({
    customStatus: { status: 'waiting_input', pendingInput: { expiresAt: behind(3 * DAY) } },
    output: pausedOutput({ batch: aBatch({ expiresAt: behind(3 * DAY) }) }),
  });
  assert.equal(isLivePausedInstance(old, { now: NOW, graceDays: 1 }), false);

  const justInside = pausedInstance({
    customStatus: { status: 'waiting_input', pendingInput: { expiresAt: behind(DAY / 2) } },
    output: pausedOutput({ batch: aBatch({ expiresAt: behind(DAY / 2) }) }),
  });
  assert.equal(isLivePausedInstance(justInside, { now: NOW, graceDays: 1 }), true);
});

test('purge: an unreadable deadline is kept, not deleted', () => {
  // Deleting state we cannot reason about is the worse of the two mistakes.
  const odd = { customStatus: { status: 'waiting_input', pendingInput: {} }, output: { status: 'paused' } };
  assert.equal(isLivePausedInstance(odd, { now: NOW }), true);
});

test('purge: the startup purge leaves a live paused instance alone', async () => {
  // The bug this replaces: purgeInstanceHistoryBy takes a time range and
  // cannot exclude paused instances, so a blanket purge silently deleted every
  // run waiting on an answer, on every host restart.
  const paused = pausedInstance();
  const finished = { instanceId: 'job-2', runtimeStatus: 'Completed', output: { status: 'completed' }, customStatus: {} };
  const purged = [];

  await purgeStaleOrchestrations({
    getStatusBy: async ({ runtimeStatus }) =>
      runtimeStatus.includes('Pending') ? [] : [paused, finished],
    purgeInstanceHistory: async (id) => { purged.push(id); },
    purgeInstanceHistoryBy: async () => { throw new Error('a blanket purge cannot exclude paused runs'); },
    terminate: async () => {},
  }, { logger: { warn() {} }, now: () => NOW });

  assert.deepEqual(purged, ['job-2'], 'the paused run survives; the finished one goes');
});

test('purge: a paused instance past its grace is cleared like anything else', async () => {
  const abandoned = pausedInstance({
    customStatus: { status: 'waiting_input', pendingInput: { expiresAt: behind(5 * DAY) } },
    output: pausedOutput({ batch: aBatch({ expiresAt: behind(5 * DAY) }) }),
  });
  const purged = [];

  await purgeStaleOrchestrations({
    getStatusBy: async ({ runtimeStatus }) => (runtimeStatus.includes('Pending') ? [] : [abandoned]),
    purgeInstanceHistory: async (id) => { purged.push(id); },
    terminate: async () => {},
  }, { logger: { warn() {} }, now: () => NOW });

  assert.deepEqual(purged, ['job-1']);
});

test('purge: one failed purge does not stop the rest', async () => {
  const purged = [];
  await purgeStaleOrchestrations({
    getStatusBy: async ({ runtimeStatus }) => (runtimeStatus.includes('Pending') ? [] : [
      { instanceId: 'bad', runtimeStatus: 'Completed', output: { status: 'completed' } },
      { instanceId: 'good', runtimeStatus: 'Completed', output: { status: 'completed' } },
    ]),
    purgeInstanceHistory: async (id) => {
      if (id === 'bad') throw new Error('nope');
      purged.push(id);
    },
    terminate: async () => {},
  }, { logger: { warn() {} }, now: () => NOW });

  assert.deepEqual(purged, ['good']);
});
