// host/checkpoint/record.mjs
//
// The one record a run checkpoints to.
//
// It replaces two: `host/memory/run-state.mjs`, written after each step for
// crash recovery, and `host/human-input/snapshot.mjs`, written at a pause.
// Three facts lived in both — the plan, the step cursor, and the observations
// — with two writers, two homes, and nothing saying which won when they
// disagreed.
//
// This module knows only the shape. Where it lands, and when, is
// `host/checkpoint/index.mjs`.

import { assertSafeMemoryId } from '../memory/store/interface.mjs';
import { createHash } from 'node:crypto';

export const CHECKPOINT_VERSION = 1;

/**
 * The row a run's checkpoint lives in.
 *
 * Keyed on the task id alone. The retired run-state keyed on
 * `task.id ?? task.goal`, so two concurrent runs of the same goal shared one
 * row and silently clobbered each other. A task with no id has no identity to
 * key on, and inventing one would hide the same bug rather than fix it.
 */
export function checkpointKey(task) {
  const id = task?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('checkpointKey requires an id on the task; a goal is not unique');
  }
  assertSafeMemoryId(id);
  return `cp-${id}`;
}

// Anything that looks like proof of identity rather than identity itself.
// Matched case-insensitively against key names at every depth.
//
// These are *roots*, matched as substrings of the normalised key, because real
// key names are compounds: `client_secret`, `x-api-key`, `set-cookie`,
// `refresh_token_value`. Exact matching caught `secret` and let `client_secret`
// straight through, which is the shape every one of these arrives in.
//
// The bias is deliberate. A false positive scrubs one field out of a
// disposable cache — history is the truth and can rebuild it. A false negative
// leaves a live credential in a store for the length of the run. Over-scrub.
const CREDENTIAL_ROOTS = [
  'token', 'bearer', 'authorization', 'auth', 'apikey', 'secret',
  'password', 'passwd', 'credential', 'cookie', 'session',
  'privatekey', 'signature', 'sas', 'connectionstring',
];

const isCredentialKey = (key) => {
  const k = String(key).toLowerCase().replace(/[-_\s]/g, '');
  return CREDENTIAL_ROOTS.some(root => k.includes(root));
};

/**
 * Strip credential-shaped keys from arbitrary nested state.
 *
 * `conversation` and `observations` carry whatever the strategies put there,
 * which we do not control, and this sits in a store for as long as the run
 * takes. Second line of defence behind the identity allow-list below.
 */
export function scrub(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;      // a cycle cannot be serialised anyway
  seen.add(value);

  if (Array.isArray(value)) return value.map(v => scrub(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isCredentialKey(k)) continue;
    out[k] = scrub(v, seen);
  }
  return out;
}

// Allow-listed rather than filtered, because a filter only removes the
// credential shapes we thought of. Add a field here deliberately or it does
// not survive a checkpoint.
function safeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const out = {};
  if (identity.personId != null) out.personId = identity.personId;
  if (identity.tenantId != null) out.tenantId = identity.tenantId;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Build the record.
 *
 * Everything here is also derivable from history — that is the contract that
 * keeps the checkpoint a cache rather than a second source of truth. A field
 * added here that is *not* derivable means `rebuildFromHistory` must learn to
 * produce it too, or a cold resume silently loses it.
 */
// Facts with no id are all kept: there is nothing to dedupe on, and dropping
// them would lose part of what the run actually saw.
function dedupeById(facts = []) {
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const id = f?.id;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(f);
  }
  return out;
}

export function createCheckpointRecord({
  taskKey, jobId = null, traceId = null, kitVersion = null,
  task = null, agentName = null, agentDescription = null, strategy = null,
  plan = null, observations = [], idempotencyKeys = [],
  conversation = [], recalledFacts = [],
  budget = null, interruptions = 0,
  identity = null, pendingBatchId = null, workspace = null,
  writtenAt = new Date(),
} = {}) {
  return {
    version: CHECKPOINT_VERSION,
    kitVersion,
    taskKey, jobId, traceId,
    writtenAt: (writtenAt instanceof Date ? writtenAt : new Date(writtenAt)).toISOString(),

    // what the run is
    task: scrub(task),
    agentName, agentDescription, strategy,

    // where it got to
    plan: plan ? { steps: scrub(plan.steps ?? []), cursor: plan.cursor ?? 0 } : null,
    observations: scrub(observations),
    idempotencyKeys: [...idempotencyKeys],

    // what it was given, so a resume reproduces the prompt it had
    conversation: scrub(conversation),
    // Deduped by id. A long run recalls on every iteration and rewrites this
    // record each time; appending without deduping grows the row until it no
    // longer fits the store. The first occurrence wins — what the run was
    // given first is what it reasoned on.
    recalledFacts: scrub(dedupeById(recalledFacts)),

    // accounting
    budget: budget ? { ...budget } : null,
    // MUST persist. Without it `maxInterruptions` resets on every resume and
    // never trips — a run could ask forever, one question per resume.
    interruptions,

    // who, and what it is waiting on
    identity: safeIdentity(identity),
    pendingBatchId,
    // Recorded for incidents, not for resume: a resume deliberately takes a
    // fresh worker. It is here so "which worker did this" is answerable.
    workspace: workspace ? { workerId: workspace.workerId ?? null } : null,
  };
}

/**
 * Read a checkpoint back.
 *
 * Refuses rather than guesses. A record written by a different build may have
 * meant something different by the same field name, and resuming on a misread
 * plan cursor re-executes work that already happened.
 *
 * @returns {{ok: true, checkpoint: object} | {ok: false, reason: string, detail?: any}}
 */
export function validateCheckpoint(raw) {
  if (raw == null) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'unreadable' };
  if (raw.version !== CHECKPOINT_VERSION) {
    return {
      ok: false,
      reason: 'incompatible_version',
      detail: { found: raw.version ?? null, expected: CHECKPOINT_VERSION },
    };
  }
  if (typeof raw.taskKey !== 'string' || !raw.taskKey) {
    return { ok: false, reason: 'unreadable', detail: 'taskKey' };
  }

  return {
    ok: true,
    checkpoint: {
      ...raw,
      observations: raw.observations ?? [],
      idempotencyKeys: raw.idempotencyKeys ?? [],
      conversation: raw.conversation ?? [],
      recalledFacts: raw.recalledFacts ?? [],
      interruptions: raw.interruptions ?? 0,
      plan: raw.plan ?? null,
    },
  };
}

/**
 * The key that says "this step already ran".
 *
 * It must be stable across a resume, distinguish two steps that differ only in
 * their arguments, and carry no credential. The arguments are scrubbed and
 * then hashed rather than embedded: `plan.steps` was already scrubbed, and the
 * old key format wrote the same arguments verbatim one field over, so a secret
 * removed from one place was stored in another.
 */
export function stepIdempotencyKey(step, index) {
  const args = scrub(step?.args ?? {});
  const digest = createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 16);
  return `${step?.tool ?? step?.type}-${digest}-${index}`;
}

/** Key order must not change the hash, or a resume would re-run every step. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
