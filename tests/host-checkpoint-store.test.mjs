// tests/host-checkpoint-store.test.mjs
//
// Where the checkpoint lands, and what happens when it cannot.
//
// A checkpoint is crash recovery. Losing one degrades that and must not take
// down a run that is otherwise fine — so `save` returns a boolean rather than
// throwing, and the caller decides what a false means. The one caller for whom
// it is fatal is a pause: an unsaved pause is a question nobody will answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createCheckpoint } = await import('../host/checkpoint/index.mjs');
const { CHECKPOINT_VERSION } = await import('../host/checkpoint/record.mjs');

/** A memory store double. The contract is MEMORY_STORE_METHODS. */
function fakeStore({ failOn = null } = {}) {
  const rows = new Map();
  return {
    rows,
    async open() {}, async close() {},
    async store(e) { if (failOn === 'store') throw new Error('store down'); rows.set(e.id, e); },
    async get(id) { if (failOn === 'get') throw new Error('store down'); return rows.get(id) ?? null; },
    async update(id, patch) { if (failOn === 'update') throw new Error('store down'); rows.set(id, { ...rows.get(id), ...patch }); },
    async remove(id) { rows.delete(id); },
    async query() { return []; }, async purge() {}, async count() { return rows.size; },
  };
}

const fields = () => ({
  jobId: 'job-1', task: { goal: 'g' }, strategy: 'plan-execute',
  agentName: 'kit', plan: { steps: ['a'], cursor: 0 }, observations: [],
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('save then load round-trips the record', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  assert.equal(await cp.save('cp-job-1', fields()), true);

  const out = await cp.load('cp-job-1');
  assert.equal(out.ok, true);
  assert.equal(out.checkpoint.version, CHECKPOINT_VERSION);
  assert.equal(out.checkpoint.strategy, 'plan-execute');
  assert.equal(out.checkpoint.taskKey, 'cp-job-1');
});

test('save twice updates one row rather than creating two', async () => {
  // Two triggers write this record — after each step, and at a pause. If each
  // created a row the store would grow with the run.
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());
  await cp.save('cp-job-1', { ...fields(), plan: { steps: ['a'], cursor: 1 } });

  assert.equal(store.rows.size, 1);
  assert.equal((await cp.load('cp-job-1')).checkpoint.plan.cursor, 1);
});

test('the stored entry is a valid memory entry', async () => {
  // It rides in the memory store, so it must look like something that store
  // will accept — the retired run-state used the same shape.
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());

  const entry = store.rows.get('cp-job-1');
  assert.equal(entry.kind, 'procedure');
  assert.equal(entry.source, 'system');
  assert.equal(typeof entry.text, 'string');
  assert.ok(entry.tags.includes('__checkpoint__'));
});

test('clear removes the row', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());
  await cp.clear('cp-job-1');
  assert.equal(store.rows.size, 0);
});

// ---------------------------------------------------------------------------
// When the store is unreachable
// ---------------------------------------------------------------------------

test('a failed save returns false and does not throw', async () => {
  // Losing a checkpoint degrades crash recovery. It must not take down a run
  // that is otherwise fine — the caller decides what a false means.
  const cp = createCheckpoint({ store: fakeStore({ failOn: 'store' }), logger: { warn() {} } });
  assert.equal(await cp.save('cp-job-1', fields()), false);
});

test('a failed update on an existing row also returns false', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());

  store.update = async () => { throw new Error('store down'); };
  assert.equal(await cp.save('cp-job-1', fields()), false);
});

test('a failed load reports rather than throwing', async () => {
  const cp = createCheckpoint({ store: fakeStore({ failOn: 'get' }), logger: { warn() {} } });
  const out = await cp.load('cp-job-1');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unreadable');
});

test('load of a missing checkpoint is absent, not an error', async () => {
  // A run that never checkpointed is the normal first case, not a fault.
  const cp = createCheckpoint({ store: fakeStore(), logger: { warn() {} } });
  assert.equal((await cp.load('cp-nope')).reason, 'absent');
});

test('a row holding unparseable text is unreadable, not a crash', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  store.rows.set('cp-job-1', { id: 'cp-job-1', text: 'not json' });
  assert.equal((await cp.load('cp-job-1')).reason, 'unreadable');
});

test('a clear that fails does not throw', async () => {
  const store = fakeStore();
  store.remove = async () => { throw new Error('store down'); };
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.clear('cp-job-1');   // must not reject
});

// ---------------------------------------------------------------------------
// Idempotency keys — carried over from run-state
// ---------------------------------------------------------------------------

test('idempotency keys survive a round trip', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());

  assert.equal(await cp.hasIdempotencyKey('cp-job-1', 'weather-{}-0'), false);
  await cp.addIdempotencyKey('cp-job-1', 'weather-{}-0');
  assert.equal(await cp.hasIdempotencyKey('cp-job-1', 'weather-{}-0'), true);
});

test('adding the same idempotency key twice does not duplicate it', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());
  await cp.addIdempotencyKey('cp-job-1', 'k');
  await cp.addIdempotencyKey('cp-job-1', 'k');

  assert.deepEqual((await cp.load('cp-job-1')).checkpoint.idempotencyKeys, ['k']);
});

test('idempotency on a run with no checkpoint answers false rather than throwing', async () => {
  const cp = createCheckpoint({ store: fakeStore(), logger: { warn() {} } });
  assert.equal(await cp.hasIdempotencyKey('cp-nope', 'k'), false);
  await cp.addIdempotencyKey('cp-nope', 'k');   // must not reject
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('a checkpoint without a store is a wiring error, caught at construction', async () => {
  assert.throws(() => createCheckpoint({}), /requires a memory store/);
});

// ---------------------------------------------------------------------------
// Against a real store
// ---------------------------------------------------------------------------

test('the entry is accepted by the real sqlite store, not just by a double', async () => {
  // Regression. The double above accepts any object, so a partial entry passed
  // every test here and then failed at insert with "Provided value cannot be
  // bound to SQLite parameter 7" — a checkpoint that could never be written,
  // which made every pause fail.
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-sqlite-'));
  const store = createSqliteStore({ dbPath: path.join(dir, 'memory.db') });
  await store.open();

  try {
    const cp = createCheckpoint({ store, logger: { warn() {} } });
    assert.equal(await cp.save('cp-job-1', fields()), true, 'the real store accepted it');

    const out = await cp.load('cp-job-1');
    assert.equal(out.ok, true);
    assert.equal(out.checkpoint.strategy, 'plan-execute');

    // And an update path, which takes a different code path to the insert.
    assert.equal(await cp.save('cp-job-1', { ...fields(), plan: { steps: ['a'], cursor: 2 } }), true);
    assert.equal((await cp.load('cp-job-1')).checkpoint.plan.cursor, 2);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// One row, several writers
//
// The strategies write the checkpoint as the run advances; the pause path
// writes it again on the way out. The pause writer does not know the
// idempotency keys — they live in the strategy's loop — so a save that
// replaced the row wholesale erased them, and the resumed run re-executed the
// irreversible step it had already completed.
// ---------------------------------------------------------------------------

test('a save preserves fields the writer did not mention', async () => {
  const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-merge-'));
  const store = createSqliteStore({ dbPath: path.join(dir, 'memory.db') });
  await store.open();
  const cp = createCheckpoint({ store, logger: { warn() {}, info() {} } });

  // The strategy, mid-run.
  await cp.save('cp-job-1', {
    jobId: 'job-1', task: { id: 'job-1', goal: 'g' },
    observations: [{ type: 'observation', tool: 'book' }],
    idempotencyKeys: ['book-{"x":1}-0'],
    conversation: [{ role: 'user', text: 'hi' }],
    plan: { steps: [{ type: 'tool', tool: 'book' }], cursor: 0 },
  });

  // The pause path, which knows nothing about idempotency keys.
  await cp.save('cp-job-1', {
    jobId: 'job-1', task: { id: 'job-1', goal: 'g' },
    observations: [{ type: 'observation', tool: 'book' }],
    plan: { steps: [{ type: 'tool', tool: 'book' }], cursor: 0 },
    pendingBatchId: 'inp-1',
  });

  const after = await cp.load('cp-job-1');
  assert.equal(after.ok, true);
  assert.deepEqual(after.checkpoint.idempotencyKeys, ['book-{"x":1}-0'], 'the keys survived the pause');
  assert.deepEqual(after.checkpoint.conversation, [{ role: 'user', text: 'hi' }]);
  assert.equal(after.checkpoint.pendingBatchId, 'inp-1', 'and the pause still recorded its batch');
  await store.close();
});

test('a writer that does mention a field still wins', async () => {
  // Merging must not make a field unclearable, or settling could never drop
  // the parked batch.
  const { createSqliteStore } = await import('../host/memory/store/sqlite.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-merge2-'));
  const store = createSqliteStore({ dbPath: path.join(dir, 'memory.db') });
  await store.open();
  const cp = createCheckpoint({ store, logger: { warn() {}, info() {} } });

  await cp.save('cp-job-2', { jobId: 'job-2', task: { id: 'job-2', goal: 'g' }, pendingBatchId: 'inp-1', idempotencyKeys: ['a'] });
  await cp.save('cp-job-2', { jobId: 'job-2', task: { id: 'job-2', goal: 'g' }, pendingBatchId: null, idempotencyKeys: ['a', 'b'] });

  const after = await cp.load('cp-job-2');
  assert.equal(after.checkpoint.pendingBatchId, null, 'an explicit null clears it');
  assert.deepEqual(after.checkpoint.idempotencyKeys, ['a', 'b']);
  await store.close();
});
