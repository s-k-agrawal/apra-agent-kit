// tests/host-checkpoint-pause-resume.test.mjs
//
// The job record carries a pointer; the state lives in the checkpoint.
//
// Two consequences worth pinning down. A pause that cannot be checkpointed is
// fatal — an unsaved pause is a question nobody will ever answer, and carrying
// on would mean proceeding past an approval that was never given. And an
// answer that arrives after the checkpoint store was wiped must still resume,
// rebuilding from history, rather than 500.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createInProcessJobs } = await import('../host/jobs/in-process.mjs');
const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
const { createCheckpoint } = await import('../host/checkpoint/index.mjs');

const BASE = {
  maxQueueSize: 10, concurrency: 1, leaseTimeoutMs: 60_000,
  retentionMs: 86_400_000, drainMs: 100, capacity: 1,
};

const approvalQ = [{ fieldId: 'proceed', kind: 'approval', prompt: 'Go ahead?', required: true }];

/** A checkpoint backed by an in-memory store, so a test can wipe it. */
function backedCheckpoint({ failSave = false } = {}) {
  const rows = new Map();
  const store = {
    async open() {}, async close() {},
    async store(e) { if (failSave) throw new Error('store down'); rows.set(e.id, e); },
    async get(id) { return rows.get(id) ?? null; },
    async update(id, p) { if (failSave) throw new Error('store down'); rows.set(id, { ...rows.get(id), ...p }); },
    async remove(id) { rows.delete(id); },
    async query() { return []; }, async purge() {}, async count() { return rows.size; },
  };
  return { rows, checkpoint: createCheckpoint({ store, logger: { warn() {} } }) };
}

/** Asks once, then completes when the answer is replayed. */
const askingRunner = () => ({
  runJob: async (task, { askUser }) => {
    try {
      const answer = await askUser({ questions: approvalQ });
      return { status: 'completed', result: `answered:${answer.answers.proceed}`, history: [], budget: null };
    } catch (err) {
      if (err.name !== 'PauseRequested') throw err;
      return {
        status: 'paused', batchId: err.batch.batchId, batch: err.batch,
        history: [{ type: 'observation', tool: 'search', result: { hits: 2 } }],
        budget: { iterations: 1 },
        progress: {
          observations: [{ type: 'observation', tool: 'search', result: { hits: 2 } }],
          plan: { steps: ['search', 'book'], cursor: 1 },
        },
        traceId: 'tr-1',
      };
    }
  },
});

function harness({ failSave = false, runner = askingRunner() } = {}) {
  const { rows, checkpoint } = backedCheckpoint({ failSave });
  const store = createMemoryStore();
  const jobs = createInProcessJobs({
    store, runJob: runner.runJob, checkpoint,
    humanInput: { enabled: true },
    config: BASE, logger: { warn() {}, info() {} },
  });
  return { jobs, rows, store };
}

const waitFor = async (jobs, id, status, ms = 5000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await jobs.get(id);
    if (last?.status === status) return last;
    await sleep(10);
  }
  assert.fail(`job ${id} never reached ${status} (is ${last?.status})`);
};

// ---------------------------------------------------------------------------
// Parking
// ---------------------------------------------------------------------------

test('the job record carries a pointer, not state', async () => {
  const h = harness();
  await h.jobs.start();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'ask' });
    const rec = await waitFor(h.jobs, jobId, 'waiting_input');

    assert.equal('snapshot' in rec, false, 'no state field on the job record at all');
    assert.equal(rec.pendingBatchId, rec.pendingInput.batchId, 'a pointer is on the record');
    assert.ok(rec.pendingInput, 'and the batch, which the UI renders');
    assert.equal(h.rows.size, 1, 'the state is in the checkpoint store');
  } finally { await h.jobs.stop({ drainMs: 0 }); }
});

test('the checkpoint holds what the resume needs', async () => {
  const h = harness();
  await h.jobs.start();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'ask' });
    await waitFor(h.jobs, jobId, 'waiting_input');

    const cp = JSON.parse(h.rows.get('cp-' + jobId).text);
    assert.deepEqual(cp.plan, { steps: ['search', 'book'], cursor: 1 });
    assert.equal(cp.observations.length, 1);
    assert.equal(cp.interruptions, 1, 'the counter must survive the pause');
    assert.ok(cp.pendingBatchId);
  } finally { await h.jobs.stop({ drainMs: 0 }); }
});

test('a pause that cannot be checkpointed settles failed', async () => {
  // An unsaved pause is a question nobody will ever answer. Continuing would
  // mean proceeding past an approval that was never given.
  const h = harness({ failSave: true });
  await h.jobs.start();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'ask' });
    const rec = await waitFor(h.jobs, jobId, 'failed');
    assert.equal(rec.error.code, 'pause_failed');
  } finally { await h.jobs.stop({ drainMs: 0 }); }
});

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

test('the full cycle: ask, park, answer, resume, complete', async () => {
  const h = harness();
  await h.jobs.start();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'ask' });
    const parked = await waitFor(h.jobs, jobId, 'waiting_input');

    const res = await h.jobs.provideInput(jobId, {
      batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' },
    });
    assert.equal(res.ok, true);

    const done = await waitFor(h.jobs, jobId, 'completed');
    assert.equal(done.result, 'answered:approve');
    assert.equal(done.pendingInput, null);
    assert.equal(done.pendingBatchId, null, 'the pointer is cleared on settle');
  } finally { await h.jobs.stop({ drainMs: 0 }); }
});

test('an answer after the checkpoint store was wiped rebuilds from history', async () => {
  // The pointer is on the job record; the checkpoint is gone. This must
  // resume, not 500.
  const h = harness();
  await h.jobs.start();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'ask' });
    const parked = await waitFor(h.jobs, jobId, 'waiting_input');

    h.rows.clear();   // the store is wiped while the person is away

    const res = await h.jobs.provideInput(jobId, {
      batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' },
    });
    assert.equal(res.ok, true, 'the answer is accepted');
    await waitFor(h.jobs, jobId, 'completed');
  } finally { await h.jobs.stop({ drainMs: 0 }); }
});

test('a settled run clears its checkpoint', async () => {
  // It is in-flight state. Keeping it after the run finishes grows the store
  // with every job that ever ran.
  const h = harness();
  await h.jobs.start();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'ask' });
    const parked = await waitFor(h.jobs, jobId, 'waiting_input');
    await h.jobs.provideInput(jobId, {
      batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' },
    });
    await waitFor(h.jobs, jobId, 'completed');

    assert.equal(h.rows.size, 0, 'the checkpoint is gone');
  } finally { await h.jobs.stop({ drainMs: 0 }); }
});

test('cancelling while waiting clears the checkpoint too', async () => {
  const h = harness();
  await h.jobs.start();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'ask' });
    await waitFor(h.jobs, jobId, 'waiting_input');

    await h.jobs.cancel(jobId);
    const rec = await h.jobs.get(jobId);
    assert.equal(rec.status, 'cancelled');
    assert.equal(h.rows.size, 0);
  } finally { await h.jobs.stop({ drainMs: 0 }); }
});
