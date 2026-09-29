// tests/host-human-input-durable-cycle.test.mjs
//
// The Durable pause-and-resume cycle, with the three real modules wired
// together: the real activity, the real orchestrator generator, and the real
// `createDurableJobs`. Only the task hub is a double.
//
// Why this exists alongside tests/host-human-input-durable.test.mjs: that file
// drives each module in isolation and asserts its shape. Nothing checked that
// they fit *together* — that a paused activity output is one the orchestrator
// will complete on, that the completed instance is one `provideInput` can read,
// and that the input it writes is one the activity can resume from. Three
// correct shapes can still fail to compose.
//
// The hub double replaces an instance on `startNew`, which is the behaviour
// `provideInput` depends on. **That assumption is not verified here** — only a
// real hub can settle it, which needs `npm run e2e:durable` and Docker. So this
// covers module integration, not Durable's own semantics: no replay, no
// Azurite, no instance lifecycle, no real 16 KB limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createRunTaskActivity, setHostContextFactory } = await import('../comm/azure-functions/activity.mjs');
const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');
const { createDurableJobs, ORCHESTRATOR_NAME } = await import('../host/jobs/durable.mjs');
const { isLivePausedInstance } = await import('../comm/azure-functions/index.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');
const { createGuardrails } = await import('../host/guardrails.mjs');
const { executeTool } = await import('../host/tools/executor.mjs');

/**
 * A task hub double.
 *
 * Stores what Durable stores — input, output, customStatus, runtimeStatus —
 * and replaces an instance on `startNew`, since that is what `provideInput`
 * relies on when it reuses the job id.
 */
function fakeHub() {
  const instances = new Map();
  return {
    instances,
    async getStatus(id) { return instances.get(id) ?? null; },
    async getStatusBy({ runtimeStatus }) {
      return [...instances.values()].filter(i => runtimeStatus.includes(i.runtimeStatus));
    },
    async startNew(name, { instanceId, input }) {
      instances.set(instanceId, { instanceId, name, input, runtimeStatus: 'Pending', customStatus: null, output: null });
      return instanceId;
    },
    async terminate(id, reason) {
      const i = instances.get(id);
      if (i) { i.runtimeStatus = 'Terminated'; i.output = reason; }
    },
    async raiseEvent() {},
    async purgeInstanceHistory(id) { instances.delete(id); },
  };
}

/** An irreversible tool, so the guardrail has something to stop. */
function bookingTool() {
  const calls = [];
  const tool = {
    name: 'book',
    description: 'book a flight',
    approvalPrompt: (a) => `Book the flight to ${a?.city ?? 'somewhere'}?`,
    reversible: false,
    timeout: 5000,
    async run({ args }) { calls.push(args); return { ref: `BR-${calls.length}` }; },
  };
  return { calls, tools: extendRegistry([tool]) };
}

/**
 * A stand-in model that decides from what it has been told rather than from a
 * call counter — two orchestrations share one mock here, and a positional
 * script would hand the second the reply meant for the first.
 */
const modelFor = () => createMockFleetApi({
  members: rosterNames(2),
  promptResponses: ({ prompt }) => {
    const t = String(prompt ?? '');
    if (t.includes('task router')) return '{"path":"open-ended"}';
    if (t.includes('BR-')) return '```done\n{"result":"Booked.","summary":"done"}\n```';
    if (t.includes('approval_denied')) return '```done\n{"result":"Not booked.","summary":"denied"}\n```';
    return '```tool_call\n{"tool":"book","args":{"city":"Paris"}}\n```';
  },
});

async function harness() {
  const { calls, tools } = bookingTool();
  const hub = fakeHub();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-cycle-'));
  const dispatcher = new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });

  setHostContextFactory(async () => ({
    api: modelFor(),
    activeDispatcher: dispatcher,
    toolRegistry: tools,
    runLoopConfig: { strategy: 'open-ended', maxNoActionTurns: 3, agentName: 'probe' },
    routerConfig: { enabled: false },
    budgetsConfig: null,
    guardrailsMod: createGuardrails({ enabled: true, defaultPolicy: 'allow' }, tools, executeTool),
    notifier: null,
    jobs: null,
    memory: null,
    logger: { warn() {}, info() {}, error() {} },
    humanInputConfig: { enabled: true, maxInterruptions: 10 },
  }));

  const activity = createRunTaskActivity({ getClient: () => hub, pollMs: 100_000 });

  /** Run one orchestration to completion, the way the Durable host would. */
  async function runOrchestration(instanceId) {
    const inst = hub.instances.get(instanceId);
    inst.runtimeStatus = 'Running';
    const gen = buildOrchestrator()({
      df: {
        instanceId,
        currentUtcDateTime: new Date(),
        getInput: () => inst.input,
        setCustomStatus: (s) => { inst.customStatus = structuredClone(s); },
        callActivity: (_name, input) => ({ __input: input }),
      },
    });
    const first = gen.next();
    const output = await activity(first.value.__input, { invocationId: instanceId });
    const final = gen.next(output);
    inst.output = final.value;
    inst.runtimeStatus = 'Completed';
    return final.value;
  }

  const jobs = createDurableJobs({
    client: hub,
    config: { maxQueueSize: 10, durable: { pollMs: 100_000 } },
    logger: { warn() {}, info() {} },
  });

  return {
    jobs, hub, calls, runOrchestration,
    async cleanup() {
      await dispatcher.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test('durable cycle: a pause completes the orchestration and nothing is left running', { timeout: 120_000 }, async () => {
  const h = await harness();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'book a flight to Paris' });
    const out = await h.runOrchestration(jobId);

    assert.equal(out.status, 'paused');
    // The crux: a paused run is a *Completed* instance. Nothing is alive, so
    // nothing is billed or replayed while the person thinks.
    assert.equal(h.hub.instances.get(jobId).runtimeStatus, 'Completed');
    assert.deepEqual(h.calls, [], 'nothing was booked before anyone approved');
  } finally { await h.cleanup(); }
});

test('durable cycle: the paused instance reads back as waiting_input', { timeout: 120_000 }, async () => {
  const h = await harness();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'book a flight to Paris' });
    await h.runOrchestration(jobId);

    const record = await h.jobs.get(jobId);
    assert.equal(record.status, 'waiting_input', 'a Completed instance is not reported as finished');
    assert.ok(record.pendingInput, 'the batch is readable from the record');
    assert.equal(record.pendingInput.questions[0].prompt, 'Book the flight to Paris?');
    assert.equal(record.pendingInput.questions[0].prompt.includes('book'), false, 'no tool name on the screen');

    const pending = await h.jobs.pendingInput(jobId);
    assert.equal(pending.stale, false);
    assert.equal(pending.expired, false);

    assert.equal((await h.jobs.listWaiting()).length, 1, 'found among Completed instances');
  } finally { await h.cleanup(); }
});

test('durable cycle: the startup purge would skip the paused instance', { timeout: 120_000 }, async () => {
  // The sharpest hazard in the design: a blanket purge of completed instances
  // destroys the only copy of a paused run's state.
  const h = await harness();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'book a flight to Paris' });
    await h.runOrchestration(jobId);
    assert.equal(isLivePausedInstance(h.hub.instances.get(jobId)), true);
  } finally { await h.cleanup(); }
});

test('durable cycle: answering starts a NEW orchestration seeded with the answer', { timeout: 120_000 }, async () => {
  const h = await harness();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'book a flight to Paris' });
    await h.runOrchestration(jobId);
    const parked = await h.jobs.get(jobId);

    const res = await h.jobs.provideInput(jobId, {
      batchId: parked.pendingInput.batchId,
      answers: { proceed: 'approve' },
    });
    assert.equal(res.ok, true);

    // We do not resume an orchestration, we start another one.
    const inst = h.hub.instances.get(jobId);
    assert.equal(inst.runtimeStatus, 'Pending', 'a fresh orchestration, not a revived one');
    assert.equal(inst.name, ORCHESTRATOR_NAME);
    assert.equal(inst.input.resume.answered[0].answers.proceed, 'approve', 'the answer travelled into the new input');
    assert.ok(inst.input.resume.resumeFrom, 'and so did the state to resume from');
  } finally { await h.cleanup(); }
});

test('durable cycle: the resumed run completes and the tool runs exactly once', { timeout: 120_000 }, async () => {
  // The whole point. Resume restores state; it does not replay side effects.
  const h = await harness();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'book a flight to Paris' });
    await h.runOrchestration(jobId);
    const parked = await h.jobs.get(jobId);

    await h.jobs.provideInput(jobId, {
      batchId: parked.pendingInput.batchId,
      answers: { proceed: 'approve' },
    });

    const out = await h.runOrchestration(jobId);
    assert.equal(out.status, 'completed');
    assert.equal(h.calls.length, 1, `the flight was booked ${h.calls.length} times`);
    assert.deepEqual(h.calls[0], { city: 'Paris' });

    const settled = await h.jobs.get(jobId);
    assert.equal(settled.status, 'completed');
  } finally { await h.cleanup(); }
});

test('durable cycle: denying means the tool never runs', { timeout: 120_000 }, async () => {
  const h = await harness();
  try {
    const { jobId } = await h.jobs.submit({ goal: 'book a flight to Paris' });
    await h.runOrchestration(jobId);
    const parked = await h.jobs.get(jobId);

    await h.jobs.provideInput(jobId, {
      batchId: parked.pendingInput.batchId,
      answers: { proceed: 'deny' },
    });
    const out = await h.runOrchestration(jobId);

    assert.equal(out.status, 'completed');
    assert.deepEqual(h.calls, [], 'a denial means it never happens');
  } finally { await h.cleanup(); }
});
