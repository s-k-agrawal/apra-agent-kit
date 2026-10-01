// tests/host-human-input-demo-e2e.test.mjs
//
// The exact path a person clicks through on the travel chat page, offline.
//
// `choose-destination` asks a `pick_one_or_text` question of its own;
// `confirm-itinerary` is irreversible so the guardrail asks for approval. Both
// run over real HTTP against the real routes, with a mock fleet standing in
// for the model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { startHost } = await import('../host/index.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');
const { humanInputDemoTools, savedItineraries } = await import('../mcp/human-input-tools.mjs');
const { planReversal, selectSteps } = await import('../host/human-input/reversal/plan.mjs');
const { describePlan } = await import('../host/human-input/reversal/describe.mjs');
const { executeReversal } = await import('../host/human-input/reversal/execute.mjs');
const rec = await import('../host/jobs/record.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-demo-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

const call = (tool, args) => '```tool_call\n' + JSON.stringify({ tool, args }) + '\n```';
const done = (result) => '```done\n' + JSON.stringify({ result, summary: 'Done' }) + '\n```';

const demoHost = (extra = {}) => startHost({
  port: 0,
  // SCHEDULER_ENABLED is upstream's own switch, and the only one that works
  // here: startHost takes overrides for seven modules but not the scheduler,
  // which it reads straight from host.config.mjs. That config ships a demo
  // schedule for `city-briefing`, and these hosts supply their own registry,
  // so the workflow is not registered and startup validation refuses it.
  // Nothing here is testing scheduling.
  env: { ...process.env, NODE_ENV: 'test', SCHEDULER_ENABLED: 'false' },
  registry: extendRegistry(humanInputDemoTools),
  runLoop: { enabled: true, strategy: 'open-ended', maxNoActionTurns: 3 },
  guardrails: { enabled: true, defaultPolicy: 'allow', validateInputs: true },
  dispatch: { enabled: true, store: { kind: 'memory' }, maxQueueSize: 4, concurrency: 1 },
  notify: { sse: { enabled: true } },
  // humanInput requires memory: a paused run stores its checkpoint there.
  memory: { enabled: true, checkpoint: { enabled: true, store: 'filesystem', dir: memoryDir() } },
  humanInput: { enabled: true },
  ...extra,
});

const memoryDir = () => path.join(os.tmpdir(), `hi-mem-${Math.random().toString(36).slice(2, 10)}`);

const url = (host, p) => `http://127.0.0.1:${host.port()}${p}`;
const getJson = async (host, p) => { const r = await fetch(url(host, p)); return { status: r.status, body: await r.json() }; };
const postJson = async (host, p, body) => {
  const r = await fetch(url(host, p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

async function waitForStatus(host, jobId, status, ms = 20_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(host, `/jobs/${jobId}`);
    if (last.body?.status === status) return last.body;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail(`job never reached ${status} (is ${last?.body?.status})`);
}

// ---------------------------------------------------------------------------
// A tool asking a question of its own
// ---------------------------------------------------------------------------

test('demo: an ambiguous city asks which one, and the answer carries through', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    promptResponses: ({ prompt }) => {
      const text = String(prompt ?? '');
      if (text.includes('task router')) return '{"path":"open-ended"}';
      if (text.includes('Texas')) return done('Planning your trip to Paris, Texas.');
      return call('choose-destination', { city: 'Paris' });
    },
  });

  const { host, close } = await demoHost({ fleetApi, dispatcher });
  try {
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'plan me a trip to Paris' });
    const parked = await waitForStatus(host, jobId, 'waiting_input');

    const q = parked.pendingInput.questions[0];
    assert.equal(q.kind, 'pick_one_or_text');
    assert.equal(q.prompt, 'There is more than one Paris. Which did you mean?');
    assert.equal(q.allowOther, true);
    assert.deepEqual(q.options.map(o => o.label), ['Paris, France', 'Paris, Texas, USA']);
    assert.equal(parked.pendingInput.askedBy, 'tool', 'the tool asked, not the guardrail');

    const res = await postJson(host, `/jobs/${jobId}/input`, {
      batchId: parked.pendingInput.batchId,
      answers: { destination: 'geo-4717560' },
    });
    assert.equal(res.status, 200);

    const finished = await waitForStatus(host, jobId, 'completed');
    assert.match(finished.result, /Texas/);
  } finally {
    await close();
    await dispatcher.close();
  }
});

test('demo: the Other box is accepted as an answer', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    promptResponses: ({ prompt }) => {
      const text = String(prompt ?? '');
      if (text.includes('task router')) return '{"path":"open-ended"}';
      if (text.includes('choseOther')) return done('Planning your trip to Parys, South Africa.');
      return call('choose-destination', { city: 'Paris' });
    },
  });

  const { host, close } = await demoHost({ fleetApi, dispatcher });
  try {
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'plan me a trip to Paris' });
    const parked = await waitForStatus(host, jobId, 'waiting_input');

    const res = await postJson(host, `/jobs/${jobId}/input`, {
      batchId: parked.pendingInput.batchId,
      answers: { destination: { other: 'Parys, South Africa' } },
    });
    assert.equal(res.status, 200);

    const finished = await waitForStatus(host, jobId, 'completed');
    assert.match(finished.result, /Parys/);
  } finally {
    await close();
    await dispatcher.close();
  }
});

// ---------------------------------------------------------------------------
// The guardrail asking for approval
// ---------------------------------------------------------------------------

const confirmFleet = () => createMockFleetApi({
  members: rosterNames(2),
  promptResponses: ({ prompt }) => {
    const text = String(prompt ?? '');
    if (text.includes('task router')) return '{"path":"open-ended"}';
    if (text.includes('itin-')) return done('Saved your Kerala itinerary.');
    if (text.includes('approval_denied')) return done('I have not saved anything.');
    return call('confirm-itinerary', { destination: 'Kerala', summary: 'Seven days of backwaters', estimatedCost: 'INR 45,000' });
  },
});

test('demo: saving an itinerary asks first, in the traveller\'s words', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await demoHost({ fleetApi: confirmFleet(), dispatcher });

  try {
    const before = savedItineraries().size;
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'plan and save a Kerala trip' });
    const parked = await waitForStatus(host, jobId, 'waiting_input');

    const q = parked.pendingInput.questions[0];
    assert.equal(q.kind, 'approval');
    assert.equal(q.prompt, 'Shall I save the Kerala itinerary? It comes to about INR 45,000.');
    assert.equal(q.prompt.includes('confirm-itinerary'), false, 'no tool name reaches the screen');
    assert.equal(parked.pendingInput.askedBy, 'guardrail');
    assert.equal(savedItineraries().size, before, 'nothing was saved before anyone approved');

    await postJson(host, `/jobs/${jobId}/input`, { batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' } });
    const finished = await waitForStatus(host, jobId, 'completed');

    assert.match(finished.result, /Saved/);
    assert.equal(savedItineraries().size, before + 1, 'saved exactly once');
  } finally {
    await close();
    await dispatcher.close();
  }
});

test('demo: declining means nothing is saved', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { host, close } = await demoHost({ fleetApi: confirmFleet(), dispatcher });

  try {
    const before = savedItineraries().size;
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'plan and save a Kerala trip' });
    const parked = await waitForStatus(host, jobId, 'waiting_input');

    await postJson(host, `/jobs/${jobId}/input`, { batchId: parked.pendingInput.batchId, answers: { proceed: 'deny' } });
    await waitForStatus(host, jobId, 'completed');

    assert.equal(savedItineraries().size, before, 'a denial means it never happens');
  } finally {
    await close();
    await dispatcher.close();
  }
});

// ---------------------------------------------------------------------------
// Reversal, against the demo tool that declares an undo
// ---------------------------------------------------------------------------

test('demo: a saved itinerary can be taken back, and the offer is in plain language', async () => {
  const saved = savedItineraries();
  const tools = extendRegistry(humanInputDemoTools);
  const confirm = tools.find(t => t.name === 'confirm-itinerary');

  const result = await confirm.run({ args: { destination: 'Kerala', summary: 'Backwaters' } });
  assert.equal(saved.has(result.id), true);

  const history = [
    rec.runStartedEntry('job-1', { task: {}, traceId: 't' }),
    { ...rec.stepCompletedEntry('job-1', { stepIndex: 0, result: { hits: 2 }, reversible: true }), tool: 'choose-destination' },
    { ...rec.stepCompletedEntry('job-1', { stepIndex: 1, result, reversible: false }), tool: 'confirm-itinerary' },
  ];

  const plan = planReversal(history, tools);
  assert.deepEqual(plan.counts, { read_only: 1, mandatory: 0, optional: 1, not_undoable: 0 });

  const { summary } = describePlan(plan, tools);
  assert.match(summary, /I can also undo the Kerala itinerary I saved/);
  assert.equal(summary.includes('confirm-itinerary'), false);
  assert.equal(summary.includes(result.id), false, 'no identifier reaches the traveller');

  const outcome = await executeReversal(selectSteps(plan, [1]), { tools, logger: { warn() {}, error() {} } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.counts.undone, 1);
  assert.equal(saved.has(result.id), false, 'the itinerary is really gone');
});

test('demo: choose-destination needs no undo, because it changed nothing', () => {
  const tools = extendRegistry(humanInputDemoTools);
  const choose = tools.find(t => t.name === 'choose-destination');
  assert.equal(choose.reversible, true);
  assert.equal(choose.undo, undefined);
});

test('demo: choose-destination works when nobody is available to ask', async () => {
  // A tool that can answer without interrupting should never interrupt, and
  // one asked to run with human input off must still return something usable.
  const tools = extendRegistry(humanInputDemoTools);
  const choose = tools.find(t => t.name === 'choose-destination');

  const unambiguous = await choose.run({ args: { city: 'Kochi' } });
  assert.equal(unambiguous.ambiguous, false);
  assert.equal(unambiguous.resolved, 'Kochi');

  const noAsker = await choose.run({ args: { city: 'Paris' }, askUser: undefined });
  assert.equal(noAsker.ambiguous, true);
  assert.equal(noAsker.resolved, 'Paris, France');
  assert.match(noAsker.note, /nobody was available to ask/);
});
