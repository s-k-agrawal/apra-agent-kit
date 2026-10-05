// tests/host-memory-integration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';
import { buildSystemPrompt } from '../host/prompts/system.mjs';

const { createOpenEndedStrategy } = await import('../host/strategies/open-ended.mjs');
const { createPlanExecuteStrategy } = await import('../host/strategies/plan-execute.mjs');
const { stepIdempotencyKey } = await import('../host/checkpoint/record.mjs');
const { runTask } = await import('../host/run-loop.mjs');
const { executeHostedTask } = await import('../host/tasks.mjs');
const { startHost, createHost } = await import('../host/index.mjs');
const { createMemoryModule } = await import('../host/memory/index.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async () => ({ temp_c: '15', city: 'London' }) },
  ];
}

function doneFleet(extra = []) {
  return createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      ...extra,
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
}

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-int-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

function httpCall(port, method, urlPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Scripted responses shared by the plan-execute tests below. They were locals
// inside one test before these four were rewritten around the checkpoint.
const plan = '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "Get weather", "review": false}]}\n```';
const review = '```review\n{"approved": true}\n```';
const done = '```done\n{"result": "15C", "summary": "ok"}\n```';

/**
 * A checkpoint double with the real module's interface.
 *
 * The strategies take `checkpoint` now rather than `memory.runState`: one
 * record serves crash recovery and a pause alike. `held` exposes what was
 * written so a test can assert on it.
 */
function fakeCheckpoint({ saveReturns = true, onSave = null } = {}) {
  let held = null;
  return {
    get held() { return held; },
    set held(v) { held = v; },
    async save(_key, fields) {
      if (onSave) await onSave(fields);
      if (!saveReturns) return false;
      held = { ...fields };
      return true;
    },
    async load() { return held ? { ok: true, checkpoint: held } : { ok: false, reason: 'absent' }; },
    async clear() { held = null; },
    async hasIdempotencyKey(_key, k) { return (held?.idempotencyKeys ?? []).includes(k); },
    async addIdempotencyKey(_key, k) {
      if (!held) return;
      const keys = held.idempotencyKeys ?? [];
      if (!keys.includes(k)) held = { ...held, idempotencyKeys: [...keys, k] };
    },
  };
}

test('system prompt includes memory section when memories provided', () => {
  const prompt = buildSystemPrompt({
    agentName: 'test-agent',
    agentDescription: '',
    memories: [
      { kind: 'rule', text: 'Never delete without backup' },
      { kind: 'domain', text: 'DB on port 5432' },
    ],
  });
  assert.ok(prompt.includes('## Your Memory'));
  assert.ok(prompt.includes('Never delete without backup'));
  assert.ok(prompt.includes('DB on port 5432'));
  assert.ok(prompt.includes('recall'));
  assert.ok(prompt.includes('Rules (always follow these):'));
  assert.ok(prompt.includes('Relevant knowledge:'));
  assert.ok(prompt.indexOf('Never delete without backup') < prompt.indexOf('DB on port 5432'));
  assert.ok(prompt.includes('## Response format'));
  assert.ok(prompt.includes('```tool_call'));
});

test('system prompt omits memory section when no memories', () => {
  const prompt = buildSystemPrompt({ agentName: 'test-agent', agentDescription: '' });
  assert.ok(!prompt.includes('## Your Memory'));
  const bare = buildSystemPrompt({ agentName: 'test-agent', agentDescription: '', memories: [] });
  assert.equal(bare, prompt);
  assert.ok(prompt.includes('## Response format'));
  assert.ok(prompt.includes('One tool call per turn'));
});

test('open-ended strategy feeds local observation history into the next prompt', async () => {
  const api = doneFleet();
  const strategy = createOpenEndedStrategy({
    task: { id: 't-1', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: api,
    memory: { conversationContext: null },
    memories: [{ kind: 'rule', text: 'Never delete without backup' }],
  });
  const events = [];
  for await (const event of strategy.iterate()) events.push(event);
  assert.ok(events.some(e => e.type === 'done'));
  assert.equal(strategy.history().length, 1);
  assert.equal(strategy.history()[0].tool, 'weather');
  const second = api.promptCalls[1].prompt;
  assert.ok(second.includes('weather'));
  assert.ok(api.promptCalls[0].prompt.includes('## Your Memory'));
  assert.ok(api.promptCalls[0].prompt.includes('Never delete without backup'));
});

test('plan-execute checkpoints after each step and skips idempotent steps on resume', async () => {
  let calls = 0;
  const tools = [{
    name: 'weather', reversible: true, timeout: 5000,
    run: async () => { calls += 1; return { temp_c: '15' }; },
  }];
  // Built the way the strategy builds it. The key embeds a hash of the
  // scrubbed args, not the args themselves — a credential in a step argument
  // used to be written verbatim into this string.
  const key = stepIdempotencyKey({ tool: 'weather', args: { city: 'London' } }, 0);
  const checkpoint = fakeCheckpoint();

  const first = createPlanExecuteStrategy({
    task: { id: 'task-9', goal: 'Weather in London' },
    tools,
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, review, done] }),
    checkpoint,
    memory: { conversationContext: null },
  });
  for await (const _event of first.iterate()) { /* drain */ }

  assert.equal(calls, 1);
  assert.equal(checkpoint.held.strategy, 'plan-execute');
  // The cursor is plan.cursor now, not stepIndex — one name for one fact,
  // shared with the pause path.
  assert.equal(checkpoint.held.plan.cursor, 0);
  assert.ok(checkpoint.held.plan.steps.length === 1);
  assert.ok(checkpoint.held.observations.length >= 1);
  assert.ok(checkpoint.held.idempotencyKeys.includes(key));

  // Resuming must not run the step again.
  const second = createPlanExecuteStrategy({
    task: { id: 'task-9', goal: 'Weather in London' },
    tools,
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [done] }),
    checkpoint,
  });
  for await (const _event of second.iterate()) { /* drain */ }
  assert.equal(calls, 1, 'completed work is never re-executed');
});

test('failed checkpoint save does not record the idempotency key', async () => {
  // A save that fails must not advance the in-memory key set. Advancing it
  // would let a step be skipped after a crash the store never learnt about —
  // the run would believe work was done that was never recorded.
  let saves = 0;
  const failing = fakeCheckpoint({ saveReturns: false, onSave: () => { saves += 1; } });
  failing.held = {
    plan: { steps: [{ type: 'tool', tool: 'weather', args: { city: 'London' }, reason: 'x', review: false }], cursor: 0 },
    observations: [],
    idempotencyKeys: ['previous-step'],
    strategy: 'plan-execute',
  };
  const originalKeys = [...failing.held.idempotencyKeys];

  const strategy = createPlanExecuteStrategy({
    task: { id: 'task-save-fail', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, review, done] }),
    checkpoint: failing,
  });
  for await (const _event of strategy.iterate()) { /* drain */ }

  assert.ok(saves >= 1, 'a save was attempted');
  assert.deepEqual(failing.held.idempotencyKeys, originalKeys, 'and the key set did not move');
});

test('plan-execute continues when a checkpoint save throws', async () => {
  // Losing a checkpoint degrades crash recovery. It must not take down a run
  // that is otherwise fine.
  const throwing = fakeCheckpoint({ onSave: () => { throw new Error('store down'); } });

  const strategy = createPlanExecuteStrategy({
    task: { id: 'task-save-throw', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, review, done] }),
    checkpoint: throwing,
  });

  const events = [];
  for await (const event of strategy.iterate()) events.push(event);
  assert.ok(events.some(e => e.type === 'done'), 'the run still finishes');
});

test('runTask passes memory and memories through to the strategy', async () => {
  const api = doneFleet();
  const result = await runTask(
    { id: 't-1', goal: 'Weather in London' },
    {
      strategy: 'open-ended',
      tools: makeTools(),
      fleetApi: api,
      memories: [{ kind: 'domain', text: 'DB on port 5432' }],
      memory: {},
    },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.history.filter(h => h.type === 'observation').length, 1);
  assert.ok(api.promptCalls[0].prompt.includes('DB on port 5432'));
  assert.ok(api.promptCalls[0].prompt.includes('## Your Memory'));
});

test('sequential runs do not leak observations between tasks', async () => {
  const run = (city) => runTask(
    { id: `t-${city}`, goal: `Weather in ${city}` },
    {
      strategy: 'open-ended',
      tools: makeTools(),
      fleetApi: createMockFleetApi({
        members: rosterNames(1),
        promptResponses: [
          `\`\`\`tool_call\n{"tool": "weather", "args": {"city": "${city}"}}\n\`\`\``,
          '```done\n{"result": "ok", "summary": "ok"}\n```',
        ],
      }),
    },
  );

  const first = await run('London');
  const second = await run('Paris');
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');

  const secondObservations = second.history.filter(h => h.type === 'observation');
  assert.equal(secondObservations.length, 1);
  assert.equal(secondObservations[0].args.city, 'Paris');
  assert.ok(!secondObservations.some(obs => obs.args?.city === 'London'));
});

test('plan-execute resume replays checkpoint observations into that run only', async () => {
  // A resumed run gets its own observations back and nobody else's.
  const checkpoint = fakeCheckpoint();
  checkpoint.held = {
    plan: { steps: [{ type: 'tool', tool: 'weather', args: { city: 'London' }, reason: 'x', review: false }], cursor: 1 },
    observations: [{ type: 'observation', stepType: 'tool', tool: 'weather', result: { ok: true } }],
    idempotencyKeys: [],
    strategy: 'plan-execute',
  };

  const resumed = createPlanExecuteStrategy({
    task: { id: 'task-resume-scope', goal: 'Weather in London' },
    tools: makeTools(),
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [done] }),
    checkpoint,
  });
  for await (const _event of resumed.iterate()) { /* drain */ }

  assert.equal(resumed.history().length >= 1, true, 'the restored observation is present');

  // A different task must not see it.
  const other = createPlanExecuteStrategy({
    task: { id: 'task-other', goal: 'Weather in Paris' },
    tools: makeTools(),
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, review, done] }),
    checkpoint: fakeCheckpoint(),
  });
  for await (const _event of other.iterate()) { /* drain */ }
  assert.equal(other.history().some(o => o.result?.ok === true && o.tool === 'weather' && o.stepType === 'tool' && !o.args), false);
});

test('executeHostedTask recalls before the run and learns after', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const seen = { tags: null, learned: null, cleared: null };
  try {
    const out = await executeHostedTask({ id: 'task-15', goal: 'Inspect the weather in London' }, {
      api,
      activeDispatcher: dispatcher,
      toolRegistry: [{ name: 'inspect-members', description: 'Inspect', reversible: true, timeout: 5000, run: async () => ({ ok: true }) }],
      runLoopConfig: { strategy: 'open-ended', agentName: 'test-agent', agentDescription: '' },
      budgetsConfig: null,
      guardrailsMod: null,
      memory: {
        longTerm: {
          async recall({ tags, taskId }) {
            seen.tags = tags;
            seen.taskId = taskId;
            return [
              { kind: 'rule', text: 'Never delete without backup' },
              { kind: 'domain', text: 'DB on port 5432' },
            ];
          },
        },
        learner: {
          async extract(args) { seen.learned = args; return { newFacts: [], promotedIds: [] }; },
        },
        conversationContext: null,
      },
      // The clear moved from memory.runState to the checkpoint: one record,
      // one writer, and the key carries the cp- prefix.
      checkpoint: { async clear(key) { seen.cleared = key; } },
    });
    assert.equal(out.status, 'completed');
    assert.deepEqual(seen.tags, ['inspect', 'weather', 'london']);
    assert.equal(seen.taskId, 'task-15');
    assert.ok(api.promptCalls[0].prompt.includes('## Your Memory'));
    assert.ok(api.promptCalls[0].prompt.includes('Never delete without backup'));
    assert.equal(seen.learned.task.id, 'task-15');
    assert.ok(seen.learned.history.some(h => h.tool === 'inspect-members' || h.type === 'observation'));
    assert.equal(seen.learned.recalledFacts.length, 2);
    assert.equal(seen.cleared, 'cp-task-15');
  } finally {
    await dispatcher.close();
  }
});

test('executeHostedTask continues when recall, learn, and clear fail', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  try {
    const out = await executeHostedTask({ goal: 'Inspect weather' }, {
      api,
      activeDispatcher: dispatcher,
      toolRegistry: [],
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      memory: {
        longTerm: { async recall() { throw new Error('recall boom'); } },
        learner: { async extract() { throw new Error('learn boom'); } },
      },
      // The clear lives on the checkpoint now, not on memory.runState.
      checkpoint: { async clear() { throw new Error('clear boom'); } },
    });
    assert.equal(out.status, 'completed');
    assert.ok(!api.promptCalls[0].prompt.includes('## Your Memory'));
    assert.ok(warnings.some(w => /recall boom/.test(w)));
    assert.ok(warnings.some(w => /learn boom/.test(w)));
    assert.ok(warnings.some(w => /clear boom/.test(w)));
  } finally {
    console.warn = orig;
    await dispatcher.close();
  }
});

test('startHost runSync threads memory into the task prompt', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-mem-wire-'));
  const memDir = path.join(dir, 'memory');
  await fs.writeFile(path.join(dir, 'host.config.mjs'), `export default {
    name: 'mem-wire',
    fleet: {},
    comm: { adapter: 'express', host: '127.0.0.1' },
    modules: {
      runLoop: { enabled: true, strategy: 'open-ended' },
      router: { enabled: false },
      guardrails: { enabled: false },
      budgets: { enabled: false },
      dispatch: { enabled: false },
      chat: { enabled: false },
      memory: { longTerm: { enabled: true, store: 'filesystem', dir: ${JSON.stringify(memDir)}, decay: { mode: 'none' } } },
    },
  };`);
  const fleetApi = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  const started = await startHost({ fleetApi, dispatcher, port: 0, configDir: dir });
  try {
    await started.memory.longTerm.store({ kind: 'rule', text: 'Never delete without backup', tags: ['safety'], source: 'human' });
    const res = await httpCall(started.host.port(), 'POST', '/task?wait=true', {
      goal: 'Inspect the weather in London',
      strategy: 'open-ended',
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'completed');
    assert.ok(fleetApi.promptCalls.some(c => c.prompt.includes('## Your Memory')));
    assert.ok(fleetApi.promptCalls.some(c => c.prompt.includes('Never delete without backup')));
  } finally {
    await started.close();
  }
});

test('createHost().run() threads a supplied memory module', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```done\n{"result": "done", "summary": "s"}\n```',
    ],
  });
  const dispatcher = await makeDispatcher();
  let recalled = false;
  const agent = createHost({
    fleetApi: api,
    dispatcher,
    env: { ...process.env, NODE_ENV: 'test' },
    runLoop: { enabled: true, strategy: 'open-ended' },
    memory: {
      longTerm: {
        async recall() {
          recalled = true;
          return [{ kind: 'rule', text: 'Never delete without backup' }];
        },
      },
    },
  }).build();
  try {
    const out = await agent.run({ id: 'run-1', goal: 'Inspect weather today', strategy: 'open-ended' });
    assert.equal(out.status, 'completed');
    assert.equal(recalled, true);
    assert.ok(api.promptCalls[0].prompt.includes('Never delete without backup'));
  } finally {
    await dispatcher.close();
  }
});

// ---------------------------------------------------------------------------
// The learner's inputs, as executeHostedTask assembles them
// ---------------------------------------------------------------------------

test('a cancelled run learns nothing', async () => {
  // Somebody who cancelled did not state a preference. Learning from a run
  // they stopped would turn an abandoned attempt into a standing fact.
  let learned = null;
  const controller = new AbortController();
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "15C", "summary": "ok"}\n```',
    ],
  });
  // Abort once the run is genuinely under way, so runTask reports 'cancelled'
  // rather than settleWhenAborted short-circuiting before the loop starts.
  const origExecute = api.executePrompt.bind(api);
  api.executePrompt = async (args) => {
    const out = await origExecute(args);
    controller.abort();
    return out;
  };

  const dispatcher = await makeDispatcher();
  try {
    const out = await executeHostedTask({ id: 'task-cancel', goal: 'Weather in London' }, {
      api,
      activeDispatcher: dispatcher,
      toolRegistry: makeTools(),
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      signal: controller.signal,
      memory: {
        longTerm: { async recall() { return []; } },
        learner: { async extract(args) { learned = args; return { newFacts: [], promotedIds: [] }; } },
      },
      checkpoint: { async clear() {} },
    });
    assert.equal(out.status, 'cancelled');
    assert.equal(learned, null, 'the learner was never called');
  } finally {
    await dispatcher.close();
  }
});

test('answered questions reach the learner, and guardrail approvals do not', async () => {
  // The wiring tasks.mjs owns: pull the run's history off the job store and
  // hand the learnable answers to extract. Without this the {{ANSWERS}} block
  // is always empty however well learnableAnswers filters.
  const rec = await import('../host/jobs/record.mjs');
  const prefBatch = {
    batchId: 'inp-pref', jobId: 'task-answers', askedBy: 'agent',
    questions: [{ fieldId: 'pace', kind: 'pick_one', prompt: 'How full should the days be?' }],
    askedAt: '2026-09-30T00:00:00Z', staleAfter: '2026-10-01T00:00:00Z', expiresAt: '2026-10-07T00:00:00Z',
  };
  const approvalBatch = { ...prefBatch, batchId: 'inp-ok', askedBy: 'guardrail',
    questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' }] };

  const events = [
    rec.questionAskedEntry('task-answers', { batch: prefBatch }),
    rec.answerReceivedEntry('task-answers', { batchId: 'inp-pref', answers: { pace: 'relaxed' }, answeredBy: 'p-1' }),
    rec.questionAskedEntry('task-answers', { batch: approvalBatch }),
    rec.answerReceivedEntry('task-answers', { batchId: 'inp-ok', answers: { proceed: 'approve' }, answeredBy: 'p-1' }),
  ];

  let learned = null;
  const dispatcher = await makeDispatcher();
  try {
    const out = await executeHostedTask({ id: 'task-answers', goal: 'Plan a trip' }, {
      api: doneFleet(),
      activeDispatcher: dispatcher,
      toolRegistry: makeTools(),
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      jobs: { async events() { return events; } },
      memory: {
        longTerm: { async recall() { return []; } },
        learner: { async extract(args) { learned = args; return { newFacts: [], promotedIds: [] }; } },
      },
      checkpoint: { async clear() {} },
    });
    assert.equal(out.status, 'completed');
    assert.deepEqual(learned.answers.map(a => a.answer), ['relaxed']);
    assert.equal(learned.answers[0].prompt, 'How full should the days be?');
  } finally {
    await dispatcher.close();
  }
});

test('a run with no job store still learns, with no answers', async () => {
  // jobs is optional on this path. An absent store must mean "no answers",
  // not a crash that costs the run its learning.
  let learned = null;
  const dispatcher = await makeDispatcher();
  try {
    await executeHostedTask({ id: 'task-nojobs', goal: 'Plan a trip' }, {
      api: doneFleet(),
      activeDispatcher: dispatcher,
      toolRegistry: makeTools(),
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      memory: {
        longTerm: { async recall() { return []; } },
        learner: { async extract(args) { learned = args; return { newFacts: [], promotedIds: [] }; } },
      },
      checkpoint: { async clear() {} },
    });
    assert.deepEqual(learned.answers, []);
  } finally {
    await dispatcher.close();
  }
});

// ---------------------------------------------------------------------------
// A resumed run reproduces the prompt the original run had
//
// The checkpoint captures `recalledFacts` and `conversation` so a resume can
// rebuild the same prompt. Nothing read them back: tasks.mjs re-recalled from
// long-term memory and rebuilt the conversation fresh, so the resumed run
// could be reasoning from different facts than the run the person answered —
// decay, a new fact, or an evicted turn is enough to change them.
// ---------------------------------------------------------------------------

test('a resume reuses the checkpoint facts rather than recalling again', async () => {
  let recalls = 0;
  const captured = [];
  const api = doneFleet();
  const origPrompt = api.executePrompt.bind(api);
  api.executePrompt = async (args) => { captured.push(args.prompt); return origPrompt(args); };

  const dispatcher = await makeDispatcher();
  try {
    const out = await executeHostedTask({ id: 'task-reuse', goal: 'Weather in London' }, {
      api,
      activeDispatcher: dispatcher,
      toolRegistry: makeTools(),
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      memory: {
        longTerm: {
          async recall() { recalls += 1; return [{ id: 'mem-new', kind: 'domain', text: 'A FACT FROM NOW' }]; },
        },
      },
      checkpoint: { async clear() {} },
      resumeFrom: {
        observations: [],
        recalledFacts: [{ id: 'mem-then', kind: 'domain', text: 'THE FACT IT WAS GIVEN' }],
        conversation: [{ role: 'turn', goal: 'earlier question', answer: 'earlier answer' }],
      },
    });

    assert.equal(out.status, 'completed');
    assert.equal(recalls, 0, 'the resumed run did not re-recall');
    assert.ok(captured[0].includes('THE FACT IT WAS GIVEN'), 'it used the facts it was given');
    assert.equal(captured[0].includes('A FACT FROM NOW'), false, 'and not what memory holds today');
  } finally {
    await dispatcher.close();
  }
});

test('a first run still recalls normally', async () => {
  // The reuse must be scoped to a resume. A fresh run has no checkpoint to
  // reproduce and must see what memory holds now.
  let recalls = 0;
  const dispatcher = await makeDispatcher();
  try {
    await executeHostedTask({ id: 'task-fresh', goal: 'Weather in London' }, {
      api: doneFleet(),
      activeDispatcher: dispatcher,
      toolRegistry: makeTools(),
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      memory: { longTerm: { async recall() { recalls += 1; return []; } } },
      checkpoint: { async clear() {} },
      resumeFrom: null,
    });
    assert.equal(recalls, 1);
  } finally {
    await dispatcher.close();
  }
});

// ---------------------------------------------------------------------------
// A suspended run is as unfinished as a paused one
//
// `executeHostedTask` treats anything that is not 'paused' as settled: it
// records a conversation turn, runs the learner, and CLEARS the checkpoint.
// For a run that merely suspended between steps, clearing is catastrophic —
// the next advance would find nothing and start over, re-running whatever
// irreversible work had already completed.
// ---------------------------------------------------------------------------

test('a suspended run keeps its checkpoint, and does not learn or record a turn', async () => {
  let cleared = false;
  let learned = false;
  let turns = 0;

  const dispatcher = await makeDispatcher();
  try {
    const out = await executeHostedTask({ id: 'task-susp', sessionId: 's1', goal: 'do two things' }, {
      api: createMockFleetApi({
        members: rosterNames(1),
        promptResponses: [
          '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
          '```tool_call\n{"tool": "weather", "args": {"city": "Paris"}}\n```',
          '```done\n{"result": "d", "summary": "s"}\n```',
        ],
      }),
      activeDispatcher: dispatcher,
      toolRegistry: makeTools(),
      runLoopConfig: { strategy: 'open-ended' },
      budgetsConfig: null,
      guardrailsMod: null,
      maxSteps: 1,
      memory: {
        longTerm: { async recall() { return []; } },
        learner: { async extract() { learned = true; return { newFacts: [], promotedIds: [] }; } },
        conversationContext: { mode: 'store', async forPrompt() { return []; }, async recordTurn() { turns += 1; return {}; } },
      },
      checkpoint: { async clear() { cleared = true; } },
    });

    assert.equal(out.status, 'suspended', `got ${out.status}`);
    assert.equal(cleared, false, 'the checkpoint survives — the next advance needs it');
    assert.equal(learned, false, 'half a run teaches nothing');
    assert.equal(turns, 0, 'and nobody answered yet');
  } finally {
    await dispatcher.close();
  }
});
