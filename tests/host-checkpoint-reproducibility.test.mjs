// tests/host-checkpoint-reproducibility.test.mjs
//
// A resumed run must see what the original run saw.
//
// The original recalls facts at start. A cold resume days later re-recalls and
// can get a different set — decay moved them, another run learnt something,
// somebody edited memory through the routes. The agent then behaves
// differently mid-task and nothing in the record explains why.
//
// So the checkpoint records what this run was *given*, the same way
// step_completed records the arguments a step actually ran with. Memory stays
// the source of truth for which facts exist; this records which ones were used.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createCheckpointRecord } = await import('../host/checkpoint/record.mjs');

test('recalled facts are stored with id AND text', () => {
  // Ids alone are not enough: a fact deleted or edited between pause and
  // resume would silently change the prompt the run had reasoned on.
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    recalledFacts: [{ id: 'mem-1', text: 'prefers trains', kind: 'preference' }],
  });
  assert.equal(r.recalledFacts[0].id, 'mem-1');
  assert.equal(r.recalledFacts[0].text, 'prefers trains');
});

test('recalled facts do not accumulate duplicates', () => {
  // A long run recalls on every iteration and the checkpoint is rewritten each
  // time. Appending without deduping grows the row until it will not fit.
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    recalledFacts: [
      { id: 'mem-1', text: 'a' },
      { id: 'mem-1', text: 'a' },
      { id: 'mem-2', text: 'b' },
    ],
  });
  assert.equal(r.recalledFacts.length, 2, 'deduped by id');
  assert.deepEqual(r.recalledFacts.map(f => f.id), ['mem-1', 'mem-2']);
});

test('the first occurrence of a fact wins, not the last', () => {
  // What the run was given first is what it reasoned on.
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    recalledFacts: [{ id: 'mem-1', text: 'original' }, { id: 'mem-1', text: 'edited later' }],
  });
  assert.equal(r.recalledFacts[0].text, 'original');
});

test('facts with no id are all kept', () => {
  // Nothing to dedupe on, and dropping them would lose what the run saw.
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    recalledFacts: [{ text: 'a' }, { text: 'b' }],
  });
  assert.equal(r.recalledFacts.length, 2);
});

test('conversation is stored as it went into the prompt', () => {
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    conversation: [{ role: 'user', content: 'Paris in October' }],
  });
  assert.equal(r.conversation[0].content, 'Paris in October');
});

test('neither field leaks a credential', () => {
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    recalledFacts: [{ id: 'mem-1', text: 'ok', apiKey: 'sk-live-1' }],
    conversation: [{ role: 'user', content: 'hi', authorization: 'Bearer abc' }],
  });
  const json = JSON.stringify(r);
  assert.equal(json.includes('sk-live-1'), false);
  assert.equal(json.includes('Bearer abc'), false);
  assert.equal(r.recalledFacts[0].text, 'ok', 'and the rest survives');
});

// ---------------------------------------------------------------------------
// The wiring: tasks.mjs -> run-loop.mjs -> the strategy
// ---------------------------------------------------------------------------
//
// The checkpoint is built in host/index.mjs and has to reach a strategy three
// hops away. A break anywhere in that chain is silent: the run works, and
// simply never checkpoints.

const { runTask } = await import('../host/run-loop.mjs');
const { createMockFleetApi, rosterNames } = await import('./helpers/mock-fleet.mjs');

test('wiring: the checkpoint reaches the strategy through the run loop', async () => {
  const saves = [];
  const checkpoint = {
    save: async (key, fields) => { saves.push({ key, fields }); return true; },
    load: async () => ({ ok: false, reason: 'absent' }),
    clear: async () => {},
    hasIdempotencyKey: async () => false,
    addIdempotencyKey: async () => {},
  };

  const out = await runTask({ id: 'job-9', goal: 'g' }, {
    strategy: 'open-ended',
    tools: [{ name: 't', reversible: true, timeout: 5000, run: async () => 'ok' }],
    checkpoint,
    agentName: 'kit',
    fleetApi: createMockFleetApi({
      members: rosterNames(1),
      promptResponses: ({ prompt }) => (String(prompt ?? '').includes('"type": "observation"')
        ? '```done\n{"result":"ok","summary":"s"}\n```'
        : '```tool_call\n{"tool":"t","args":{}}\n```'),
    }),
  });

  assert.equal(out.status, 'completed');
  assert.equal(saves.length >= 1, true, 'the strategy checkpointed, so the chain is intact');
  assert.equal(saves[0].key, 'cp-job-9');
  assert.equal(saves[0].fields.agentName, 'kit');
});

test('wiring: no checkpoint means a run that simply does not checkpoint', async () => {
  const out = await runTask({ id: 'job-9', goal: 'g' }, {
    strategy: 'open-ended',
    tools: [],
    fleetApi: createMockFleetApi({
      members: rosterNames(1),
      promptResponses: ['```done\n{"result":"ok","summary":"s"}\n```'],
    }),
  });
  assert.equal(out.status, 'completed');
});
