// tests/host-jobs-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveDispatchConfig, resolveNotifyConfigWithEnv } = await import('../host/jobs/config.mjs');

test('dispatch defaults and lease timeout derive from budgets', () => {
  const c = resolveDispatchConfig({ enabled: true }, { env: {}, budgetsConfig: { timeoutMs: 600_000 } });
  assert.equal(c.backend, 'in-process');
  assert.equal(c.maxQueueSize, 100);
  assert.equal(c.concurrency, 1);
  assert.equal(c.leaseTimeoutMs, 660_000);
  assert.equal(c.retentionMs, 86_400_000);
  assert.equal(c.drainMs, 30_000);
  assert.equal(c.store.kind, 'sqlite');
  assert.match(c.store.dbPath, /workdir[\\/]jobs\.db$/);
  // activityRetry defaults to a single attempt — one run of the activity and
  // no retry, which is the behaviour that was there before it existed.
  assert.deepEqual(c.durable, {
    taskHub: 'fleetjobs', pollMs: 2000, maxActivityMs: 3_600_000,
    activityRetry: { maxAttempts: 1 },
  });
});

test('dispatch env overrides win over config values', () => {
  const c = resolveDispatchConfig({ enabled: true, maxQueueSize: 5 }, {
    env: { JOBS_BACKEND: 'durable', JOBS_MAX_QUEUE_SIZE: '7', JOBS_CONCURRENCY: '2', JOBS_DB_PATH: '/data/j.db', JOBS_RETENTION_MS: '1000', DURABLE_TASK_HUB: 'hub2' },
    budgetsConfig: null,
  });
  assert.equal(c.backend, 'durable'); assert.equal(c.maxQueueSize, 7); assert.equal(c.concurrency, 2);
  assert.equal(c.store.dbPath, '/data/j.db'); assert.equal(c.retentionMs, 1000); assert.equal(c.durable.taskHub, 'hub2');
  assert.equal(c.leaseTimeoutMs, 660_000);
});

test('DURABLE_POLL_MS overrides dispatch.durable.pollMs', () => {
  const c = resolveDispatchConfig({ enabled: true }, { env: { DURABLE_POLL_MS: '500' } });
  assert.equal(c.durable.pollMs, 500);
});

test('dispatch rejects unknown backend and store kind', () => {
  assert.throws(() => resolveDispatchConfig({ enabled: true, backend: 'redis' }, { env: {} }), /backend/);
  assert.throws(() => resolveDispatchConfig({ enabled: true, store: { kind: 'postgres' } }, { env: {} }), /store\.kind/);
});

test('notify env override for allowHttp', () => {
  assert.equal(resolveNotifyConfigWithEnv({}, { WEBHOOK_ALLOW_HTTP: 'true' }).webhook.allowHttp, true);
  assert.equal(resolveNotifyConfigWithEnv({ webhook: { allowHttp: true } }, {}).webhook.allowHttp, true);
  assert.equal(resolveNotifyConfigWithEnv({}, {}).webhook.allowHttp, false);
});
