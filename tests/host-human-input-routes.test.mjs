// tests/host-human-input-routes.test.mjs
//
// The wire contract for answering a question, and the status code each
// refusal maps to. The codes matter: a client has to tell "your answer was
// wrong" from "somebody already answered" from "you took too long", and each
// calls for a different thing on screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRoutes } = await import('../host/routes.mjs');
const { REFUSALS } = await import('../host/human-input/resume.mjs');
const { jobTools } = await import('../host/tools/jobs-tools.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');

const aBatch = {
  batchId: 'inp-a3f19c284d61',
  jobId: 'job-1',
  askedBy: 'guardrail',
  questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?', required: true }],
  askedAt: '2026-09-24T09:00:00.000Z',
  staleAfter: '2026-09-25T09:00:00.000Z',
  expiresAt: '2026-10-01T09:00:00.000Z',
  stale: false,
  expired: false,
};

function fakeJobs(overrides = {}) {
  return {
    submit: async () => ({ jobId: 'job-1', status: 'queued', position: 1 }),
    get: async (id) => (id === 'job-1' ? { id, status: 'waiting_input' } : null),
    cancel: async () => ({ ok: true, status: 'cancelling' }),
    pendingInput: async (id) => (id === 'job-1' ? aBatch : null),
    provideInput: async () => ({ ok: true, status: 'queued', stale: false, batchId: aBatch.batchId }),
    expireInput: async () => ({ ok: true, status: 'failed' }),
    ...overrides,
  };
}

const build = (jobs) => buildRoutes({
  jobs, notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true,
});

const req = (over = {}) => ({
  method: 'POST', path: '/jobs/job-1/input', params: { id: 'job-1' }, query: {}, headers: {},
  body: { batchId: aBatch.batchId, answers: { proceed: 'approve' } },
  user: { id: 'person-6f2a' }, ...over,
});

// ---------------------------------------------------------------------------
// Route inventory
// ---------------------------------------------------------------------------

test('routes: the input route is mounted when the backend supports it', () => {
  const routes = build(fakeJobs());
  assert.equal(routes.jobInput.method, 'POST');
  assert.equal(routes.jobInput.path, '/jobs/:id/input');
});

test('routes: a backend without human input mounts no input route', () => {
  // The kit is cloned and edited. A backend an adopter wrote before this
  // feature existed must keep working, and must not advertise a route that
  // would 500 on the first call.
  const routes = build({ submit: async () => {}, get: async () => null, cancel: async () => ({}) });
  assert.equal(routes.jobInput, null);
});

test('routes: no jobs backend means no input route', () => {
  const routes = buildRoutes({ jobs: null, notifier: null, runSync: null, mcpRaw: () => {}, runLoopEnabled: false });
  assert.equal(routes.jobInput, null);
});

// ---------------------------------------------------------------------------
// GET /jobs/:id
// ---------------------------------------------------------------------------

test('GET: a waiting job carries its pending question and its staleness', async () => {
  const res = await build(fakeJobs()).jobGet.handler(req({ method: 'GET' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.pendingInput.batchId, aBatch.batchId);
  assert.equal(res.body.stale, false);
  assert.equal(res.body.status, 'waiting_input');
});

test('GET: a job with nothing outstanding reports pendingInput null', async () => {
  const jobs = fakeJobs({ get: async (id) => ({ id, status: 'completed' }), pendingInput: async () => null });
  const res = await build(jobs).jobGet.handler(req({ method: 'GET' }));
  assert.equal(res.body.pendingInput, null);
  assert.equal(res.body.stale, false);
});

test('GET: a stale question is reported as stale but still answerable', async () => {
  const jobs = fakeJobs({ pendingInput: async () => ({ ...aBatch, stale: true }) });
  const res = await build(jobs).jobGet.handler(req({ method: 'GET' }));
  assert.equal(res.body.stale, true);
  assert.ok(res.body.pendingInput, 'the form is still there to answer');
});

test('GET: a missing job is still 404', async () => {
  const res = await build(fakeJobs()).jobGet.handler(req({ method: 'GET', params: { id: 'zzz' } }));
  assert.equal(res.status, 404);
});

test('GET: a backend without human input returns the record unchanged', async () => {
  const jobs = { submit: async () => {}, get: async (id) => ({ id, status: 'processing' }), cancel: async () => ({}) };
  const res = await build(jobs).jobGet.handler(req({ method: 'GET' }));
  assert.deepEqual(res.body, { id: 'job-1', status: 'processing' }, 'no keys are added');
});

// ---------------------------------------------------------------------------
// POST /jobs/:id/input
// ---------------------------------------------------------------------------

test('POST: a good answer is 200 and says what happened to the job', async () => {
  const res = await build(fakeJobs()).jobInput.handler(req());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, status: 'queued', stale: false, batchId: aBatch.batchId });
});

test('POST: a missing batchId is rejected before the backend is touched', async () => {
  let called = false;
  const jobs = fakeJobs({ provideInput: async () => { called = true; return { ok: true }; } });
  const res = await build(jobs).jobInput.handler(req({ body: { answers: {} } }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
  assert.equal(res.body.fields.batchId, 'required');
  assert.equal(called, false);
});

test('POST: every refusal code maps to the status the backend chose', async () => {
  // The code and its status travel together, so a new refusal cannot be added
  // without someone deciding what it means over the wire.
  for (const [code, status] of Object.entries(REFUSALS)) {
    const jobs = fakeJobs({ provideInput: async () => ({ ok: false, code, status }) });
    const res = await build(jobs).jobInput.handler(req());
    assert.equal(res.status, status, `${code} should be ${status}`);
    assert.equal(res.body.error, code);
    assert.equal(res.body.ok, false);
  }
});

test('POST: 400 carries the per-field reasons so a form can show them', async () => {
  const jobs = fakeJobs({
    provideInput: async () => ({ ok: false, code: 'validation_failed', status: 400, fields: { proceed: 'expected_approve_or_deny: maybe' } }),
  });
  const res = await build(jobs).jobInput.handler(req());
  assert.equal(res.status, 400);
  assert.equal(res.body.fields.proceed, 'expected_approve_or_deny: maybe');
});

test('POST: 409 on a mismatched batch names both ids', async () => {
  const jobs = fakeJobs({
    provideInput: async () => ({ ok: false, code: 'batch_mismatch', status: 409, expected: 'inp-aaa', received: 'inp-bbb' }),
  });
  const res = await build(jobs).jobInput.handler(req());
  assert.equal(res.status, 409);
  assert.equal(res.body.expected, 'inp-aaa');
  assert.equal(res.body.received, 'inp-bbb');
});

test('POST: 410 on an expired batch says when it expired', async () => {
  const jobs = fakeJobs({
    provideInput: async () => ({ ok: false, code: 'batch_expired', status: 410, expiresAt: aBatch.expiresAt }),
  });
  const res = await build(jobs).jobInput.handler(req());
  assert.equal(res.status, 410);
  assert.equal(res.body.expiresAt, aBatch.expiresAt);
});

test('POST: 404 when the job does not exist', async () => {
  const jobs = fakeJobs({ provideInput: async () => ({ ok: false, code: 'not_found', status: 404 }) });
  assert.equal((await build(jobs).jobInput.handler(req())).status, 404);
});

test('POST: the refusal body never leaks the internal ok flag twice', async () => {
  const jobs = fakeJobs({ provideInput: async () => ({ ok: false, code: 'not_waiting', status: 409, jobStatus: 'completed' }) });
  const res = await build(jobs).jobInput.handler(req());
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, undefined, 'the code is reported as `error`, once');
  assert.equal(res.body.status, undefined, 'the HTTP status is not also a body field');
  assert.equal(res.body.jobStatus, 'completed');
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('POST: the answer is attributed to the authenticated caller, not the body', async () => {
  // A batch id is not a capability, and a body field claiming to be somebody
  // is not evidence of being them.
  let seen = null;
  const jobs = fakeJobs({
    provideInput: async (id, submission, opts) => { seen = opts; return { ok: true, status: 'queued' }; },
  });
  await build(jobs).jobInput.handler(req({
    body: { batchId: aBatch.batchId, answers: { proceed: 'approve' }, answeredBy: 'person-somebody-else' },
    user: { id: 'person-6f2a' },
  }));
  assert.deepEqual(seen.identity, { personId: 'person-6f2a' });
});

test('POST: an unauthenticated caller passes no identity rather than a forged one', async () => {
  let seen = null;
  const jobs = fakeJobs({
    provideInput: async (id, submission, opts) => { seen = opts; return { ok: true, status: 'queued' }; },
  });
  await build(jobs).jobInput.handler(req({ user: null }));
  assert.equal(seen.identity, null);
});

// ---------------------------------------------------------------------------
// The MCP tool
// ---------------------------------------------------------------------------

test('mcp: job-input exists and mirrors the route', () => {
  const tool = jobTools.find(t => t.name === 'job-input');
  assert.ok(tool);
  assert.equal(tool.inputSchema.safeParse({ jobId: 'job-1', batchId: 'inp-1', answers: { proceed: 'approve' } }).success, true);
  assert.equal(tool.inputSchema.safeParse({ jobId: 'job-1', answers: {} }).success, false, 'batchId is required');
});

test('mcp: job-input is reversible - an approval must not need its own approval', () => {
  // Answering is not itself a mutation. Marking it irreversible would gate it
  // behind the very approval flow it exists to serve.
  const tool = jobTools.find(t => t.name === 'job-input');
  assert.equal(tool.reversible, true);
});

test('mcp: job-input passes the submission through and reports the refusal', async () => {
  const tool = jobTools.find(t => t.name === 'job-input');
  let seen = null;
  const out = await tool.run({
    args: { jobId: 'job-1', batchId: 'inp-1', answers: { proceed: 'approve' } },
    jobs: { provideInput: async (id, submission, opts) => { seen = { id, submission, opts }; return { ok: false, code: 'not_waiting' }; } },
    identity: { personId: 'person-6f2a' },
  });
  assert.equal(seen.id, 'job-1');
  assert.deepEqual(seen.submission, { batchId: 'inp-1', answers: { proceed: 'approve' } });
  assert.deepEqual(seen.opts.identity, { personId: 'person-6f2a' });
  assert.equal(out.code, 'not_waiting');
});

test('mcp: job-input says so rather than throwing on a backend that cannot do it', async () => {
  const tool = jobTools.find(t => t.name === 'job-input');
  const out = await tool.run({ args: { jobId: 'job-1', batchId: 'inp-1', answers: {} }, jobs: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_supported');
});

test('mcp: job-input survives extendRegistry with its declared fields intact', () => {
  const registered = extendRegistry(jobTools).find(t => t.name === 'job-input');
  assert.equal(registered.reversible, true);
  assert.equal(registered.retryable, false);
  assert.deepEqual(registered.tags, ['jobs']);
});

test('mcp: a tool may declare an undo without extendRegistry stripping it', () => {
  // The reversal work in a later task reads this off the registry. Asserting
  // it now means that task does not discover the field was dropped.
  const [registered] = extendRegistry([{
    name: 'book', reversible: false, run: async () => 'ok',
    undo: { mandatory: true, run: async () => 'cancelled', describe: () => 'cancel the booking' },
  }]);
  assert.equal(registered.undo.mandatory, true);
  assert.equal(typeof registered.undo.run, 'function');
  assert.equal(typeof registered.undo.describe, 'function');
});

// ---------------------------------------------------------------------------
// A batch id is not a capability
//
// The refusal below was passing its test while being unreachable in production.
// `planResume` reads the owner from `metadata.identity`, and the submit route
// wrote `metadata.user` — a bare string under a different key. So `owner` was
// structurally always null, the `if (owner && ...)` guard never fired, and
// anyone who could reach POST /jobs/:id/input with a batch id could answer
// somebody else's approval. The test that "covered" it set a field production
// never set.
// ---------------------------------------------------------------------------

test('submitting records who the run is for, in the shape the refusal reads', async () => {
  let seen = null;
  const jobs = {
    async submit(task, opts) { seen = opts.metadata; return { jobId: 'job-9', status: 'queued' }; },
  };
  const routes = build(jobs);
  await routes.task.handler({
    body: { goal: 'Book a flight' }, query: {}, headers: {}, params: {},
    user: { id: 'alice' },
  });

  // The exact path planResume and park() read: metadata.identity.personId.
  assert.equal(seen.identity?.personId, 'alice');
});

test('an anonymous submit records no owner, and does not invent one', async () => {
  // A host with no authentication must keep working. What it must not do is
  // fabricate an owner, which would lock the run to a person who does not exist.
  let seen = null;
  const jobs = { async submit(task, opts) { seen = opts.metadata; return { jobId: 'job-9', status: 'queued' }; } };
  await build(jobs).task.handler({ body: { goal: 'Book a flight' }, query: {}, headers: {}, params: {}, user: null });
  assert.equal(seen.identity, null);
});

test('a stranger cannot answer a question asked of somebody else', async () => {
  // End to end over the two halves that have to agree: the metadata the submit
  // route writes, and the owner planResume reads back out of it.
  let submitted = null;
  await build({ async submit(t, o) { submitted = o.metadata; return { jobId: 'job-1', status: 'queued' }; } })
    .task.handler({ body: { goal: 'Book a flight' }, query: {}, headers: {}, params: {}, user: { id: 'alice' } });

  const { planResume } = await import('../host/human-input/resume.mjs');
  const record = { id: 'job-1', status: 'waiting_input', pendingInput: aBatch, metadata: submitted };

  const mallory = planResume(record, { batchId: aBatch.batchId, answers: { proceed: 'approve' } },
    { history: [], identity: { personId: 'mallory' }, now: new Date('2026-09-24T10:00:00.000Z') });
  assert.equal(mallory.ok, false);
  assert.equal(mallory.code, 'not_your_job');
  assert.equal(mallory.status, REFUSALS.not_your_job, '403, not a 404 that hides whether the job exists');

  const alice = planResume(record, { batchId: aBatch.batchId, answers: { proceed: 'approve' } },
    { history: [], identity: { personId: 'alice' }, now: new Date('2026-09-24T10:00:00.000Z') });
  assert.equal(alice.ok, true, 'the person it was asked of is still let through');
});
