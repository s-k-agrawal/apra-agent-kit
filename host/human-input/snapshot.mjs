// host/human-input/snapshot.mjs
//
// A snapshot is a cache, not a record.
//
// It exists so a normal resume is one read instead of a full replay of
// history. Nothing may live only here: if it is absent, unreadable, or written
// at a version this build does not understand, the run is rebuilt from history
// and must come out identical. `rebuildFromHistory()` is the proof of that,
// and a test deletes the snapshot to force it.
//
// Credentials are never written. `identity` records *who* the work is for,
// never the bearer that proves it — these records live for days, and a resumed
// run re-acquires authority the same way a fresh one does.

export const SNAPSHOT_VERSION = 1;

// Anything that looks like proof of identity rather than identity itself. The
// list is matched case-insensitively against key names at every depth.
const CREDENTIAL_KEYS = [
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'bearer',
  'authorization', 'auth', 'apikey', 'api_key', 'secret',
  'password', 'passwd', 'credential', 'credentials', 'cookie', 'sessionid',
];

const isCredentialKey = (key) => {
  const k = String(key).toLowerCase().replace(/[-_]/g, '');
  return CREDENTIAL_KEYS.some(c => k === c.replace(/[-_]/g, ''));
};

// Identity is allow-listed rather than filtered, because a filter only removes
// the credential shapes we thought of. Add a field here deliberately or it does
// not survive a pause.
function safeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const out = {};
  if (identity.personId != null) out.personId = identity.personId;
  if (identity.tenantId != null) out.tenantId = identity.tenantId;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Strip credential-shaped keys from arbitrary nested state.
 *
 * `conversation` and `observations` carry whatever the strategies put there,
 * which we do not control. This is the second line of defence behind
 * `safeIdentity` — belt and braces, on data that is about to sit in storage
 * for a week.
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

/**
 * Capture the state a resume needs.
 *
 * Everything here is also derivable from history — that is the contract. If a
 * field is added that is *not*, `rebuildFromHistory` must learn to produce it
 * too, or a cold resume silently loses it.
 */
export function capture({
  jobId,
  traceId = null,
  kitVersion = null,
  task,
  conversation = [],
  plan = null,
  observations = [],
  budget = null,
  interruptions = 0,
  identity = null,
  pendingBatchId = null,
  writtenAt = new Date(),
} = {}) {
  return {
    version: SNAPSHOT_VERSION,
    kitVersion,
    jobId,
    traceId,
    writtenAt: (writtenAt instanceof Date ? writtenAt : new Date(writtenAt)).toISOString(),
    task: scrub(task ?? null),
    conversation: scrub(conversation),
    plan: plan ? { steps: scrub(plan.steps ?? []), cursor: plan.cursor ?? 0 } : null,
    observations: scrub(observations),
    budget: budget ? { ...budget } : null,
    // MUST persist. Without it `maxInterruptions` resets on every resume and
    // the limit never trips — a run could ask forever, one question per resume.
    interruptions,
    identity: safeIdentity(identity),
    pendingBatchId,
  };
}

/**
 * Read a snapshot back.
 *
 * Refuses rather than guesses. A snapshot written by a different build may
 * have meant something different by the same field name, and resuming on a
 * misread plan cursor re-executes work that already happened.
 *
 * @returns {{ok: true, snapshot: object} | {ok: false, reason: string, detail?: any}}
 */
export function restore(raw) {
  if (raw == null) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'unreadable' };
  if (raw.version !== SNAPSHOT_VERSION) {
    return { ok: false, reason: 'incompatible_version', detail: { found: raw.version ?? null, expected: SNAPSHOT_VERSION } };
  }
  if (typeof raw.jobId !== 'string' || !raw.jobId) return { ok: false, reason: 'unreadable', detail: 'jobId' };

  return {
    ok: true,
    snapshot: {
      ...raw,
      conversation: raw.conversation ?? [],
      observations: raw.observations ?? [],
      interruptions: raw.interruptions ?? 0,
      plan: raw.plan ?? null,
    },
  };
}

/**
 * Rebuild the same state from history alone.
 *
 * This is the fallback whenever `restore()` refuses, and it is what makes the
 * snapshot genuinely disposable. History is append-only and ordered, so the
 * rebuild is a fold: later entries win.
 */
export function rebuildFromHistory(history = [], { jobId, kitVersion = null, now = new Date() } = {}) {
  let traceId = null;
  let task = null;
  let plan = null;
  let cursor = 0;
  let interruptions = 0;
  let pendingBatchId = null;
  let identity = null;
  const observations = [];
  const conversation = [];

  for (const e of history) {
    switch (e.type) {
      case 'run_started':
        task = e.task ?? null;
        traceId = e.traceId ?? null;
        if (e.identity) identity = safeIdentity(e.identity);
        break;

      case 'planned':
        // A replan replaces the plan outright and restarts the cursor: the
        // steps it describes are new work, and completed steps are recorded
        // separately below.
        plan = { steps: e.plan ?? [], cursor: 0 };
        cursor = 0;
        break;

      case 'step_completed':
        // The cursor sits *after* the highest completed step. Completed work is
        // never re-executed — resume restores state, it does not replay effects.
        cursor = Math.max(cursor, (e.stepIndex ?? 0) + 1);
        observations.push({ stepIndex: e.stepIndex, result: e.result, reversible: e.reversible });
        break;

      case 'step_failed':
        observations.push({ stepIndex: e.stepIndex, error: e.error });
        break;

      case 'question_asked':
        interruptions += 1;
        pendingBatchId = e.batch?.batchId ?? null;
        conversation.push({ role: 'assistant', kind: 'question', batch: e.batch });
        break;

      case 'answer_received':
        pendingBatchId = null;
        conversation.push({ role: 'user', kind: 'answer', batchId: e.batchId, answers: e.answers });
        observations.push({ kind: 'answer', batchId: e.batchId, answers: e.answers });
        break;

      case 'question_expired':
        pendingBatchId = null;
        observations.push({ kind: 'answer_expired', batchId: e.batchId });
        break;

      case 'reversal_step':
        // A reversed step is no longer done. Dropping its observation is what
        // stops a resumed run believing it still holds a booking it cancelled.
        if (e.outcome === 'undone') {
          const i = observations.findIndex(o => o.stepIndex === e.stepIndex && 'result' in o);
          if (i !== -1) observations.splice(i, 1);
          cursor = Math.min(cursor, e.stepIndex ?? cursor);
        }
        break;

      default:
        break;   // run_settled, step_started, reversal_planned/finished carry no resume state
    }
  }

  if (plan) plan.cursor = cursor;

  return capture({
    jobId: jobId ?? history[0]?.jobId ?? null,
    traceId,
    kitVersion,
    task,
    conversation,
    plan,
    observations,
    budget: null,          // budget is re-derived by the run loop, not by history
    interruptions,
    identity,
    pendingBatchId,
    writtenAt: now,
  });
}

/**
 * The resume state for a job: the snapshot if it is usable, otherwise a
 * rebuild. Callers get the same shape either way and are told which they got,
 * because a rebuild is worth logging — it means a snapshot was lost.
 */
export function resumeState(record, history, { kitVersion = null, now = new Date() } = {}) {
  const restored = restore(record?.snapshot);
  if (restored.ok) return { source: 'snapshot', state: restored.snapshot };

  return {
    source: 'history',
    reason: restored.reason,
    state: rebuildFromHistory(history, { jobId: record?.id, kitVersion, now }),
  };
}
