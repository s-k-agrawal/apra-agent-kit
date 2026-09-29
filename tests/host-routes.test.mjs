import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRoutes } = await import('../host/routes.mjs');
const { JobQueueFullError, JobsClosedError, InvalidCallbackUrlError } = await import('../host/jobs/interface.mjs');

function fakeJobs(overrides = {}) {
  return {
    submit: async (task, opts) => ({ jobId: 'job-1', status: 'queued', position: 1 }),
    get: async (id) => (id === 'job-1' ? { id, status: 'processing' } : null),
    cancel: async (id) => (id === 'job-1' ? { ok: true, status: 'cancelling' } : { ok: false, status: null }),
    ...overrides,
  };
}
const req = (over = {}) => ({ method: 'POST', path: '/task', params: {}, query: {}, headers: {}, body: { goal: 'g' }, signal: undefined, user: { id: 'u' }, ...over });

test('POST /task returns 202 with links when dispatch is enabled', async () => {
  const routes = buildRoutes({ jobs: fakeJobs(), notifier: { sseHandler: async () => ({ status: 200 }) }, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  const res = await routes.task.handler(req());
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { jobId: 'job-1', status: 'queued', position: 1, links: { self: '/jobs/job-1', events: '/jobs/job-1/events' } });
});

test('POST /task?wait=true runs synchronously with the Phase 2 shape', async () => {
  const routes = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async (t) => ({ taskId: 't-1', status: 'completed', result: t.goal, history: [], budget: null }), mcpRaw: () => {}, runLoopEnabled: true });
  const res = await routes.task.handler(req({ query: { wait: 'true' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { taskId: 't-1', status: 'completed', result: 'g', history: [], budget: null });
});

test('POST /task with dispatch disabled behaves like wait=true; dispatch_failed → 503', async () => {
  const routes = buildRoutes({ jobs: null, notifier: null, runSync: async () => ({ taskId: 't', status: 'failed', result: { error: 'dispatch_failed', message: 'busy' } }), mcpRaw: () => {}, runLoopEnabled: true });
  const res = await routes.task.handler(req());
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { ok: false, error: 'dispatch_failed', message: 'busy' });
});

test('POST /task error mapping: 429 queue_full with Retry-After, 400 bad callback, 503 shutting down, 400 missing goal', async () => {
  const mk = (err) => buildRoutes({ jobs: fakeJobs({ submit: async () => { throw err; } }), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  const full = await mk(new JobQueueFullError()).task.handler(req());
  assert.equal(full.status, 429); assert.equal(full.headers['retry-after'], '30'); assert.equal(full.body.error, 'queue_full');
  const bad = await mk(new InvalidCallbackUrlError('nope')).task.handler(req());
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'invalid_callback_url');
  const closed = await mk(new JobsClosedError()).task.handler(req());
  assert.equal(closed.status, 503); assert.equal(closed.body.error, 'shutting_down');
  const routes = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  const missing = await routes.task.handler(req({ body: {} }));
  assert.equal(missing.status, 400); assert.equal(missing.body.error, 'invalid_task');
});

test('GET /jobs/:id → 200 or 404; DELETE → 202 cancelling, 200 cancelled, 409 terminal, 404', async () => {
  const jobs = fakeJobs({
    cancel: async (id) => ({ 'job-1': { ok: true, status: 'cancelling' }, 'job-q': { ok: true, status: 'cancelled' }, 'job-d': { ok: false, status: 'completed' } }[id] ?? { ok: false, status: null }),
  });
  const routes = buildRoutes({ jobs, notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  assert.equal((await routes.jobGet.handler(req({ method: 'GET', params: { id: 'job-1' } }))).status, 200);
  assert.equal((await routes.jobGet.handler(req({ method: 'GET', params: { id: 'zzz' } }))).status, 404);
  const c1 = await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'job-1' } }));
  assert.equal(c1.status, 202); assert.deepEqual(c1.body, { ok: true, status: 'cancelling' });
  assert.equal((await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'job-q' } }))).status, 200);
  assert.equal((await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'job-d' } }))).status, 409);
  assert.equal((await routes.jobCancel.handler(req({ method: 'DELETE', params: { id: 'nope' } }))).status, 404);
});

test('route table shape: task absent without runLoop; job routes absent without jobs; events absent without sse', async () => {
  const none = buildRoutes({ jobs: null, notifier: null, runSync: null, mcpRaw: () => {}, runLoopEnabled: false });
  assert.equal(none.task, null); assert.equal(none.jobGet, null); assert.equal(none.jobEvents, null);
  assert.equal(none.health.auth, false); assert.equal(none.mcp.raw, true);
  const some = buildRoutes({ jobs: fakeJobs(), notifier: { sseHandler: null }, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  assert.equal(some.jobGet.method, 'GET'); assert.equal(some.jobGet.path, '/jobs/:id');
  assert.equal(some.jobCancel.method, 'DELETE'); assert.equal(some.jobEvents, null);
});

test('buildRoutes mounts chat routes only when given', async () => {
  const base = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  assert.equal(base.chatPage, null); assert.equal(base.chatScript, null);
  const chatPage = { method: 'GET', path: '/chat', auth: false, handler: async () => ({ status: 200, text: 'x' }) };
  const chatScript = { method: 'GET', path: '/chat/app.mjs', auth: false, handler: async () => ({ status: 200, text: 'y' }) };
  const withChat = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true, chatRoutes: { chatPage, chatScript } });
  assert.equal(withChat.chatPage, chatPage); assert.equal(withChat.chatScript, chatScript);
  assert.deepEqual(Object.keys(withChat), [
    'health', 'kit', 'mcp', 'task', 'jobGet', 'jobCancel', 'jobEvents', 'jobInput',
    'chatPage', 'chatScript',
    'memoryStore', 'memoryQuery', 'memoryGet', 'memoryUpdate', 'memoryPromote', 'memoryRemove',
  ]);
});

test('buildRoutes mounts memory routes only when given', async () => {
  const base = buildRoutes({ jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true });
  assert.equal(base.memoryStore, null);
  assert.equal(base.memoryQuery, null);
  assert.equal(base.memoryGet, null);
  assert.equal(base.memoryUpdate, null);
  assert.equal(base.memoryPromote, null);
  assert.equal(base.memoryRemove, null);

  const memoryStore = { method: 'POST', path: '/memory', handler: async () => ({ status: 201 }) };
  const memoryQuery = { method: 'GET', path: '/memory', handler: async () => ({ status: 200 }) };
  const memoryGet = { method: 'GET', path: '/memory/:id', handler: async () => ({ status: 200 }) };
  const memoryUpdate = { method: 'PATCH', path: '/memory/:id', handler: async () => ({ status: 200 }) };
  const memoryPromote = { method: 'PATCH', path: '/memory/:id/promote', handler: async () => ({ status: 200 }) };
  const memoryRemove = { method: 'DELETE', path: '/memory/:id', handler: async () => ({ status: 200 }) };
  const withMemory = buildRoutes({
    jobs: fakeJobs(), notifier: null, runSync: async () => ({}), mcpRaw: () => {}, runLoopEnabled: true,
    memoryRoutes: { memoryStore, memoryQuery, memoryGet, memoryUpdate, memoryPromote, memoryRemove },
  });
  assert.equal(withMemory.memoryStore, memoryStore);
  assert.equal(withMemory.memoryQuery, memoryQuery);
  assert.equal(withMemory.memoryGet, memoryGet);
  assert.equal(withMemory.memoryUpdate, memoryUpdate);
  assert.equal(withMemory.memoryPromote, memoryPromote);
  assert.equal(withMemory.memoryRemove, memoryRemove);
});
