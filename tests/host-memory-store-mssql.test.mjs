// tests/host-memory-store-mssql.test.mjs
//
// Microsoft SQL Server — selectable, never the default.
//
// These run against an injected driver double, so they prove the SQL the
// adapter builds and the shapes it returns, and nothing about how a real
// server answers it. **That distinction has already cost this branch once**:
// the checkpoint store passed every test against a double and then failed at
// the first real sqlite insert, because the double accepted a record shape the
// database rejected. See docs/plans/2026-09-30-checkpoint-integration-issues.md §1.2.
//
// So: a `*.live.test.mjs` against a real server is still owed, and is not in
// CI. Until it exists, treat this adapter as unverified against SQL Server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createMssqlStore } = await import('../host/memory/store/mssql.mjs');
const { createConversationMssqlStore } = await import('../host/memory/conversation-store/mssql.mjs');
const { assertMemoryStore } = await import('../host/memory/store/interface.mjs');
const { assertConversationStore } = await import('../host/memory/conversation-store/interface.mjs');

/** Records every statement and its parameters, and answers from a fixture. */
function fakeDriver(recordsets = []) {
  const queries = [];
  let i = 0;
  const request = () => {
    const params = {};
    const req = {
      input(name, value) { params[name] = value; return req; },
      async query(text) {
        queries.push({ text: text.replace(/\s+/g, ' ').trim(), params });
        const next = recordsets[i];
        i += 1;
        return next ?? { recordset: [], rowsAffected: [0] };
      },
    };
    return req;
  };
  return {
    queries,
    async connect() { return { request, async close() {} }; },
  };
}

const row = (over = {}) => ({
  id: 'mem-1', kind: 'domain', text: 'a fact', tags: '["trip"]', source: 'agent',
  confidence: 1, storage_strength: 1, retrieval_strength: 0.5, state: 'active',
  stability: 1, difficulty: 5, reps: 0, lapses: 0,
  last_promoted_at: null, last_review_rating: null,
  created_at: '2026-09-01T00:00:00.000Z', last_used_at: null, use_count: 0,
  metadata: null, ...over,
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test('the mssql stores satisfy the interfaces the rest of the kit calls', () => {
  const driver = fakeDriver();
  assert.doesNotThrow(() => assertMemoryStore(createMssqlStore({ connectionString: 'x', driver })));
  assert.doesNotThrow(() => assertConversationStore(createConversationMssqlStore({ connectionString: 'x', driver })));
});

test('a store with no connection string is refused at construction', () => {
  assert.throws(() => createMssqlStore({}), /connectionString/);
  assert.throws(() => createConversationMssqlStore({}), /connectionString/);
});

test('using a store before opening it says so, rather than throwing on null', () => {
  const s = createMssqlStore({ connectionString: 'x', driver: fakeDriver() });
  return assert.rejects(() => s.count({}), /not open/);
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

test('open creates the table if it is not there', async () => {
  const driver = fakeDriver();
  const s = createMssqlStore({ connectionString: 'x', driver });
  await s.open();
  assert.match(driver.queries[0].text, /CREATE TABLE/);
  assert.match(driver.queries[0].text, /IF OBJECT_ID/, 'and does not fail when it already exists');
});

test('store upserts rather than failing on a second write of one id', async () => {
  const driver = fakeDriver();
  const s = createMssqlStore({ connectionString: 'x', driver });
  await s.open();
  await s.store({ id: 'a', kind: 'domain', text: 't', tags: ['x'] });
  const q = driver.queries.at(-1);
  assert.match(q.text, /MERGE/);
  assert.equal(q.params.id, 'a');
  assert.equal(q.params.tags, '["x"]', 'tags travel as JSON');
});

test('query filters by kind and state in SQL, and by tag in the process', async () => {
  // The tag predicate is an any-of test over a JSON array, which is the one
  // filter that does not translate cleanly. Doing it here keeps it identical
  // to the sqlite adapter rather than approximately the same.
  const driver = fakeDriver([
    {},   // DDL
    { recordset: [row({ id: 'a', tags: '["trip"]' }), row({ id: 'b', tags: '["other"]' })] },
  ]);
  const s = createMssqlStore({ connectionString: 'x', driver });
  await s.open();
  const out = await s.query({ kinds: ['domain'], states: ['active'], tags: ['trip'] });

  const q = driver.queries.at(-1);
  assert.match(q.text, /kind IN \(@k0\)/);
  assert.match(q.text, /state IN \(@s0\)/);
  assert.match(q.text, /ORDER BY retrieval_strength DESC/);
  assert.equal(q.text.includes('tags'), false, 'the tag filter is not in the SQL');
  assert.deepEqual(out.map(e => e.id), ['a'], 'and it was applied anyway');
});

test('a limit is applied after the sort, not by the database', async () => {
  const driver = fakeDriver([
    {},
    { recordset: [row({ id: 'strong', retrieval_strength: 0.9 }), row({ id: 'weak', retrieval_strength: 0.1 })] },
  ]);
  const s = createMssqlStore({ connectionString: 'x', driver });
  await s.open();
  assert.deepEqual((await s.query({ limit: 1 })).map(e => e.id), ['strong']);
});

test('purge with no predicate removes nothing', async () => {
  // Matching sqlite, which returns 0 rather than deleting the table.
  const driver = fakeDriver();
  const s = createMssqlStore({ connectionString: 'x', driver });
  await s.open();
  assert.equal(await s.purge({}), 0);
  assert.equal(driver.queries.length, 1, 'no DELETE was even sent');
});

test('a row round-trips back into the shape the kit uses', async () => {
  const driver = fakeDriver([{}, { recordset: [row()] }]);
  const s = createMssqlStore({ connectionString: 'x', driver });
  await s.open();
  const got = await s.get('mem-1');
  assert.equal(got.retrievalStrength, 0.5, 'snake_case columns become camelCase fields');
  assert.deepEqual(got.tags, ['trip'], 'and JSON columns are parsed');
});

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

test('append derives its sequence, so two turns cannot collide', async () => {
  const driver = fakeDriver([{}, { recordset: [{ n: 4 }] }]);
  const s = createConversationMssqlStore({ connectionString: 'x', driver });
  await s.open();
  const turn = await s.append('sess-1', { role: 'turn', goal: 'q' });
  assert.equal(turn.seq, 4);
  assert.match(driver.queries.at(-1).text, /INSERT INTO/);
  assert.equal(driver.queries.at(-1).params.session_id, 'sess-1');
});

test('listSession orders by sequence, not by insertion', async () => {
  const driver = fakeDriver([
    {},
    { recordset: [{ id: 't1', session_id: 's', seq: 1, role: 'turn', goal: 'a', answer: null, at: null, metadata: null }] },
  ]);
  const s = createConversationMssqlStore({ connectionString: 'x', driver });
  await s.open();
  await s.listSession('s');
  assert.match(driver.queries.at(-1).text, /ORDER BY seq ASC/);
});

test('purgeSessions with no predicate removes nothing', async () => {
  const driver = fakeDriver();
  const s = createConversationMssqlStore({ connectionString: 'x', driver });
  await s.open();
  assert.equal(await s.purgeSessions({}), 0);
  assert.equal(driver.queries.length, 1);
});
