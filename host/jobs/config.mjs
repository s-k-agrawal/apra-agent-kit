// host/jobs/config.mjs
import path from 'node:path';
import { resolveNotifyConfig } from '../notify/index.mjs';
import { STORE_KINDS as STORE_KIND_NAMES, resolveStoreKind } from './store/resolve.mjs';

export const DISPATCH_DEFAULTS = {
  enabled: false,
  backend: 'in-process',
  maxQueueSize: 100,
  concurrency: 1,
  retentionMs: 86_400_000,
  drainMs: 30_000,
  // 'auto' resolves per backend: sqlite on a VM, the task hub on Functions.
  // An adopter who never touches storage config gets the right thing on both.
  store: { kind: 'auto', dbPath: path.join('workdir', 'jobs.db') },
  durable: {
    taskHub: 'fleetjobs', pollMs: 2000, maxActivityMs: 3_600_000,
    // How many times the orchestrator will run a step activity before giving
    // up. The default of 1 is one attempt and no retry — the behaviour that
    // was there before this existed. It is worth setting above 1 where a
    // *workflow* route runs on Functions: a workflow executes to completion
    // inside a single activity with no checkpoint between its phases, so a
    // worker recycle loses all of it.
    activityRetry: { maxAttempts: 1 },
  },
};
const BACKENDS = new Set(['in-process', 'durable']);
const STORE_KINDS = new Set(STORE_KIND_NAMES);

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

export function resolveDispatchConfig(raw = {}, { env = process.env, budgetsConfig = null } = {}) {
  const merged = {
    ...DISPATCH_DEFAULTS, ...raw,
    store: { ...DISPATCH_DEFAULTS.store, ...(raw.store ?? {}) },
    durable: {
      ...DISPATCH_DEFAULTS.durable,
      ...(raw.durable ?? {}),
      activityRetry: {
        ...DISPATCH_DEFAULTS.durable.activityRetry,
        ...(raw.durable?.activityRetry ?? {}),
      },
    },
  };
  merged.backend = env.JOBS_BACKEND || merged.backend;
  merged.maxQueueSize = intEnv(env, 'JOBS_MAX_QUEUE_SIZE', merged.maxQueueSize);
  merged.concurrency = intEnv(env, 'JOBS_CONCURRENCY', merged.concurrency);
  merged.retentionMs = intEnv(env, 'JOBS_RETENTION_MS', merged.retentionMs);
  merged.store.dbPath = env.JOBS_DB_PATH || merged.store.dbPath;
  merged.durable.taskHub = env.DURABLE_TASK_HUB || merged.durable.taskHub;
  merged.durable.pollMs = intEnv(env, 'DURABLE_POLL_MS', merged.durable.pollMs);
  merged.durable.activityRetry.maxAttempts = intEnv(
    env, 'DURABLE_ACTIVITY_MAX_ATTEMPTS', merged.durable.activityRetry.maxAttempts,
  );
  // Zero would mean "never run the activity", which is not a retry policy.
  if (!Number.isInteger(merged.durable.activityRetry.maxAttempts) || merged.durable.activityRetry.maxAttempts < 1) {
    throw new Error(
      `dispatch.durable.activityRetry.maxAttempts must be an integer >= 1 (1 means one attempt, no retry), ` +
      `got ${merged.durable.activityRetry.maxAttempts}`,
    );
  }
  if (merged.leaseTimeoutMs === undefined) {
    merged.leaseTimeoutMs = typeof budgetsConfig?.timeoutMs === 'number' ? budgetsConfig.timeoutMs + 60_000 : 660_000;
  }
  if (!BACKENDS.has(merged.backend)) throw new Error(`dispatch.backend must be one of ${[...BACKENDS].join(', ')}, got "${merged.backend}"`);
  if (!STORE_KINDS.has(merged.store.kind)) throw new Error(`dispatch.store.kind must be one of ${[...STORE_KINDS].join(', ')}, got "${merged.store.kind}"`);
  // Resolve 'auto' here rather than at the point of use, so everything
  // downstream - the backend, the retention sweep, the logs - sees one
  // concrete kind and nobody has to re-derive it.
  merged.store = resolveStoreKind(merged.store, merged.backend);
  merged.retention = resolveRetentionConfig(raw.retention, { env });
  return merged;
}

export function resolveNotifyConfigWithEnv(raw = {}, env = process.env) {
  const config = resolveNotifyConfig(raw);
  const flag = String(env.WEBHOOK_ALLOW_HTTP ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') config.webhook.allowHttp = true;
  return config;
}

// Retention is two independent things, and conflating them is how people lose
// history they meant to keep.
//
//   archive — a long-term copy of a settled run, off by default
//   expiry  — clearing settled records out of the operational store
//
// Purging is load-bearing, not housekeeping: the sweep that expires unanswered
// questions scans the store, so an un-purged store degrades it until it stops
// working. But the operational store is not an archive, so an adopter who
// needs the audit trail has to turn archiving on deliberately.
export const RETENTION_DEFAULTS = Object.freeze({
  archive: Object.freeze({ enabled: false, store: 'cosmos', when: 'on_settle' }),
  expiry: Object.freeze({ afterDays: 30, mode: 'auto', graceDays: 1, sweepIntervalMs: 3_600_000 }),
});

const ARCHIVE_WHEN = new Set(['on_settle', 'before_purge']);
const EXPIRY_MODES = new Set(['auto', 'manual', 'both']);

export function resolveRetentionConfig(raw = {}, { env = process.env } = {}) {
  const archive = { ...RETENTION_DEFAULTS.archive, ...(raw?.archive ?? {}) };
  const expiry = { ...RETENTION_DEFAULTS.expiry, ...(raw?.expiry ?? {}) };

  expiry.afterDays = intEnv(env, 'JOBS_RETENTION_DAYS', expiry.afterDays);
  if (env.JOBS_RETENTION_MODE) expiry.mode = env.JOBS_RETENTION_MODE;

  if (!ARCHIVE_WHEN.has(archive.when)) {
    throw new Error(`retention.archive.when must be one of ${[...ARCHIVE_WHEN].join(', ')}, got "${archive.when}"`);
  }
  if (!EXPIRY_MODES.has(expiry.mode)) {
    throw new Error(`retention.expiry.mode must be one of ${[...EXPIRY_MODES].join(', ')}, got "${expiry.mode}"`);
  }
  if (!(Number.isFinite(expiry.afterDays) && expiry.afterDays > 0)) {
    throw new Error(`retention.expiry.afterDays must be a positive number, got ${expiry.afterDays}`);
  }
  if (!(Number.isFinite(expiry.graceDays) && expiry.graceDays >= 0)) {
    throw new Error(`retention.expiry.graceDays must be zero or more, got ${expiry.graceDays}`);
  }
  if (archive.enabled && !archive.store) {
    throw new Error('retention.archive.enabled requires retention.archive.store');
  }

  return Object.freeze({ archive: Object.freeze(archive), expiry: Object.freeze(expiry) });
}
