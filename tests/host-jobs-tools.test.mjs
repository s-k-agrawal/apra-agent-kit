// tests/host-jobs-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { jobTools, withJobTools } = await import('../host/tools/registry.mjs');

const fakeJobs = {
  submit: async (task, opts) => ({ jobId: 'job-9', status: 'queued', position: 1, _task: task, _opts: opts }),
  get: async (id) => (id === 'job-9' ? { id, status: 'completed', result: 42 } : null),
};

test('withJobTools appends the job tools only when jobs is present', () => {
  const base = [{ name: 'weather', tags: [] }];
  assert.equal(withJobTools(base, null).length, 1);
  const out = withJobTools(base, fakeJobs);
  assert.deepEqual(out.map(t => t.name), ['weather', 'submit-task', 'job-input', 'job-status']);
  for (const t of out.slice(1)) { assert.deepEqual(t.tags, ['jobs']); assert.equal(t.reversible, true); assert.ok(t.inputSchema); }
});

test('submit-task validates input and forwards callbackUrl', async () => {
  const tool = jobTools.find(t => t.name === 'submit-task');
  assert.equal(tool.inputSchema.safeParse({}).success, false);
  const out = await tool.run({ args: { goal: 'g', inputs: { a: 1 }, callbackUrl: 'https://cb.test/h' }, jobs: fakeJobs });
  assert.equal(out.jobId, 'job-9');
  assert.deepEqual(out._task, { goal: 'g', inputs: { a: 1 } });
  assert.equal(out._opts.callbackUrl, 'https://cb.test/h');
});

test('job-status returns the record or a not_found value', async () => {
  const tool = jobTools.find(t => t.name === 'job-status');
  assert.equal((await tool.run({ args: { jobId: 'job-9' }, jobs: fakeJobs })).result, 42);
  assert.deepEqual(await tool.run({ args: { jobId: 'zzz' }, jobs: fakeJobs }), { ok: false, error: 'not_found', jobId: 'zzz' });
});

test('hosted run-loop executeTool passes jobs to submit-task and does not tool_error', async () => {
  const { createMockFleetApi, rosterNames } = await import('./helpers/mock-fleet.mjs');
  const { runTask } = await import('../host/run-loop.mjs');
  const { executeHostedTask } = await import('../host/tasks.mjs');
  const { WorkerDispatcher } = await import('../pool/worker-dispatcher.mjs');
  const { WorkerPool } = await import('../pool/worker-pool.mjs');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  let submitted;
  const jobs = {
    submit: async (task, opts) => {
      submitted = { task, opts };
      return { jobId: 'job-hosted', status: 'queued', position: 1 };
    },
    get: async () => null,
  };
  const tools = withJobTools([], jobs);
  const promptResponses = [
    '```tool_call\n{"tool": "submit-task", "args": {"goal": "nested-work"}}\n```',
    '```done\n{"result": "delegated", "summary": "ok"}\n```',
  ];

  const loopOut = await runTask(
    { id: 't-outer', goal: 'delegate work' },
    {
      strategy: 'open-ended',
      tools,
      fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses }),
      jobs,
    },
  );
  assert.equal(loopOut.status, 'completed');
  const loopObs = loopOut.history.find(o => o.tool === 'submit-task');
  assert.ok(loopObs, 'expected submit-task observation from runTask');
  assert.notEqual(loopObs.error, 'tool_error', loopObs.message);
  assert.equal(loopObs.result.ok, true);
  assert.equal(loopObs.result.result.jobId, 'job-hosted');
  assert.equal(submitted.task.goal, 'nested-work');

  submitted = undefined;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-tools-hosted-'));
  const dispatcher = new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
  try {
    const hostedOut = await executeHostedTask({ goal: 'delegate work' }, {
      api: createMockFleetApi({ members: rosterNames(1), promptResponses }),
      activeDispatcher: dispatcher,
      toolRegistry: tools,
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      jobs,
    });
    assert.equal(hostedOut.status, 'completed');
    const hostedObs = hostedOut.history.find(o => o.tool === 'submit-task');
    assert.ok(hostedObs, 'expected submit-task observation from executeHostedTask');
    assert.notEqual(hostedObs.error, 'tool_error', hostedObs.message);
    assert.equal(hostedObs.result.ok, true);
    assert.equal(hostedObs.result.result.jobId, 'job-hosted');
    assert.equal(submitted.task.goal, 'nested-work');
  } finally {
    await dispatcher.close();
  }
});
