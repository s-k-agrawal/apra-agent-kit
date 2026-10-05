// tests/comm-azure-activity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames, withRouterBypass } from './helpers/mock-fleet.mjs';

const { createRunTaskActivity, setHostContextFactory, getHostContext } = await import('../comm/azure-functions/activity.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}
function fakeClient({ cancelAfterPolls = Infinity } = {}) {
  const calls = { raiseEvent: [], getStatus: 0 };
  return {
    calls,
    async raiseEvent(id, name, data) { calls.raiseEvent.push({ id, name, data }); },
    async getStatus() { calls.getStatus += 1; return { customStatus: { cancelRequested: calls.getStatus > cancelAfterPolls } }; },
  };
}
function hostCtx(api, dispatcher, extra = {}) {
  return { api, activeDispatcher: dispatcher, toolRegistry: extendRegistry(), runLoopConfig: { strategy: 'open-ended' }, budgetsConfig: null, guardrailsMod: null, notifier: null, ...extra };
}

test('activity emits progress+settled via jobs.emitEvent, posts webhook, returns the result', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```tool_call\n{"tool": "inspect-members", "args": {}}\n```', '```done\n{"result": "done", "summary": "s"}\n```'],
  });
  const dispatcher = await makeDispatcher();
  const client = fakeClient();
  const published = [];
  const emitted = [];
  const notifier = { publish: async (event, ctx) => { published.push({ event, ctx }); } };
  const jobs = { emitEvent: (jobId, event) => emitted.push({ jobId, event }) };
  try {
    const activity = createRunTaskActivity({ getClient: () => client, pollMs: 50, getContext: async () => hostCtx(api, dispatcher, { notifier, jobs }) });
    const out = await activity({ jobId: 'job-1', task: { goal: 'inspect' }, callbackUrl: 'https://cb.test/h' }, { warn() {} });
    assert.equal(out.status, 'completed');
    assert.equal(out.result, 'done');
    assert.equal(out.history, undefined, 'history stripped from durable return');
    assert.equal(out.budget, undefined, 'budget stripped from durable return');
    assert.equal(client.calls.raiseEvent.length, 0, 'no raiseEvent calls');
    const progress = emitted.filter(e => e.event.type === 'progress');
    assert.ok(progress.length >= 1, 'at least one progress event emitted');
    assert.equal(progress[0].jobId, 'job-1');
    const settled = emitted.filter(e => e.event.type === 'settled');
    assert.equal(settled.length, 1, 'exactly one settled event emitted');
    assert.equal(settled[0].event.status, 'completed');
    assert.equal(published.length, 1);
    assert.equal(published[0].event.type, 'settled');
    assert.equal(published[0].ctx.callbackUrl, 'https://cb.test/h');
  } finally { await dispatcher.close(); }
});

test('activity aborts when customStatus.cancelRequested appears and settles cancelled', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return '```tool_call\n{"tool": "inspect-members", "args": {}}\n```';
    },
  });
  const dispatcher = await makeDispatcher();
  const client = fakeClient({ cancelAfterPolls: 1 });
  try {
    const activity = createRunTaskActivity({ getClient: () => client, pollMs: 30, getContext: async () => hostCtx(api, dispatcher) });
    const start = Date.now();
    const out = await activity({ jobId: 'job-2', task: { goal: 'slow' }, callbackUrl: null }, { warn() {} });
    const elapsed = Date.now() - start;
    assert.equal(out.status, 'cancelled');
    assert.ok(elapsed < 500, `expected cancel without waiting for hung prompt (${elapsed}ms)`);
    await new Promise((r) => setTimeout(r, 2100));
  } finally { await dispatcher.close(); }
});

test('activity returns failed / dispatch_failed as a value when no lease is available', async () => {
  const api = createMockFleetApi({ members: rosterNames(1) });
  const dispatcher = await makeDispatcher();
  dispatcher.dispatch = async () => { throw new Error('queue overflow'); };
  try {
    const activity = createRunTaskActivity({ getClient: () => fakeClient(), pollMs: 50, getContext: async () => hostCtx(api, dispatcher) });
    const out = await activity({ jobId: 'job-3', task: { goal: 'x' }, callbackUrl: null }, { warn() {} });
    assert.equal(out.status, 'failed');
    assert.equal(out.error.code, 'dispatch_failed');
  } finally { await dispatcher.close(); }
});

test('activity issues a classifier prompt when hostCtx.routerConfig is enabled', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: withRouterBypass([
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "done", "summary": "s"}\n```',
    ]),
  });
  const dispatcher = await makeDispatcher();
  try {
    const activity = createRunTaskActivity({
      getClient: () => fakeClient(),
      pollMs: 50,
      getContext: async () => hostCtx(api, dispatcher, {
        routerConfig: { enabled: true, fallbackStrategy: 'open-ended' },
      }),
    });
    const out = await activity({ jobId: 'job-router', task: { goal: 'inspect' }, callbackUrl: null }, { warn() {} });
    const classifierCalls = api.promptCalls.filter(c => c.prompt?.includes('task router'));
    assert.ok(classifierCalls.length >= 1, 'classifier "task router" prompt should be issued when routerConfig is enabled');
    assert.equal(out.status, 'completed');
    if (out.routedTo !== undefined) {
      assert.ok(typeof out.routedTo === 'string' && out.routedTo.length > 0, 'routedTo should be present on the settled result');
    }
  } finally { await dispatcher.close(); }
});

test('getHostContext memoises the factory and throws before one is set', async () => {
  setHostContextFactory(null);
  await assert.rejects(() => getHostContext(), /host context factory/);
  let calls = 0;
  setHostContextFactory(async () => { calls += 1; return { api: 'a' }; });
  assert.equal((await getHostContext()).api, 'a');
  await getHostContext();
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// The run on Azure gets a checkpoint, not just a place to write one at a pause
//
// The activity built a checkpoint only to save the pause, and never handed one
// to executeHostedTask. So on Azure the strategies had nothing to save to as
// they went and nothing to load on resume: the checkpoint was write-only, and
// `hasIdempotencyKey` could never be true. The 16 KB pointer was a pointer to
// a row nobody read.
// ---------------------------------------------------------------------------

test('the activity gives the run a checkpoint, so work is recorded as it happens', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```tool_call\n{"tool": "inspect-members", "args": {}}\n```', '```done\n{"result": "done", "summary": "s"}\n```'],
  });
  const dispatcher = await makeDispatcher();
  const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-cp-'));
  const inner = createSqliteStore({ dbPath: path.join(dir, 'memory.db') });

  // Count what the run writes, through a real store underneath.
  let saves = 0;
  const checkpointStore = {
    ...inner,
    open: () => inner.open(),
    close: () => inner.close(),
    store: async (entry) => { saves += 1; return inner.store(entry); },
  };
  await checkpointStore.open();

  try {
    const activity = createRunTaskActivity({
      getClient: () => fakeClient(), pollMs: 50,
      getContext: async () => hostCtx(api, dispatcher, { memory: { checkpointStore } }),
    });
    const out = await activity({ jobId: 'job-cp', task: { goal: 'inspect' }, callbackUrl: null }, { warn() {} });
    assert.equal(out.status, 'completed');
    assert.ok(saves >= 1, `the run saved a checkpoint as it went (saw ${saves})`);
  } finally {
    await checkpointStore.close();
    await dispatcher.close();
  }
});
