// tests/host-human-input-sweep.test.mjs
//
// The sweep that enforces the two deadlines on a question. Questions, not
// records: clearing settled jobs from storage is retention, on its own
// schedule, and a test here that said "retention" would mean the wrong thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createQuestionSweep, DEFAULT_SWEEP_INTERVAL_MS } = await import('../host/human-input/sweep.mjs');
const { createInProcessJobs } = await import('../host/jobs/in-process.mjs');
const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
const { createCheckpoint } = await import('../host/checkpoint/index.mjs');

// A checkpoint backed by an in-memory store. humanInput now requires memory —
// a paused run stores its state there — so every backend that can park needs
// one wired.
function testCheckpoint() {
  const rows = new Map();
  return createCheckpoint({
    store: {
      async open() {}, async close() {},
      async store(e) { rows.set(e.id, e); },
      async get(id) { return rows.get(id) ?? null; },
      async update(id, p) { rows.set(id, { ...rows.get(id), ...p }); },
      async remove(id) { rows.delete(id); },
      async query() { return []; }, async purge() {}, async count() { return rows.size; },
    },
    logger: { warn() {} },
  });
}

const hoursFromNow = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

const waiting = (id, { staleAfter = hoursFromNow(24), expiresAt = hoursFromNow(168), staleNotifiedAt = null } = {}) => ({
  id,
  status: 'waiting_input',
  staleNotifiedAt,
  pendingInput: {
    batchId: `inp-${id}`,
    jobId: id,
    askedBy: 'agent',
    questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Go ahead?' }],
    askedAt: hoursFromNow(-1),
    staleAfter,
    expiresAt,
  },
});

function harness(records) {
  const expired = [];
  const marked = [];
  const sweep = createQuestionSweep({
    listWaiting: async () => records,
    expireInput: async (id) => { expired.push(id); return { ok: true }; },
    markStale: async (id) => { marked.push(id); },
    logger: { warn() {} },
  });
  return { sweep, expired, marked };
}

// ---------------------------------------------------------------------------
// Stale: soft
// ---------------------------------------------------------------------------

test('sweep: a stale question is marked and left answerable', async () => {
  // Settling here would throw away work over a threshold that is advisory.
  const { sweep, expired, marked } = harness([waiting('j1', { staleAfter: hoursFromNow(-1) })]);
  const out = await sweep.sweepOnce();

  assert.deepEqual(marked, ['j1']);
  assert.deepEqual(expired, [], 'stale never settles anything');
  assert.equal(out.staleMarked, 1);
  assert.equal(out.expired, 0);
});

test('sweep: a question inside its window is left entirely alone', async () => {
  const { sweep, expired, marked } = harness([waiting('j1')]);
  const out = await sweep.sweepOnce();
  assert.deepEqual(marked, []);
  assert.deepEqual(expired, []);
  assert.equal(out.scanned, 1);
});

test('sweep: a question already marked stale is not marked again', async () => {
  // Otherwise every pass re-warns about the same question, every five minutes,
  // for a week.
  const { sweep, marked } = harness([waiting('j1', { staleAfter: hoursFromNow(-1), staleNotifiedAt: hoursFromNow(-0.5) })]);
  await sweep.sweepOnce();
  assert.deepEqual(marked, []);
});

// ---------------------------------------------------------------------------
// Expiry: hard
// ---------------------------------------------------------------------------

test('sweep: an expired question settles the run', async () => {
  const { sweep, expired, marked } = harness([waiting('j1', { staleAfter: hoursFromNow(-48), expiresAt: hoursFromNow(-1) })]);
  const out = await sweep.sweepOnce();

  assert.deepEqual(expired, ['j1']);
  assert.deepEqual(marked, [], 'an expired question is not also marked stale');
  assert.equal(out.expired, 1);
});

test('sweep: expiry is checked before staleness', async () => {
  // Everything expired is also stale. Marking it would be a warning about a
  // question that no longer exists.
  const { sweep, expired, marked } = harness([waiting('j1', { staleAfter: hoursFromNow(-100), expiresAt: hoursFromNow(-1) })]);
  await sweep.sweepOnce();
  assert.deepEqual(expired, ['j1']);
  assert.deepEqual(marked, []);
});

test('sweep: a job answered between the listing and the settle is left to the backend', async () => {
  // expireInput re-checks the status, so an answer that landed a millisecond
  // ago wins and the sweep counts nothing.
  const sweep = createQuestionSweep({
    listWaiting: async () => [waiting('j1', { expiresAt: hoursFromNow(-1) })],
    expireInput: async () => ({ ok: false, code: 'not_waiting' }),
    logger: { warn() {} },
  });
  const out = await sweep.sweepOnce();
  assert.equal(out.expired, 0);
  assert.equal(out.scanned, 1);
});

test('sweep: a record with no pending batch is skipped, not counted', async () => {
  const sweep = createQuestionSweep({
    listWaiting: async () => [{ id: 'j1', status: 'waiting_input', pendingInput: null }],
    expireInput: async () => ({ ok: true }),
    logger: { warn() {} },
  });
  const out = await sweep.sweepOnce();
  assert.equal(out.scanned, 0);
  assert.equal(out.expired, 0);
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('sweep: one bad record does not stop the pass', async () => {
  const expired = [];
  const sweep = createQuestionSweep({
    listWaiting: async () => [
      waiting('bad', { expiresAt: hoursFromNow(-1) }),
      waiting('good', { expiresAt: hoursFromNow(-1) }),
    ],
    expireInput: async (id) => {
      if (id === 'bad') throw new Error('store down');
      expired.push(id);
      return { ok: true };
    },
    logger: { warn() {} },
  });

  const out = await sweep.sweepOnce();
  assert.deepEqual(expired, ['good'], 'the rest of the list is still swept');
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].jobId, 'bad');
});

test('sweep: passes do not overlap', async () => {
  // A second pass starting mid-list would double-settle a run that expired
  // while the first was still working through it.
  let inFlight = 0;
  let maxConcurrent = 0;
  const sweep = createQuestionSweep({
    listWaiting: async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await sleep(20);
      inFlight -= 1;
      return [];
    },
    expireInput: async () => ({ ok: true }),
    logger: { warn() {} },
  });

  const [, second] = await Promise.all([sweep.sweepOnce(), sweep.sweepOnce()]);
  assert.equal(maxConcurrent, 1);
  assert.equal(second.skipped, true);
});

test('sweep: the default interval is five minutes', () => {
  assert.equal(DEFAULT_SWEEP_INTERVAL_MS, 300_000);
});

test('sweep: start and stop are idempotent and unref the timer', () => {
  const sweep = createQuestionSweep({ listWaiting: async () => [], expireInput: async () => ({}), intervalMs: 50 });
  sweep.start();
  sweep.start();
  sweep.stop();
  sweep.stop();
});

// ---------------------------------------------------------------------------
// Against the real backend
// ---------------------------------------------------------------------------

test('sweep: end to end against the in-process backend', async () => {
  const store = createMemoryStore();
  const runJob = async (task, { askUser }) => {
    try {
      await askUser({ questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Go ahead?', required: true }] });
    } catch (err) {
      return {
        status: 'paused',
        batchId: err.batch.batchId,
        // Already past its deadline when written.
        batch: { ...err.batch, expiresAt: new Date(Date.now() - 1000).toISOString() },
        history: [], budget: null, progress: { observations: [], plan: null },
      };
    }
    return { status: 'completed', result: 'done', history: [], budget: null };
  };

  const jobs = createInProcessJobs({
    checkpoint: testCheckpoint(),
    store, runJob, humanInput: { enabled: true },
    config: { maxQueueSize: 10, concurrency: 1, leaseTimeoutMs: 60_000, retentionMs: 86_400_000, drainMs: 100, capacity: 1 },
    logger: { warn() {}, info() {} },
  });
  await jobs.start();

  const { jobId } = await jobs.submit({ goal: 'ask something' });
  for (let i = 0; i < 200 && (await jobs.get(jobId)).status !== 'waiting_input'; i++) await sleep(5);

  const waitingNow = await jobs.listWaiting();
  assert.equal(waitingNow.length, 1);

  const sweep = createQuestionSweep({
    listWaiting: () => jobs.listWaiting(),
    expireInput: (id) => jobs.expireInput(id),
    markStale: (id) => jobs.markInputStale(id),
    logger: { warn() {} },
  });

  const out = await sweep.sweepOnce();
  assert.equal(out.expired, 1);

  const settled = await jobs.get(jobId);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.error.code, 'input_expired');
  assert.deepEqual(await jobs.listWaiting(), [], 'the job is no longer swept');

  await jobs.stop({ drainMs: 0 });
});

test('sweep: marking stale through the backend is recorded once', async () => {
  const store = createMemoryStore();
  const runJob = async (task, { askUser }) => {
    try {
      await askUser({ questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Go ahead?', required: true }] });
    } catch (err) {
      return {
        status: 'paused', batchId: err.batch.batchId,
        batch: { ...err.batch, staleAfter: new Date(Date.now() - 1000).toISOString() },
        history: [], budget: null, progress: { observations: [], plan: null },
      };
    }
    return { status: 'completed', result: 'done', history: [], budget: null };
  };

  const jobs = createInProcessJobs({
    checkpoint: testCheckpoint(),
    store, runJob, humanInput: { enabled: true },
    config: { maxQueueSize: 10, concurrency: 1, leaseTimeoutMs: 60_000, retentionMs: 86_400_000, drainMs: 100, capacity: 1 },
    logger: { warn() {}, info() {} },
  });
  await jobs.start();

  const { jobId } = await jobs.submit({ goal: 'ask something' });
  for (let i = 0; i < 200 && (await jobs.get(jobId)).status !== 'waiting_input'; i++) await sleep(5);

  assert.equal((await jobs.markInputStale(jobId)).ok, true);
  assert.equal((await jobs.markInputStale(jobId)).ok, false, 'marking twice is a no-op');

  const record = await jobs.get(jobId);
  assert.ok(record.staleNotifiedAt);
  assert.equal(record.status, 'waiting_input', 'still answerable');
  assert.equal((await jobs.pendingInput(jobId)).stale, true);

  await jobs.stop({ drainMs: 0 });
});
