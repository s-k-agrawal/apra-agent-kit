// tests/host-human-input-jobs.test.mjs
//
// The in-process backend parking a run and picking it back up.
//
// The load-bearing claim of the whole feature is here: a run that is waiting
// on a person holds no worker. At `dispatch.concurrency: 1` that is the
// difference between one unanswered question and a dead agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createInProcessJobs } = await import('../host/jobs/in-process.mjs');
const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
const { supportsHumanInput } = await import('../host/jobs/interface.mjs');
const { createBatch } = await import('../host/human-input/batch.mjs');
const { TERMINAL_STATUSES } = await import('../host/jobs/record.mjs');
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

const BASE = {
  maxQueueSize: 10, concurrency: 1, leaseTimeoutMs: 60_000,
  retentionMs: 86_400_000, drainMs: 500, capacity: 2,
};

const approvalQuestions = [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?', required: true }];

/**
 * A runJob that asks a question the first time it sees a job and completes the
 * second time, which is exactly the shape of a real pause-and-resume.
 */
function makeAskingRunner({ questions = approvalQuestions, askedBy = 'agent' } = {}) {
  const calls = [];
  const runJob = async (task, { askUser, resumeFrom }) => {
    calls.push({ taskId: task.id, resumeFrom, hasAskUser: typeof askUser === 'function' });
    try {
      const answer = await askUser({ askedBy, questions });
      return {
        status: 'completed',
        result: `answered: ${JSON.stringify(answer.answers)}`,
        history: [{ type: 'observation', answer: answer.answers }],
        budget: { iterations: 2, elapsedMs: 50 },
      };
    } catch (err) {
      if (err.name !== 'PauseRequested') throw err;
      return {
        status: 'paused',
        batchId: err.batch.batchId,
        batch: err.batch,
        result: null,
        history: [{ type: 'observation', tool: 'search', result: { hits: 4 } }],
        budget: { iterations: 1, elapsedMs: 30 },
        progress: {
          observations: [{ type: 'observation', tool: 'search', result: { hits: 4 } }],
          plan: { steps: ['search', 'book'], cursor: 1 },
        },
        traceId: 'trace-9',
      };
    }
  };
  return { runJob, calls };
}

async function setup({ overrides = {}, runner, humanInput = { enabled: true }, checkpoint = null } = {}) {
  const store = createMemoryStore();
  const published = [];
  const jobs = createInProcessJobs({
    checkpoint: checkpoint ?? testCheckpoint(),
    store,
    runJob: runner.runJob,
    notifier: { publish: (e) => published.push(e) },
    config: { ...BASE, ...overrides },
    logger: { warn() {}, info() {} },
    humanInput,
  });
  await jobs.start();
  return { jobs, store, published };
}

const waitForStatus = async (jobs, jobId, status, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await jobs.get(jobId);
    if (r?.status === status) return r;
    await sleep(5);
  }
  const r = await jobs.get(jobId);
  assert.fail(`job ${jobId} never reached ${status} (is ${r?.status})`);
};

// ---------------------------------------------------------------------------
// The backend contract
// ---------------------------------------------------------------------------

test('backend: the in-process backend supports human input', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  assert.equal(supportsHumanInput(jobs), true);
  await jobs.stop({ drainMs: 0 });
});

test('backend: a backend without the methods is still a valid jobs backend', () => {
  // The methods are optional so a backend written before the feature - or one
  // an adopter wrote themselves - keeps working.
  assert.equal(supportsHumanInput({ get() {}, submit() {} }), false);
});

// ---------------------------------------------------------------------------
// Parking
// ---------------------------------------------------------------------------

test('park: a run that asks a question lands in waiting_input with its batch', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });

  const record = await waitForStatus(jobs, jobId, 'waiting_input');
  assert.ok(record.pendingInput, 'the question is on the record');
  assert.equal(record.pendingInput.questions[0].prompt, 'Book the flight?');
  assert.equal(record.finishedAt, null, 'a paused run has not finished');
  assert.equal(TERMINAL_STATUSES.has(record.status), false);

  await jobs.stop({ drainMs: 0 });
});

test('park: the checkpoint records where the run had got to', async () => {
  // The job record used to carry this. It now carries a pointer, and the
  // state lives in the checkpoint — one place to look, one writer.
  const checkpoint = testCheckpoint();
  const { jobs } = await setup({ runner: makeAskingRunner(), checkpoint });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const record = await waitForStatus(jobs, jobId, 'waiting_input');

  assert.equal('snapshot' in record, false, 'no state field on the record at all');
  assert.equal(record.pendingBatchId, record.pendingInput.batchId, 'a pointer is');

  const cp = (await checkpoint.load(`cp-${jobId}`)).checkpoint;
  assert.equal(cp.version, 1);
  assert.equal(cp.pendingBatchId, record.pendingInput.batchId);
  assert.deepEqual(cp.plan, { steps: ['search', 'book'], cursor: 1 });
  assert.equal(cp.observations.length, 1);
  assert.equal(cp.interruptions, 1, 'the counter must survive the pause');

  await jobs.stop({ drainMs: 0 });
});

test('park: the worker is released - this is the point of the whole feature', async () => {
  // At concurrency 1, if the paused job still held its slot, the second job
  // would never start and one unanswered question would stop the agent dead.
  const { jobs } = await setup({ overrides: { concurrency: 1 }, runner: makeAskingRunner() });

  const first = await jobs.submit({ goal: 'ask something' });
  await waitForStatus(jobs, first.jobId, 'waiting_input');
  assert.equal(jobs.stats().processing, 0, 'no worker is held by a waiting job');

  const second = await jobs.submit({ goal: 'ask something else' });
  await waitForStatus(jobs, second.jobId, 'waiting_input');

  await jobs.stop({ drainMs: 0 });
});

test('park: input_required is published so a waiting client is told', async () => {
  const { jobs, published } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  await waitForStatus(jobs, jobId, 'waiting_input');

  const event = published.find(e => e.type === 'input_required');
  assert.ok(event, 'input_required was published');
  assert.equal(event.jobId, jobId);
  assert.equal(event.questions[0].fieldId, 'proceed');
  assert.ok(event.expiresAt);

  await jobs.stop({ drainMs: 0 });
});

test('park: question_asked is written to history', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  await waitForStatus(jobs, jobId, 'waiting_input');

  const history = await jobs.events(jobId);
  const asked = history.find(e => e.type === 'question_asked');
  assert.ok(asked, 'the batch is in history, not only on the record');
  assert.equal(asked.batch.questions[0].prompt, 'Book the flight?');

  await jobs.stop({ drainMs: 0 });
});

test('park: if the question cannot be stored, the run fails rather than continuing', async () => {
  // Continuing would mean proceeding past an approval that was never given.
  const runner = makeAskingRunner();
  const store = createMemoryStore();
  const jobs = createInProcessJobs({
    checkpoint: testCheckpoint(),
    store, runJob: runner.runJob, config: BASE, logger: { warn() {}, info() {} },
    humanInput: { enabled: true },
  });
  await jobs.start();

  const original = store.update.bind(store);
  store.update = async (id, patch) => {
    if (patch.status === 'waiting_input') throw new Error('store down');
    return original(id, patch);
  };

  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const record = await waitForStatus(jobs, jobId, 'failed');
  assert.equal(record.error.code, 'pause_failed');

  await jobs.stop({ drainMs: 0 });
});

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

test('answer: the full cycle - ask, park, answer, resume, complete', async () => {
  const runner = makeAskingRunner();
  const { jobs } = await setup({ runner });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });

  const parked = await waitForStatus(jobs, jobId, 'waiting_input');
  const res = await jobs.provideInput(jobId, {
    batchId: parked.pendingInput.batchId,
    answers: { proceed: 'approve' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.stale, false);

  const done = await waitForStatus(jobs, jobId, 'completed');
  assert.equal(done.result, 'answered: {"proceed":"approve"}');
  assert.equal(done.pendingInput, null, 'a settled job holds no unanswered question');

  // The second run was a cold start that replayed the answer.
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[0].resumeFrom, null, 'the first run started from nothing');
  assert.ok(runner.calls[1].resumeFrom, 'the second run was seeded');

  await jobs.stop({ drainMs: 0 });
});

test('answer: the resumed run is given the observations it had before pausing', async () => {
  const runner = makeAskingRunner();
  const { jobs } = await setup({ runner });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });

  const parked = await waitForStatus(jobs, jobId, 'waiting_input');
  await jobs.provideInput(jobId, { batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' } });
  await waitForStatus(jobs, jobId, 'completed');

  const resumed = runner.calls[1].resumeFrom;
  assert.deepEqual(resumed.plan, { steps: ['search', 'book'], cursor: 1 });
  assert.equal(resumed.observations.length, 1);
  assert.equal(resumed.interruptions, 1, 'the counter continues rather than resetting');

  await jobs.stop({ drainMs: 0 });
});

test('answer: completed work is never re-executed', async () => {
  // Resume restores state; it does not replay side effects.
  const sideEffects = [];
  const runJob = async (task, { askUser, resumeFrom }) => {
    if (!resumeFrom) sideEffects.push('charged the card');
    try {
      await askUser({ questions: approvalQuestions });
    } catch (err) {
      if (err.name !== 'PauseRequested') throw err;
      return { status: 'paused', batchId: err.batch.batchId, batch: err.batch, history: [], budget: null, progress: { observations: [], plan: null } };
    }
    return { status: 'completed', result: 'done', history: [], budget: null };
  };

  const { jobs } = await setup({ runner: { runJob } });
  const { jobId } = await jobs.submit({ goal: 'buy something' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');
  await jobs.provideInput(jobId, { batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' } });
  await waitForStatus(jobs, jobId, 'completed');

  assert.deepEqual(sideEffects, ['charged the card'], 'the card is charged once, not twice');

  await jobs.stop({ drainMs: 0 });
});

test('answer: answer_received and input_resolved both record the decision', async () => {
  const { jobs, published } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');

  await jobs.provideInput(jobId,
    { batchId: parked.pendingInput.batchId, answers: { proceed: 'deny' } },
    { identity: { personId: 'person-6f2a' } });
  await waitForStatus(jobs, jobId, 'completed');

  const entry = (await jobs.events(jobId)).find(e => e.type === 'answer_received');
  assert.deepEqual(entry.answers, { proceed: 'deny' });
  assert.equal(entry.answeredBy, 'person-6f2a');

  const event = published.find(e => e.type === 'input_resolved');
  assert.equal(event.resolution, 'answered');

  await jobs.stop({ drainMs: 0 });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('refuse: a second answer for the same batch is refused', async () => {
  // The guard is the status transition: the first answer moves the job out of
  // waiting_input, so the second finds the wrong status. A double-click and a
  // client retry are both this shape.
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');
  const submission = { batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' } };

  const first = await jobs.provideInput(jobId, submission);
  assert.equal(first.ok, true);

  const second = await jobs.provideInput(jobId, submission);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already_answered');
  assert.equal(second.status, 409);

  await jobs.stop({ drainMs: 0 });
});

test('refuse: answering a job that was never waiting', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const res = await jobs.provideInput('job-nope', { batchId: 'inp-1', answers: {} });
  assert.equal(res.code, 'not_found');
  assert.equal(res.status, 404);
  await jobs.stop({ drainMs: 0 });
});

test('refuse: answering the wrong batch', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  await waitForStatus(jobs, jobId, 'waiting_input');

  const res = await jobs.provideInput(jobId, { batchId: 'inp-000000000000', answers: { proceed: 'approve' } });
  assert.equal(res.code, 'batch_mismatch');
  assert.equal(res.status, 409);

  await jobs.stop({ drainMs: 0 });
});

test('refuse: an invalid answer reports which field and changes nothing', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');

  const res = await jobs.provideInput(jobId, { batchId: parked.pendingInput.batchId, answers: { proceed: 'maybe' } });
  assert.equal(res.code, 'validation_failed');
  assert.equal(res.status, 400);
  assert.ok(res.fields.proceed);

  assert.equal((await jobs.get(jobId)).status, 'waiting_input', 'a rejected answer resumes nothing');

  await jobs.stop({ drainMs: 0 });
});

test('refuse: an answer from someone else is refused - a batch id is not a capability', async () => {
  const runJob = async (task, { askUser }) => {
    try { await askUser({ questions: approvalQuestions }); } catch (err) {
      return {
        status: 'paused', batchId: err.batch.batchId, batch: err.batch, history: [], budget: null,
        progress: { observations: [], plan: null },
        identity: { personId: 'person-owner' },
      };
    }
    return { status: 'completed', result: 'done', history: [], budget: null };
  };

  const store = createMemoryStore();
  const cp = testCheckpoint();
  const jobs = createInProcessJobs({
    checkpoint: cp,
    store, runJob, config: BASE, logger: { warn() {}, info() {} }, humanInput: { enabled: true },
  });
  await jobs.start();

  const { jobId } = await jobs.submit({ goal: 'book' }, { metadata: { identity: { personId: 'person-owner' } } });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');
  const owner = (await cp.load(`cp-${jobId}`)).checkpoint.identity;
  assert.equal(owner.personId, 'person-owner', 'identity lives in the checkpoint now');

  const res = await jobs.provideInput(jobId,
    { batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' } },
    { identity: { personId: 'person-somebody-else' } });
  assert.equal(res.code, 'not_your_job');
  assert.equal(res.status, 403);

  await jobs.stop({ drainMs: 0 });
});

// ---------------------------------------------------------------------------
// Cancel and expiry
// ---------------------------------------------------------------------------

test('cancel: cancelling while waiting is immediate - nothing is running', async () => {
  // No abort signal, no force-settle timer, no grace period.
  const { jobs, published } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');

  const res = await jobs.cancel(jobId);
  assert.deepEqual(res, { ok: true, status: 'cancelled' });

  const record = await jobs.get(jobId);
  assert.equal(record.status, 'cancelled');
  assert.equal(record.pendingInput, null);

  const event = published.find(e => e.type === 'input_resolved');
  assert.equal(event.resolution, 'cancelled');
  assert.equal(event.batchId, parked.pendingInput.batchId);

  await jobs.stop({ drainMs: 0 });
});

test('cancel: answering a cancelled job is refused', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');
  await jobs.cancel(jobId);

  const res = await jobs.provideInput(jobId, { batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' } });
  assert.equal(res.ok, false);
  assert.equal(res.jobStatus, 'cancelled');

  await jobs.stop({ drainMs: 0 });
});

test('expiry: an unanswered question past its deadline settles the run as refused', async () => {
  // An expiry is not an answer. Nothing was approved, so nothing gated on the
  // question goes ahead.
  const runJob = async (task, { askUser }) => {
    try {
      await askUser({ questions: approvalQuestions });
    } catch (err) {
      return {
        status: 'paused', batchId: err.batch.batchId,
        // Already expired when it is written.
        batch: { ...err.batch, expiresAt: new Date(Date.now() - 1000).toISOString() },
        history: [], budget: null, progress: { observations: [], plan: null },
      };
    }
    return { status: 'completed', result: 'done', history: [], budget: null };
  };

  const { jobs, published } = await setup({ runner: { runJob } });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  await waitForStatus(jobs, jobId, 'waiting_input');

  const res = await jobs.expireInput(jobId);
  assert.equal(res.ok, true);

  const record = await jobs.get(jobId);
  assert.equal(record.status, 'failed');
  assert.equal(record.error.code, 'input_expired');

  const history = await jobs.events(jobId);
  assert.ok(history.some(e => e.type === 'question_expired'), 'history keeps the fact it expired');
  assert.equal(published.find(e => e.type === 'input_resolved').resolution, 'timeout');

  await jobs.stop({ drainMs: 0 });
});

test('expiry: a question still inside its window is left alone', async () => {
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  await waitForStatus(jobs, jobId, 'waiting_input');

  const res = await jobs.expireInput(jobId);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not_expired');
  assert.equal((await jobs.get(jobId)).status, 'waiting_input');

  await jobs.stop({ drainMs: 0 });
});

test('expiry: answering an expired batch is refused with its own code', async () => {
  const { jobs, store } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');

  await store.update(jobId, {
    pendingInput: { ...parked.pendingInput, expiresAt: new Date(Date.now() - 1000).toISOString() },
  });

  const res = await jobs.provideInput(jobId, { batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' } });
  assert.equal(res.code, 'batch_expired');
  assert.equal(res.status, 410);

  await jobs.stop({ drainMs: 0 });
});

// ---------------------------------------------------------------------------
// Off by default
// ---------------------------------------------------------------------------

test('disabled: with humanInput off, runJob is given no askUser at all', async () => {
  const runner = makeAskingRunner();
  const { jobs } = await setup({ runner, humanInput: null });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });

  // The runner calls askUser unconditionally, so with none supplied it throws
  // and the job fails - which is the honest result of asking for a facility
  // that is switched off.
  await waitForStatus(jobs, jobId, 'failed');
  assert.equal(runner.calls[0].hasAskUser, false);

  await jobs.stop({ drainMs: 0 });
});

test('disabled: an ordinary run is untouched by the feature being present', async () => {
  const runJob = async () => ({ status: 'completed', result: 'ok', history: [], budget: null });
  const { jobs } = await setup({ runner: { runJob }, humanInput: null });
  const { jobId } = await jobs.submit({ goal: 'just do it' });

  const record = await waitForStatus(jobs, jobId, 'completed');
  assert.equal(record.result, 'ok');
  assert.equal(record.pendingInput, null);
  assert.equal(record.pendingBatchId, null);

  await jobs.stop({ drainMs: 0 });
});

// ---------------------------------------------------------------------------
// pendingInput
// ---------------------------------------------------------------------------

test('pendingInput: reports the batch, and whether it has gone stale', async () => {
  const { jobs, store } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');

  const fresh = await jobs.pendingInput(jobId);
  assert.equal(fresh.batchId, parked.pendingInput.batchId);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.expired, false);

  await store.update(jobId, {
    pendingInput: { ...parked.pendingInput, staleAfter: new Date(Date.now() - 1000).toISOString() },
  });
  const old = await jobs.pendingInput(jobId);
  assert.equal(old.stale, true);
  assert.equal(old.expired, false, 'stale is soft and does not imply expired');

  await jobs.stop({ drainMs: 0 });
});

test('pendingInput: null for a job with no question outstanding', async () => {
  const runJob = async () => ({ status: 'completed', result: 'ok', history: [], budget: null });
  const { jobs } = await setup({ runner: { runJob } });
  const { jobId } = await jobs.submit({ goal: 'go' });
  await waitForStatus(jobs, jobId, 'completed');
  assert.equal(await jobs.pendingInput(jobId), null);
  await jobs.stop({ drainMs: 0 });
});

test('pendingInput: a batch validates as a batch', async () => {
  // Guards against the record and the wire shape drifting apart.
  const { jobs } = await setup({ runner: makeAskingRunner() });
  const { jobId } = await jobs.submit({ goal: 'book a flight' });
  const parked = await waitForStatus(jobs, jobId, 'waiting_input');

  const rebuilt = createBatch({
    jobId,
    askedBy: parked.pendingInput.askedBy,
    questions: parked.pendingInput.questions,
    batchId: parked.pendingInput.batchId,
  });
  assert.deepEqual(Object.keys(rebuilt).sort(), Object.keys(parked.pendingInput).sort());

  await jobs.stop({ drainMs: 0 });
});
