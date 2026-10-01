// tests/host-memory-store-entity.test.mjs
//
// Facts and chat turns in the Durable task hub.
//
// The point of these adapters is that a default Azure deployment needs neither
// a Cosmos account nor a SQL server. What has to be true for that to be worth
// anything is that they behave the same as the adapters they replace — so the
// query test here runs against the sqlite store too, and compares.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createEntityStore } = await import('../host/memory/store/entity.mjs');
const { createConversationEntityStore } = await import('../host/memory/conversation-store/entity.mjs');
const { assertMemoryStore } = await import('../host/memory/store/interface.mjs');
const { assertConversationStore } = await import('../host/memory/conversation-store/interface.mjs');
const { factsOps } = await import('../comm/azure-functions/entities/facts-entity.mjs');
const { conversationOps } = await import('../comm/azure-functions/entities/conversation-entity.mjs');

/** A task hub that applies the operations, rather than only recording them. */
function fakeHub() {
  const states = new Map();
  return {
    states,
    async readEntityState(id) {
      const state = states.get(`${id.name}:${id.key}`);
      return { entityExists: state !== undefined, entityState: state ?? null };
    },
    async signalEntity(id, op, input) {
      const key = `${id.name}:${id.key}`;
      const state = states.get(key) ?? null;
      if (id.name === 'facts') {
        const r = op === 'store'
          ? factsOps.store(state, input.entry, input.options ?? {})
          : factsOps[op](state, input);
        states.set(key, r.state ?? r);
        return;
      }
      const next = op === 'append'
        ? conversationOps.append(state, input.turn, input.options ?? {})
        : conversationOps[op](state, input);
      if (next === null) states.delete(key);
      else states.set(key, next);
    },
  };
}

// The full entry the long-term tier actually produces. A partial one is
// accepted by an in-memory adapter and rejected by sqlite — which is how the
// checkpoint store shipped a record that could never be written. Comparing two
// adapters is only meaningful on input both of them accept.
const fact = (over = {}) => ({
  id: 'mem-1', kind: 'domain', text: 'a fact', tags: ['x'], source: 'agent',
  confidence: 1, storageStrength: 1, retrievalStrength: 0.5, state: 'active',
  stability: 1, difficulty: 5, reps: 0, lapses: 0,
  lastPromotedAt: null, lastReviewRating: null,
  createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null, useCount: 0,
  metadata: null, ...over,
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('the entity stores satisfy the interfaces the rest of the kit calls', () => {
  const hub = fakeHub();
  assert.doesNotThrow(() => assertMemoryStore(createEntityStore({ getClient: () => hub })));
  assert.doesNotThrow(() => assertConversationStore(createConversationEntityStore({ getClient: () => hub })));
});

test('an entity store without a client is refused at construction', () => {
  // Failing here beats failing at the first recall, hours into a deployment.
  assert.throws(() => createEntityStore({}), /getClient/);
  assert.throws(() => createConversationEntityStore({}), /getClient/);
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

test('facts round-trip through the hub', async () => {
  const hub = fakeHub();
  const s = createEntityStore({ getClient: () => hub });
  await s.open();
  await s.store(fact({ id: 'a', text: 'first' }));
  assert.equal((await s.get('a')).text, 'first');
  assert.equal(await s.count({}), 1);
  await s.close();
});

test('the entity store answers a query the same way sqlite does', async () => {
  // Same fixture, same filter, both adapters. A drift here means a run recalls
  // different facts on Azure than on a VM and reasons differently, with
  // nothing to indicate why.
  const fixture = [
    fact({ id: 'a', kind: 'domain', tags: ['trip'], retrievalStrength: 0.2 }),
    fact({ id: 'b', kind: 'domain', tags: ['trip'], retrievalStrength: 0.9 }),
    fact({ id: 'c', kind: 'preference', tags: ['other'], retrievalStrength: 0.5 }),
    fact({ id: 'd', kind: 'domain', tags: ['trip'], state: 'dormant', retrievalStrength: 0.7 }),
  ];
  const filter = { kinds: ['domain'], states: ['active'], tags: ['trip'] };

  const hub = fakeHub();
  const entity = createEntityStore({ getClient: () => hub });
  await entity.open();
  for (const f of fixture) await entity.store(f);

  const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-vs-sqlite-'));
  const sqlite = createSqliteStore({ dbPath: path.join(dir, 'memory.db') });
  await sqlite.open();
  for (const f of fixture) await sqlite.store(f);

  const fromEntity = (await entity.query(filter)).map(e => e.id);
  const fromSqlite = (await sqlite.query(filter)).map(e => e.id);
  assert.deepEqual(fromEntity, fromSqlite, `entity ${fromEntity} vs sqlite ${fromSqlite}`);
  assert.deepEqual(fromEntity, ['b', 'a'], 'and both are right: strongest first');

  await sqlite.close();
  await entity.close();
});

test('the cap is decided against committed state, not against a guess', async () => {
  // Two stores in flight would otherwise both believe there was room.
  const hub = fakeHub();
  const s = createEntityStore({ getClient: () => hub, maxEntries: 1 });
  await s.open();
  assert.equal((await s.store(fact({ id: 'a' }))).ok, true);
  const second = await s.store(fact({ id: 'b' }));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'at_cap');
  assert.equal(await s.count({}), 1);
});

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

test('conversation turns round-trip, newest last', async () => {
  const hub = fakeHub();
  const s = createConversationEntityStore({ getClient: () => hub });
  await s.open();
  await s.append('sess-1', { role: 'turn', goal: 'q1', answer: 'a1' });
  await s.append('sess-1', { role: 'turn', goal: 'q2', answer: 'a2' });
  const all = await s.listSession('sess-1');
  assert.deepEqual(all.map(t => t.goal), ['q1', 'q2']);
});

test('conversations are kept per session, not pooled', async () => {
  const hub = fakeHub();
  const s = createConversationEntityStore({ getClient: () => hub });
  await s.append('sess-1', { role: 'turn', goal: 'mine' });
  await s.append('sess-2', { role: 'turn', goal: 'yours' });
  assert.deepEqual((await s.listSession('sess-1')).map(t => t.goal), ['mine']);
  assert.deepEqual((await s.listSession('sess-2')).map(t => t.goal), ['yours']);
});

test('purging a session empties it and leaves the others alone', async () => {
  const hub = fakeHub();
  const s = createConversationEntityStore({ getClient: () => hub });
  await s.append('sess-1', { role: 'turn', goal: 'mine' });
  await s.append('sess-2', { role: 'turn', goal: 'yours' });
  assert.equal(await s.purgeSessions({ sessionIds: ['sess-1'] }), 1);
  assert.deepEqual(await s.listSession('sess-1'), []);
  assert.deepEqual((await s.listSession('sess-2')).map(t => t.goal), ['yours']);
});

test('a credential in a stored fact does not reach the hub', async () => {
  const hub = fakeHub();
  const s = createEntityStore({ getClient: () => hub });
  await s.store(fact({ id: 'a', connectionString: 'Server=x;Password=LEAK' }));
  assert.equal(JSON.stringify([...hub.states.values()]).includes('LEAK'), false);
});
