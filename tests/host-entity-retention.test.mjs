// tests/host-entity-retention.test.mjs
//
// Entities outlive the orchestrations that made them — that is the point, and
// it is also the leak. Purging instances does not touch them, so without a
// sweep the storage account grows a checkpoint per run, forever.
//
// The rule that matters here is the one that already governs instance purging:
// a run parked on a question keeps its state whatever its age, because its
// entity is the only copy of what the answer resumes from. A blanket sweep by
// age would quietly make every waiting question unanswerable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { purgeStaleEntities, shouldKeepEntity } = await import('../host/jobs/entity-retention.mjs');

const NOW = new Date('2026-09-30T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const daysAhead = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const entity = (over = {}) => ({ name: 'checkpoint', key: 'cp-job-1', state: {}, lastUpdatedAt: daysAgo(1), ...over });

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('a recent entity is kept', () => {
  assert.equal(shouldKeepEntity(entity({ lastUpdatedAt: daysAgo(2) }), new Set(), { now: NOW }), true);
});

test('an old entity nobody is waiting on is dropped', () => {
  assert.equal(shouldKeepEntity(entity({ lastUpdatedAt: daysAgo(40) }), new Set(), { now: NOW }), false);
});

test('an old entity belonging to a paused run is kept anyway', () => {
  // The load-bearing case. Its state is the only copy of what the answer
  // resumes from; dropping it makes the question unanswerable.
  const live = new Set(['cp-job-1']);
  const e = entity({ lastUpdatedAt: daysAgo(40), state: { pendingInput: { expiresAt: daysAhead(3) } } });
  assert.equal(shouldKeepEntity(e, live, { now: NOW }), true);
});

test('but not forever — past its own deadline plus grace it goes', () => {
  // An unconditional shield means a broken sweep keeps entities for ever,
  // which is the very thing that breaks the sweep.
  const live = new Set(['cp-job-1']);
  const e = entity({ lastUpdatedAt: daysAgo(40), state: { pendingInput: { expiresAt: daysAgo(5) } } });
  assert.equal(shouldKeepEntity(e, live, { now: NOW, graceDays: 1 }), false);
});

test('an unreadable date is kept, not guessed at', () => {
  // Deleting state we cannot reason about is the worse of the two mistakes.
  assert.equal(shouldKeepEntity(entity({ lastUpdatedAt: 'nonsense' }), new Set(), { now: NOW }), true);
  const live = new Set(['cp-job-1']);
  assert.equal(shouldKeepEntity(entity({ state: { pendingInput: {} } }), live, { now: NOW }), true);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

function fakeClient(completed = []) {
  const cleared = [];
  return {
    cleared,
    async getStatusBy() { return completed; },
    async signalEntity(id, op) { if (op === 'clear') cleared.push(id.key); },
  };
}

test('the sweep clears the stale and keeps the rest', async () => {
  const client = fakeClient();
  const out = await purgeStaleEntities({
    client,
    listEntities: async () => [
      entity({ key: 'cp-old', lastUpdatedAt: daysAgo(40) }),
      entity({ key: 'cp-new', lastUpdatedAt: daysAgo(1) }),
    ],
    logger: { warn() {} },
    now: () => NOW,
  });

  assert.deepEqual(client.cleared, ['cp-old']);
  assert.equal(out.purged, 1);
  assert.equal(out.kept, 1);
});

test('the sweep will not clear a run still waiting on a person', async () => {
  const client = fakeClient([
    { customStatus: { status: 'waiting_input' }, output: { status: 'paused', checkpointKey: 'cp-waiting' } },
  ]);
  const out = await purgeStaleEntities({
    client,
    listEntities: async () => [
      entity({ key: 'cp-waiting', lastUpdatedAt: daysAgo(40), state: { pendingInput: { expiresAt: daysAhead(2) } } }),
    ],
    logger: { warn() {} },
    now: () => NOW,
  });

  assert.deepEqual(client.cleared, [], 'nothing was cleared');
  assert.equal(out.kept, 1);
});

test('a sweep that cannot enumerate entities does nothing rather than guessing', async () => {
  const out = await purgeStaleEntities({ client: fakeClient(), logger: { warn() {} } });
  assert.deepEqual(out, { purged: 0, kept: 0 });
});

test('a failing sweep does not take the host down', async () => {
  const warnings = [];
  const out = await purgeStaleEntities({
    client: fakeClient(),
    listEntities: async () => { throw new Error('storage down'); },
    logger: { warn: (m) => warnings.push(m) },
    now: () => NOW,
  });
  assert.deepEqual(out, { purged: 0, kept: 0 });
  assert.ok(warnings.some(w => /storage down/.test(w)));
});

test('one entity failing to clear does not stop the others', async () => {
  const client = fakeClient();
  let first = true;
  client.signalEntity = async (id, op) => {
    if (first) { first = false; throw new Error('transient'); }
    if (op === 'clear') client.cleared.push(id.key);
  };
  const out = await purgeStaleEntities({
    client,
    listEntities: async () => [
      entity({ key: 'cp-a', lastUpdatedAt: daysAgo(40) }),
      entity({ key: 'cp-b', lastUpdatedAt: daysAgo(40) }),
    ],
    logger: { warn() {} },
    now: () => NOW,
  });
  assert.deepEqual(client.cleared, ['cp-b']);
  assert.equal(out.purged, 1);
});
