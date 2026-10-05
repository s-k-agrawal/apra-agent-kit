// tests/host-run-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runTask } = await import('../host/run-loop.mjs');

function makeTools() {
  return [
    { name: 'weather', description: 'Get weather', reversible: true, timeout: 5000,
      run: async () => ({ temp_c: '15' }) },
  ];
}

test('open-ended: completes a simple task', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather in London' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.result, '15°C');
  assert.ok(result.history.length > 0);
});

test('plan-execute: completes with plan and review', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```plan\n{"steps": [{"type": "tool", "tool": "weather", "args": {"city": "London"}, "reason": "x", "review": false}]}\n```',
      '```review\n{"approved": true}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'plan-execute', tools: makeTools(), fleetApi: api },
  );
  assert.equal(result.status, 'completed');
});

test('budget exceeded stops the run', async () => {
  const { createBudgets } = await import('../host/budgets.mjs');
  const budgets = createBudgets({ maxIterations: 1 });
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```tool_call\n{"tool": "weather", "args": {"city": "Paris"}}\n```',
      '```done\n{"result": "done", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, budgets },
  );
  assert.equal(result.status, 'budget_exceeded');
  assert.ok(result.budget);
  assert.equal(result.budget.iterations, 1);
});

test('signal cancellation stops the run', async () => {
  const ac = new AbortController();
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: (opts) => {
      ac.abort();
      return '```tool_call\n{"tool": "weather", "args": {}}\n```';
    },
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, signal: ac.signal },
  );
  assert.equal(result.status, 'cancelled');
});

test('failed strategy returns failed status', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['thinking...', 'still thinking...', 'more thinking...', 'yet more...'],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, maxNoActionTurns: 3 },
  );
  assert.equal(result.status, 'failed');
});

test('guardrails are passed to strategy', async () => {
  const { createGuardrails } = await import('../host/guardrails.mjs');
  const { executeTool } = await import('../host/tools/executor.mjs');
  const guardrails = createGuardrails(
    { defaultPolicy: 'allow', policies: { weather: 'deny' } },
    [],
    executeTool,
  );
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "denied", "summary": "ok"}\n```',
    ],
  });
  const result = await runTask(
    { id: 't-1', goal: 'Weather' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, guardrails },
  );
  assert.equal(result.status, 'completed');
  const denied = result.history.find(o => o.error === 'guardrail_denied');
  assert.ok(denied);
});

test('onIteration fires once per progress-worthy event with a message', async () => {
  const fleetApi = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "inspect-members", "args": {}}\n```',
      '```done\n{"result": "ok", "summary": "s"}\n```',
    ],
  });
  const tools = [{
    name: 'inspect-members', description: 'x', reversible: true, timeout: 5000, retryable: false, tags: [],
    run: async () => ({ ok: true }),
  }];
  const seen = [];
  const out = await runTask({ id: 't', goal: 'g' }, {
    strategy: 'open-ended', tools, fleetApi,
    onIteration: async (p) => { seen.push(p); },
  });
  assert.equal(out.status, 'completed');
  // open-ended yields action then observation for one tool call
  assert.deepEqual(seen.map(s => s.iteration), [1, 2]);
  assert.match(seen[0].message, /calling inspect-members/);
  assert.equal(seen[0].kind, 'step_started');
  assert.match(seen[1].message, /completed.*inspect-members/);
  assert.equal(seen[1].kind, 'step_completed');
});

test('runTask passes memory through to the strategy unchanged', async () => {
  const api = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: [
      '```tool_call\n{"tool": "weather", "args": {"city": "London"}}\n```',
      '```done\n{"result": "15°C", "summary": "ok"}\n```',
    ],
  });
  const memory = { conversationContext: null };
  const result = await runTask(
    { id: 't-1', goal: 'Weather in London' },
    { strategy: 'open-ended', tools: makeTools(), fleetApi: api, memory },
  );
  assert.equal(result.status, 'completed');
  const observations = result.history.filter(h => h.type === 'observation');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].tool, 'weather');
});

test('onIteration errors do not break the run', async () => {
  const fleetApi = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```done\n{"result": "ok", "summary": "s"}\n```'],
  });
  const out = await runTask({ id: 't', goal: 'g' }, {
    strategy: 'open-ended', tools: [], fleetApi,
    onIteration: async () => { throw new Error('boom'); },
  });
  assert.equal(out.status, 'completed');
});

// ---------------------------------------------------------------------------
// A suspended run is not a failed one
//
// `status` defaults to 'failed', so a strategy that suspends and returns —
// which is what maxSteps does on the Azure path — would be reported as a
// failure. The orchestrator would then settle a run that is merely part-way
// through, and everything it had already done would be thrown away.
// ---------------------------------------------------------------------------

test('runTask reports a suspended strategy as suspended, with its cursor', async () => {
  const out = await runTask({ id: 'job-s', goal: 'do two things' }, {
    strategy: 'open-ended',
    tools: makeTools(),
    fleetApi: createMockFleetApi({
      members: rosterNames(1),
      promptResponses: [
        '```tool_call\n{"tool": "weather", "args": {}}\n```',
        '```tool_call\n{"tool": "weather", "args": {}}\n```',
        '```done\n{"result": "d", "summary": "s"}\n```',
      ],
    }),
    maxSteps: 1,
  });

  assert.equal(out.status, 'suspended', `got ${out.status}`);
  assert.ok(Array.isArray(out.history) && out.history.length >= 1, 'the work it did comes back');
});

test('an ordinary run is still completed, not suspended', async () => {
  const out = await runTask({ id: 'job-c', goal: 'one thing' }, {
    strategy: 'open-ended',
    tools: makeTools(),
    fleetApi: createMockFleetApi({
      members: rosterNames(1),
      promptResponses: ['```done\n{"result": "d", "summary": "s"}\n```'],
    }),
  });
  assert.equal(out.status, 'completed');
});
