// tests/host-retention.test.mjs
//
// Clearing settled records out of the operational store.
//
// Records, not questions. A question expires after 7 days and settles a run; a
// record expires after 30 days and is deleted. Different clocks, different
// consequences, never the same operation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createArchive } = await import('../host/retention/archive.mjs');
const { createExpiry, eligibility } = await import('../host/retention/expiry.mjs');
const { createRetention } = await import('../host/retention/index.mjs');
const { buildRetentionRoutes } = await import('../host/retention/routes.mjs');
const { resolveStoreKind, STORE_KINDS, createStore } = await import('../host/jobs/store/resolve.mjs');
const { resolveRetentionConfig, resolveDispatchConfig, RETENTION_DEFAULTS } = await import('../host/jobs/config.mjs');
const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');

const DAY = 86_400_000;
const NOW = new Date('2026-09-28T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString();
const daysAhead = (n) => new Date(NOW.getTime() + n * DAY).toISOString();

const settled = (id, { days = 60, status = 'completed', ...rest } = {}) =>
  ({ id, status, finishedAt: daysAgo(days), ...rest });

const waiting = (id, { expiresAt = daysAhead(5) } = {}) =>
  ({ id, status: 'waiting_input', finishedAt: null, pendingInput: { batchId: `inp-${id}`, expiresAt } });

// ---------------------------------------------------------------------------
// store.kind: 'auto'
// ---------------------------------------------------------------------------

test('auto: resolves to sqlite on a VM and the task hub on Functions', () => {
  // The common case should need no decision.
  assert.equal(resolveStoreKind({ kind: 'auto' }, 'in-process').kind, 'sqlite');
  assert.equal(resolveStoreKind({ kind: 'auto' }, 'durable').kind, 'taskhub');
  assert.equal(resolveStoreKind({}, 'in-process').kind, 'sqlite', 'absent means auto');
});

test('auto: an explicit kind always wins, including cosmos on Functions', () => {
  assert.equal(resolveStoreKind({ kind: 'cosmos' }, 'durable').kind, 'cosmos');
  assert.equal(resolveStoreKind({ kind: 'memory' }, 'in-process').kind, 'memory');
  assert.equal(resolveStoreKind({ kind: 'cosmos' }, 'durable').resolvedFrom, 'explicit');
  assert.equal(resolveStoreKind({ kind: 'auto' }, 'durable').resolvedFrom, 'auto');
});

test('auto: taskhub without the durable backend fails loudly', () => {
  // Falling back to sqlite would leave somebody to discover their jobs are not
  // where they expected.
  assert.throws(() => resolveStoreKind({ kind: 'taskhub' }, 'in-process'), /requires dispatch.backend "durable"/);
});

test('auto: an unknown kind names the valid ones', () => {
  assert.throws(() => resolveStoreKind({ kind: 'postgres' }, 'in-process'), (err) => {
    for (const kind of STORE_KINDS) assert.ok(err.message.includes(kind), `should name ${kind}`);
    return true;
  });
});

test('auto: dispatch config resolves the kind once, for everything downstream', () => {
  const c = resolveDispatchConfig({ enabled: true }, { env: {} });
  assert.equal(c.store.kind, 'sqlite');
  assert.equal(c.store.resolvedFrom, 'auto');
});

test('auto: createStore refuses to build a store for taskhub', async () => {
  await assert.rejects(() => createStore({ kind: 'taskhub' }, 'durable'), /has no store module/);
});

test('auto: building a cosmos store loads no SDK and needs no credentials', async () => {
  // A clone that never selects cosmos never loads @azure/cosmos and never
  // needs it installed. Constructing one is cheap on purpose - `open()` is
  // where the dependency and the credentials are actually required, so a
  // misconfigured deployment fails at startup rather than at import time.
  const store = await createStore({ kind: 'cosmos' }, 'in-process');
  const { STORE_METHODS } = await import('../host/jobs/store/interface.mjs');
  for (const m of STORE_METHODS) {
    assert.equal(typeof store[m], 'function', `cosmos store must implement ${m}`);
  }
});

test('auto: a cosmos store with no endpoint says so when it opens', async () => {
  const store = await createStore({ kind: 'cosmos' }, 'in-process');
  await assert.rejects(
    () => store.open(),
    (err) => {
      // Either reason is legitimate: the SDK is absent, or it is present and
      // there are no credentials. Both name what to do about it.
      assert.match(err.message, /@azure\/cosmos|endpoint and key/);
      return true;
    },
  );
});

test('auto: the cosmos store satisfies the same contract as the other two', async () => {
  // The evidence that STORE_METHODS did not have to change to add a backend.
  const { assertJobStore } = await import('../host/jobs/store/interface.mjs');
  const { createCosmosStore } = await import('../host/jobs/store/cosmos.mjs');
  assert.doesNotThrow(() => assertJobStore(createCosmosStore({ endpoint: 'https://x', key: 'k' })));
});

// ---------------------------------------------------------------------------
// Retention config
// ---------------------------------------------------------------------------

test('config: archiving is off by default - history is lost at expiry unless asked for', () => {
  const c = resolveRetentionConfig();
  assert.equal(c.archive.enabled, false);
  assert.equal(c.expiry.afterDays, 30);
  assert.equal(c.expiry.mode, 'auto');
  assert.equal(c.expiry.graceDays, 1);
  assert.deepEqual(c, RETENTION_DEFAULTS);
});

test('config: nonsense is refused rather than run on', () => {
  assert.throws(() => resolveRetentionConfig({ expiry: { mode: 'sometimes' } }), /must be one of/);
  assert.throws(() => resolveRetentionConfig({ archive: { when: 'eventually' } }), /must be one of/);
  assert.throws(() => resolveRetentionConfig({ expiry: { afterDays: 0 } }), /positive number/);
  assert.throws(() => resolveRetentionConfig({ expiry: { graceDays: -1 } }), /zero or more/);
  assert.throws(() => resolveRetentionConfig({ archive: { enabled: true, store: null } }), /requires retention.archive.store/);
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

const opts = { now: NOW, afterDays: 30, graceDays: 1 };

test('eligible: a settled record older than the window', () => {
  assert.deepEqual(eligibility(settled('j1'), opts), { eligible: true, reason: 'settled' });
});

test('not eligible: a settled record inside the window', () => {
  assert.equal(eligibility(settled('j1', { days: 5 }), opts).reason, 'too_recent');
});

test('not eligible: a run still going', () => {
  assert.equal(eligibility({ id: 'j1', status: 'processing' }, opts).reason, 'active');
  assert.equal(eligibility({ id: 'j1', status: 'queued' }, opts).reason, 'active');
});

test('not eligible: a terminal record with no finishedAt is treated as active', () => {
  assert.equal(eligibility({ id: 'j1', status: 'completed', finishedAt: null }, opts).reason, 'active');
});

test('not eligible: a paused run inside its question window plus grace', () => {
  // A paused run *is* a completed instance on Azure. Purging one destroys the
  // only copy of its state.
  assert.equal(eligibility(waiting('j1'), opts).reason, 'waiting');
  assert.equal(eligibility(waiting('j1', { expiresAt: daysAgo(0.5) }), opts).reason, 'waiting',
    'still inside the one-day grace');
});

test('eligible: a paused run past its expiry plus grace - the skip is bounded', () => {
  // An unconditional "never purge waiting_input" means a broken question sweep
  // shields records forever and the store grows without bound - the exact
  // failure that breaks the sweep in the first place.
  const res = eligibility(waiting('j1', { expiresAt: daysAgo(3) }), opts);
  assert.equal(res.eligible, true);
  assert.equal(res.reason, 'waiting_past_grace');
});

test('not eligible: a paused run with no readable deadline is left alone', () => {
  assert.equal(eligibility({ id: 'j1', status: 'waiting_input', pendingInput: {} }, opts).reason, 'waiting');
});

test('not eligible: archiving is enabled and this one has not been archived', () => {
  const res = eligibility(settled('j1'), { ...opts, archived: () => false });
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'unarchived');
});

test('eligible: the archive check is last, so it never masks a simpler reason', () => {
  // "too_recent" is normal; "unarchived" needs attention. Reporting the wrong
  // one sends somebody looking at the wrong thing.
  const res = eligibility(settled('j1', { days: 5 }), { ...opts, archived: () => false });
  assert.equal(res.reason, 'too_recent');
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

function archiveHarness({ enabled = true, failInsert = false } = {}) {
  const store = createMemoryStore();
  const copies = [];
  const archiveStore = {
    insert: async (doc) => {
      if (failInsert) throw new Error('archive store unreachable');
      if (copies.some(c => c.id === doc.id)) throw new Error(`job ${doc.id} already exists`);
      copies.push(doc);
    },
  };
  const archive = createArchive({
    config: { enabled }, store, archiveStore, logger: { warn() {} },
  });
  return { store, archive, copies };
}

test('archive: disabled is a no-op that costs nothing', async () => {
  const { archive } = archiveHarness({ enabled: false });
  assert.equal(archive.enabled, false);
  assert.equal(archive.archived({ id: 'j1' }), true, 'nothing is waiting to be copied');
  assert.deepEqual(await archive.archive({ id: 'j1' }), { ok: true, skipped: 'disabled' });
});

test('archive: a settled run is copied with its history', async () => {
  const { store, archive, copies } = archiveHarness();
  await store.open();
  const { createRecord } = await import('../host/jobs/record.mjs');
  const rec = createRecord({ goal: 'g' }, { id: 'j1' });
  await store.insert(rec);
  await store.appendEvent('j1', { type: 'queued', jobId: 'j1', at: daysAgo(60) });
  await store.update('j1', { status: 'completed', finishedAt: daysAgo(60) });

  const res = await archive.archive(await store.get('j1'));
  assert.equal(res.ok, true);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].id, 'j1');
  assert.equal(copies[0].archivedHistory.length, 1, 'the history goes with it');
  assert.equal((await store.get('j1')).archivedAt, res.archivedAt, 'and the record remembers');
});

test('archive: an unreachable archive store reports rather than throwing', async () => {
  // The caller is a sweep over many records; one bad archive must not stop the rest.
  const { store, archive } = archiveHarness({ failInsert: true });
  await store.open();
  const { createRecord } = await import('../host/jobs/record.mjs');
  await store.insert(createRecord({ goal: 'g' }, { id: 'j1' }));

  const res = await archive.archive(await store.get('j1'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'archive_failed');
});

test('archive: a record already in the archive is a success, not a failure', async () => {
  // A retry after a partial pass lands here every time.
  const { store, archive, copies } = archiveHarness();
  await store.open();
  const { createRecord } = await import('../host/jobs/record.mjs');
  await store.insert(createRecord({ goal: 'g' }, { id: 'j1' }));
  copies.push({ id: 'j1' });

  const res = await archive.archive(await store.get('j1'));
  assert.equal(res.ok, true);
});

test('archive: archived() is what the purge asks, and it means it', async () => {
  const { archive } = archiveHarness();
  assert.equal(archive.archived({ id: 'j1' }), false);
  assert.equal(archive.archived({ id: 'j1', archivedAt: daysAgo(1) }), true);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

function sweepHarness({ records = [], archiveConfig = { enabled: false }, expiryConfig = {}, failInsert = false, failClear = null } = {}) {
  const cleared = [];
  const copies = [];
  const store = {
    events: async () => [],
    update: async (id, patch) => {
      const r = records.find(x => x.id === id);
      Object.assign(r, patch);
      return r;
    },
    listByStatus: async (s) => records.filter(r => r.status === s),
  };
  const archiveStore = {
    insert: async (doc) => { if (failInsert) throw new Error('unreachable'); copies.push(doc); },
  };
  const retention = createRetention({
    config: { archive: archiveConfig, expiry: { afterDays: 30, graceDays: 1, ...expiryConfig } },
    store,
    archiveStore,
    clear: async (id) => {
      if (failClear === id) throw new Error('delete failed');
      cleared.push(id);
    },
    listAll: async () => records,
    logger: { warn() {} },
    now: () => NOW,
  });
  return { retention, cleared, copies, records };
}

test('sweep: clears what is eligible and leaves what is not', async () => {
  const { retention, cleared } = sweepHarness({
    records: [settled('old'), settled('recent', { days: 2 }), { id: 'busy', status: 'processing' }],
  });
  const out = await retention.sweep();

  assert.deepEqual(cleared, ['old']);
  assert.equal(out.scanned, 3);
  assert.equal(out.cleared, 1);
  assert.equal(out.skipped.tooRecent, 1);
  assert.equal(out.skipped.active, 1);
});

test('sweep: dryRun reports what would go and clears nothing', async () => {
  // The first thing anyone sensible runs.
  const { retention, cleared } = sweepHarness({ records: [settled('old'), settled('older', { days: 90 })] });
  const out = await retention.sweep({ dryRun: true });

  assert.equal(out.cleared, 2);
  assert.equal(out.dryRun, true);
  assert.deepEqual(cleared, [], 'nothing was actually deleted');
});

test('sweep: a paused run survives, and one past its grace does not', async () => {
  const { retention, cleared } = sweepHarness({
    records: [waiting('live'), waiting('abandoned', { expiresAt: daysAgo(5) })],
  });
  const out = await retention.sweep();

  assert.deepEqual(cleared, ['abandoned']);
  assert.equal(out.skipped.waiting, 1);
});

test('sweep: never purge what failed to archive', async () => {
  // A purge that silently outruns a broken archive is the one way to lose data
  // permanently. The ordering is not negotiable.
  const { retention, cleared } = sweepHarness({
    records: [settled('old')],
    archiveConfig: { enabled: true, store: 'cosmos' },
    failInsert: true,
  });
  const out = await retention.sweep();

  assert.deepEqual(cleared, [], 'nothing was cleared');
  assert.equal(out.skipped.unarchived, 1);
  assert.equal(out.errors.length, 1);
});

test('sweep: the next pass retries a failed archive and then clears', async () => {
  const records = [settled('old')];
  let broken = true;
  const cleared = [];
  const retention = createRetention({
    config: { archive: { enabled: true, store: 'cosmos' }, expiry: { afterDays: 30, graceDays: 1 } },
    store: { events: async () => [], update: async (id, p) => Object.assign(records[0], p), listByStatus: async () => [] },
    archiveStore: { insert: async () => { if (broken) throw new Error('unreachable'); } },
    clear: async (id) => cleared.push(id),
    listAll: async () => records,
    logger: { warn() {} },
    now: () => NOW,
  });

  await retention.sweep();
  assert.deepEqual(cleared, []);

  broken = false;
  const second = await retention.sweep();
  assert.deepEqual(cleared, ['old']);
  assert.equal(second.archived, 1);
});

test('sweep: archiving happens before clearing, in the same pass', async () => {
  const { retention, cleared, copies } = sweepHarness({
    records: [settled('old')],
    archiveConfig: { enabled: true, store: 'cosmos' },
  });
  const out = await retention.sweep();

  assert.equal(out.archived, 1);
  assert.deepEqual(cleared, ['old']);
  assert.equal(copies.length, 1, 'copied before it was cleared');
});

test('sweep: one failed delete does not stop the pass', async () => {
  const { retention, cleared } = sweepHarness({
    records: [settled('bad'), settled('good')],
    failClear: 'bad',
  });
  const out = await retention.sweep();

  assert.deepEqual(cleared, ['good']);
  assert.equal(out.errors[0].reason, 'clear_failed');
});

test('sweep: olderThanDays narrows a manual pass', async () => {
  const { retention, cleared } = sweepHarness({ records: [settled('j1', { days: 10 })] });
  assert.equal((await retention.sweep()).cleared, 0);
  await retention.sweep({ olderThanDays: 5 });
  assert.deepEqual(cleared, ['j1']);
});

// ---------------------------------------------------------------------------
// Modes and the route
// ---------------------------------------------------------------------------

test('mode: manual clears nothing on a timer', async () => {
  // Some deployments are obliged to control deletion explicitly, and a timer
  // quietly doing it anyway would defeat the point of the setting.
  const { retention, cleared } = sweepHarness({ records: [settled('old')], expiryConfig: { mode: 'manual', sweepIntervalMs: 1 } });
  retention.start();
  await new Promise(r => setTimeout(r, 30));
  retention.stop();
  assert.deepEqual(cleared, []);
});

test('mode: the purge route is absent under auto and present under manual or both', () => {
  // Under auto the timer owns it; offering a manual trigger as well invites
  // two passes racing over the same records.
  for (const [mode, expected] of [['auto', false], ['manual', true], ['both', true]]) {
    const { retention } = sweepHarness({ expiryConfig: { mode } });
    assert.equal(retention.routeEnabled, expected, mode);
    assert.equal(buildRetentionRoutes({ retention }).jobsPurge === null, !expected, mode);
  }
});

test('route: a purge reports counts and separates the two kinds of skip', async () => {
  const { retention } = sweepHarness({
    records: [settled('old'), settled('recent', { days: 1 }), { id: 'busy', status: 'processing' }],
    expiryConfig: { mode: 'manual' },
  });
  const routes = buildRetentionRoutes({ retention });
  const res = await routes.jobsPurge.handler({ body: {} });

  assert.equal(res.status, 200);
  assert.equal(res.body.cleared, 1);
  assert.equal(res.body.skipped.active, 1);
  assert.equal(res.body.skipped.tooRecent, 1);
  assert.equal(res.body.skipped.unarchived, 0);
});

test('route: dryRun flows through and clears nothing', async () => {
  const { retention, cleared } = sweepHarness({ records: [settled('old')], expiryConfig: { mode: 'both' } });
  const res = await buildRetentionRoutes({ retention }).jobsPurge.handler({ body: { dryRun: true } });
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.cleared, 1);
  assert.deepEqual(cleared, []);
});

test('route: a nonsense olderThanDays is refused', async () => {
  const { retention } = sweepHarness({ expiryConfig: { mode: 'manual' } });
  const routes = buildRetentionRoutes({ retention });
  for (const bad of [0, -5, 'soon']) {
    const res = await routes.jobsPurge.handler({ body: { olderThanDays: bad } });
    assert.equal(res.status, 400, String(bad));
  }
});
