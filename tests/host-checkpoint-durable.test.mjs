// tests/host-checkpoint-durable.test.mjs
//
// On Azure the orchestration output becomes a pointer.
//
// Durable caps an output at 16 KB. #63 had to ship a `pause_too_large` failure
// because the state travelled in that output and a long run would not fit.
// With the state in the memory store the output carries a key, so the cap
// stops mattering — and that guard becomes an assertion rather than a path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');
const { mapDurableStatus } = await import('../host/jobs/durable.mjs');

const aBatch = () => ({
  batchId: 'inp-a3f19c284d61',
  jobId: 'job-1',
  askedBy: 'guardrail',
  questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?', required: true }],
  askedAt: '2026-09-30T09:00:00.000Z',
  staleAfter: '2026-10-01T09:00:00.000Z',
  expiresAt: '2026-10-07T09:00:00.000Z',
});

/**
 * Drive the orchestrator to completion against one activity outcome.
 *
 * The orchestrator is the run loop now: it yields an activity, then an entity
 * commit, and goes round until the activity reports `done`. Only the activity
 * consumes the scripted outcome.
 */
function runOrchestrator(activityOutput) {
  const customStatuses = [];
  const ctx = {
    df: {
      instanceId: 'job-1',
      currentUtcDateTime: new Date('2026-09-30T09:00:00Z'),
      getInput: () => ({ task: { goal: 'g' } }),
      setCustomStatus: (s) => customStatuses.push(structuredClone(s)),
      callActivity: () => ({ __t: 'activity' }),
      callEntity: () => ({ __t: 'entity' }),
      EntityId: function EntityId(name, key) { return { name, key }; },
    },
  };
  const gen = buildOrchestrator()(ctx);
  let step = gen.next();
  let guard = 0;
  while (!step.done) {
    step = gen.next(step.value?.__t === 'activity' ? activityOutput : undefined);
    if ((guard += 1) > 200) throw new Error('orchestrator did not terminate');
  }
  return { output: step.value, customStatuses, done: step.done };
}

// `done` ends the loop; a paused run keeps its checkpoint, so `cleared` is
// false and the delta is committed before the orchestration completes.
const paused = (over = {}) => ({
  status: 'paused',
  done: true,
  cleared: false,
  delta: null,
  batchId: aBatch().batchId,
  batch: aBatch(),
  checkpointKey: 'cp-job-1',
  ...over,
});

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

test('a paused output carries a pointer, not state', () => {
  const { output, done } = runOrchestrator(paused());
  assert.equal(done, true, 'the orchestration still completes rather than waiting');
  assert.equal(output.checkpointKey, 'cp-job-1');
  assert.equal('snapshot' in output, false, 'the state is in the memory store now');
  assert.equal('history' in output, false);
});

test('a pause can no longer be too large to fit', () => {
  // The 16 KB cap applied to the state. It now applies to a pointer, so the
  // failure this guard existed for is unreachable in practice.
  const { output } = runOrchestrator(paused());
  assert.equal(output.status, 'paused');
  assert.notEqual(output.error?.code, 'pause_too_large');
});

test('the guard survives as an assertion, in case state comes back', () => {
  // If this ever fires, something has started putting state in the output
  // again — which is worth failing loudly rather than truncating silently.
  // The paused output is constructed from named fields now, so a stray one
  // cannot bloat it. State coming back would arrive inside the batch, which is
  // the field that does travel — so that is where the guard has to still work.
  const { output } = runOrchestrator(paused({
    batch: { ...aBatch(), questions: [{ fieldId: 'f', kind: 'text', prompt: 'x'.repeat(20_000) }] },
  }));
  assert.equal(output.status, 'failed');
  assert.equal(output.error.code, 'pause_too_large');
  assert.match(output.error.message, /pointer, not state/);
});

test('customStatus still carries the small marker', () => {
  const { customStatuses } = runOrchestrator(paused());
  const last = customStatuses.at(-1);
  assert.equal(last.status, 'waiting_input');
  assert.equal(last.pendingInput.batchId, aBatch().batchId);
  assert.equal('snapshot' in last, false);
});

test('a normal settle is unchanged', () => {
  const { output } = runOrchestrator({ status: 'completed', done: true, cleared: true, delta: null, result: 'done' });
  assert.equal(output.status, 'completed');
  assert.equal(output.result, 'done');
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

test('a paused instance exposes its checkpoint key, not its state', () => {
  const record = mapDurableStatus({
    instanceId: 'job-1',
    runtimeStatus: 'Completed',
    output: paused(),
    customStatus: { status: 'waiting_input' },
    input: { record: { id: 'job-1', task: { goal: 'g' } } },
  });

  assert.equal(record.status, 'waiting_input');
  assert.equal(record.checkpointKey, 'cp-job-1');
  assert.equal(record.pendingBatchId, aBatch().batchId);
  assert.equal(record.pendingInput.batchId, aBatch().batchId, 'the batch is still there for the UI');
  assert.equal(record.snapshot, undefined, 'but not the state');
});

test('an ordinary Completed instance is untouched', () => {
  const record = mapDurableStatus({
    instanceId: 'job-1', runtimeStatus: 'Completed',
    output: { status: 'completed', result: 'done', history: [] },
    customStatus: {}, input: { record: { id: 'job-1' } },
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.result, 'done');
  assert.equal(record.checkpointKey, undefined);
});

// ---------------------------------------------------------------------------
// ...and reading it back for real
//
// The two tests above assert the shape of the pointer. Neither drives the path
// that has to *dereference* it, and that path did not exist: provideInput
// called planResume with no `loaded` and no `taskKey`, so a resumed Azure run
// rebuilt from an empty history and re-did everything it had already done.
//
// The whole point of the pointer is that somebody follows it.
// ---------------------------------------------------------------------------

const { createDurableJobs } = await import('../host/jobs/durable.mjs');
const { createCheckpoint } = await import('../host/checkpoint/index.mjs');
const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');

function pausedClient(output) {
  const calls = { startNew: [] };
  const instances = {
    'job-1': {
      instanceId: 'job-1', runtimeStatus: 'Completed', output,
      customStatus: { status: 'waiting_input' },
      input: { record: { id: 'job-1', task: { goal: 'g' } }, task: { id: 'job-1', goal: 'g' }, metadata: {} },
      createdTime: '2026-09-30T09:00:00.000Z', lastUpdatedTime: '2026-09-30T09:00:00.000Z',
    },
  };
  return {
    calls, instances,
    async startNew(name, { instanceId, input }) { calls.startNew.push({ name, instanceId, input }); return instanceId; },
    async getStatus(id) { return instances[id] ?? null; },
    async getStatusBy() { return []; },
    async terminate() {}, async raiseEvent() {},
  };
}

async function checkpointHolding(fields) {
  // A real store, not a double. Every checkpoint defect on this branch that
  // the doubles missed was caught by writing through one.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-durable-'));
  const store = createSqliteStore({ dbPath: path.join(dir, 'memory.db') });
  await store.open();
  const cp = createCheckpoint({ store, logger: { warn() {}, info() {} } });
  await cp.save('cp-job-1', { jobId: 'job-1', task: { id: 'job-1', goal: 'g' }, ...fields });
  return cp;
}

test('answering an Azure pause resumes from the checkpoint, not from nothing', async () => {
  const obs = [{ type: 'observation', stepType: 'tool', tool: 'book', result: { ok: true, ref: 'FL-1' } }];
  const checkpoint = await checkpointHolding({
    observations: obs,
    plan: { steps: [{ type: 'tool', tool: 'book', args: { x: 1 }, reason: 'r', review: false }], cursor: 1 },
    interruptions: 2,
    identity: { personId: 'alice' },
  });

  const client = pausedClient(paused());
  const jobs = createDurableJobs({
    client, config: { maxQueueSize: 2, durable: { pollMs: 5 } },
    notifier: null, logger: { warn() {}, info() {} }, checkpoint,
  });

  const out = await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } },
    { identity: { personId: 'alice' } });
  assert.equal(out.ok, true, JSON.stringify(out));

  const resume = client.calls.startNew[0].input.resume;
  assert.deepEqual(resume.resumeFrom.observations, obs, 'the completed work came back');
  assert.equal(resume.resumeFrom.plan.cursor, 1, 'and where it had got to');
  assert.equal(resume.resumeFrom.interruptions, 2, 'and how many times it had already asked');
});

test('an Azure pause refuses a stranger, because the owner is on the checkpoint', async () => {
  const checkpoint = await checkpointHolding({ observations: [], identity: { personId: 'alice' } });
  const client = pausedClient(paused());
  const jobs = createDurableJobs({
    client, config: { maxQueueSize: 2, durable: { pollMs: 5 } },
    notifier: null, logger: { warn() {}, info() {} }, checkpoint,
  });

  const out = await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } },
    { identity: { personId: 'mallory' } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'not_your_job');
  assert.equal(client.calls.startNew.length, 0, 'and no orchestration was started');
});

// ---------------------------------------------------------------------------
// History has to survive a pause on Azure too
//
// `mapDurableStatus` read the run's history out of `instance.output.history`.
// Once the paused output became a pointer it stopped carrying history, so the
// read always produced `[]`: the audit trail of what was asked and answered
// was lost at the first pause, and `learnableAnswers` saw nothing at all on
// the durable backend. The accumulated history travels in the orchestration
// *input*, which provideInput already writes — the read was looking in the
// wrong place.
// ---------------------------------------------------------------------------

test('a resumed orchestration still knows what was asked and answered', async () => {
  const earlier = [
    { type: 'run_started', jobId: 'job-1', at: '2026-09-30T09:00:00.000Z', task: { goal: 'g' } },
    { type: 'question_asked', jobId: 'job-1', at: '2026-09-30T09:01:00.000Z', batch: aBatch() },
  ];

  const record = mapDurableStatus({
    instanceId: 'job-1', runtimeStatus: 'Completed', output: paused(),
    customStatus: { status: 'waiting_input' },
    input: { record: { id: 'job-1', task: { goal: 'g' } }, resume: { history: earlier } },
  });

  assert.equal(record.history.length, 2, 'the carried history came back');
  assert.equal(record.history[1].type, 'question_asked');
});

test('a question asked during the run reaches the history', async () => {
  // A pause holds exactly one unanswered batch, so returning it in the output
  // is bounded — unlike the accumulated history, which stays in the input.
  const checkpoint = await checkpointHolding({ observations: [], identity: null });
  const output = { ...paused(), asked: [
    { type: 'question_asked', jobId: 'job-1', at: '2026-09-30T09:01:00.000Z', batch: aBatch() },
  ] };
  const client = pausedClient(output);
  const jobs = createDurableJobs({
    client, config: { maxQueueSize: 2, durable: { pollMs: 5 } },
    notifier: null, logger: { warn() {}, info() {} }, checkpoint,
  });

  const out = await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } }, {});
  assert.equal(out.ok, true, JSON.stringify(out));

  const forwarded = client.calls.startNew[0].input.resume.history;
  const types = forwarded.map(e => e.type);
  assert.ok(types.includes('question_asked'), `no question_asked in ${types}`);
  assert.ok(types.includes('answer_received'), `no answer_received in ${types}`);
});

// ---------------------------------------------------------------------------
// Task 4: resume reads the entity
//
// The checkpoint lives in the task hub now, so `provideInput` must follow the
// pointer to an entity rather than to the memory store. A paused run created
// before entities existed has no entity at all, and must still resume.
// ---------------------------------------------------------------------------

function clientWithEntity(entityState, output = paused()) {
  const calls = { startNew: [], read: [] };
  const instances = {
    'job-1': {
      instanceId: 'job-1', runtimeStatus: 'Completed', output,
      customStatus: { status: 'waiting_input' },
      input: { record: { id: 'job-1', task: { goal: 'g' } }, task: { id: 'job-1', goal: 'g' }, metadata: {} },
      createdTime: '2026-09-30T09:00:00.000Z', lastUpdatedTime: '2026-09-30T09:00:00.000Z',
    },
  };
  return {
    calls, instances,
    async startNew(name, { instanceId, input }) { calls.startNew.push({ name, instanceId, input }); return instanceId; },
    async getStatus(id) { return instances[id] ?? null; },
    async getStatusBy() { return []; },
    async terminate() {}, async raiseEvent() {},
    async readEntityState(id) {
      calls.read.push(id);
      return { entityExists: entityState !== null, entityState };
    },
  };
}

test('answering reads the run state back out of the checkpoint entity', async () => {
  const obs = [{ type: 'observation', stepType: 'tool', tool: 'book', result: { ok: true, ref: 'FL-1' } }];
  const client = clientWithEntity({
    version: 1, taskKey: 'cp-job-1', jobId: 'job-1',
    task: { id: 'job-1', goal: 'g' },
    observations: obs,
    plan: { steps: [{ type: 'tool', tool: 'book', args: {}, reason: 'r', review: false }], cursor: 1 },
    interruptions: 2, identity: null, idempotencyKeys: [], conversation: [], recalledFacts: [],
  });

  const jobs = createDurableJobs({
    client, config: { maxQueueSize: 2, durable: { pollMs: 5 } },
    notifier: null, logger: { warn() {}, info() {} },
  });

  const out = await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } }, {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(client.calls.read.length >= 1, 'it followed the pointer to the entity');

  const resume = client.calls.startNew[0].input.resume;
  assert.deepEqual(resume.resumeFrom.observations, obs, 'the completed work came back');
  assert.equal(resume.resumeFrom.plan.cursor, 1);
  assert.equal(resume.resumeFrom.interruptions, 2);
});

test('a paused run with no entity still resumes, from history', async () => {
  // A run parked by an older kit has no entity. Rebuilding from history is
  // worse than reading a checkpoint, but it is not a failure — and throwing
  // here would strand every run that was already waiting at upgrade time.
  const client = clientWithEntity(null);
  const jobs = createDurableJobs({
    client, config: { maxQueueSize: 2, durable: { pollMs: 5 } },
    notifier: null, logger: { warn() {}, info() {} },
  });

  const out = await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } }, {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(client.calls.startNew.length === 1, 'the answer still started the next orchestration');
});

test('an entity that cannot be read does not fail the answer', async () => {
  const client = clientWithEntity(null);
  client.readEntityState = async () => { throw new Error('entity store down'); };
  const jobs = createDurableJobs({
    client, config: { maxQueueSize: 2, durable: { pollMs: 5 } },
    notifier: null, logger: { warn() {}, info() {} },
  });
  const out = await jobs.provideInput('job-1', { batchId: aBatch().batchId, answers: { proceed: 'approve' } }, {});
  assert.equal(out.ok, true, 'degraded recovery, not a refused answer');
});
