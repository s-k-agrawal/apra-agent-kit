// comm/azure-functions/advance.mjs
//
// One step of a run, for the Azure path.
//
// The orchestrator must commit the checkpoint between steps, and `callEntity`
// is reachable only from the orchestrator generator — so the activity cannot
// write the checkpoint itself in a way that is confirmed. It therefore runs the
// strategy against an **in-memory** checkpoint seeded from entity state, and
// returns that checkpoint's contents as a delta. The orchestrator commits the
// delta with `callEntity` before calling `advance` again.
//
// The strategies are unchanged by this. They see the checkpoint interface they
// always see; only its backing differs.

import { executeHostedTask } from '../../host/tasks.mjs';
import { createCheckpointRecord } from '../../host/checkpoint/record.mjs';

// How much of a failure is worth keeping. An error message and a stack are
// arbitrary text from arbitrary code, and both reach a log and a job record
// that outlive the run — so they are scrubbed and bounded, not passed through.
const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 1_200;
const MAX_LOG_LINES = 10;
const MAX_LOG_CHARS = 200;

/**
 * What somebody would need to chase a failed step.
 *
 * Built even when there is no retry — a single attempt that fails is still
 * worth recording, and before this it produced one `warn` line and nothing on
 * the record.
 *
 * @param {object}  o
 * @param {string}  o.jobId
 * @param {number}  o.attempt      1-based
 * @param {number}  o.maxAttempts  so the record reads "2 of 3"
 * @param {number}  o.startedAt    epoch ms, for how long it ran before dying
 * @param {unknown} o.err
 * @param {string[]} [o.logs]      whatever the step got through first
 */
export function buildFailureAudit({ jobId, attempt, maxAttempts, startedAt, err, logs }) {
  const clip = (v, n) => {
    const t = typeof v === 'string' ? v : String(v ?? '');
    return t.length > n ? `${t.slice(0, n)}… [${t.length} chars]` : t;
  };
  // scrub() strips credential-shaped keys from objects; an error message is a
  // bare string, so the token-shaped substrings are removed directly.
  const clean = (t) => String(t ?? '')
    .replace(/\b(?:sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{4,}/gi, '[redacted]')
    .replace(/\b(token|secret|password|passwd|apikey|api[_-]?key|authorization|bearer|cookie|credential)\b\s*[:=]?\s*\S+/gi, '$1=[redacted]');

  return {
    jobId: jobId ?? null,
    attempt: attempt ?? 1,
    maxAttempts: maxAttempts ?? 1,
    at: new Date().toISOString(),
    durationMs: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null,
    errorName: (err && typeof err === 'object' && err.name) ? String(err.name) : 'Error',
    message: clip(clean(err?.message ?? err), MAX_MESSAGE_CHARS),
    stack: err?.stack ? clip(clean(err.stack), MAX_STACK_CHARS) : null,
    logs: (Array.isArray(logs) ? logs : []).slice(-MAX_LOG_LINES).map(l => clip(clean(l), MAX_LOG_CHARS)),
  };
}

/**
 * A checkpoint that lives for one activity invocation.
 *
 * Same interface as `host/checkpoint/index.mjs`, backed by a plain object
 * rather than a store. `save` merges for the same reason the real one does:
 * the strategy saves after each step without restating what it did not change.
 */
export function createInMemoryCheckpoint(initial = null) {
  let state = initial ? { ...initial } : null;
  let cleared = false;

  return {
    /** What the orchestrator commits, or null when there is nothing to commit. */
    get delta() { return state; },
    /**
     * True when the run finished and cleared its checkpoint. The orchestrator
     * has to clear the entity too — a null delta on its own is ambiguous
     * between "nothing changed" and "this is over".
     */
    get cleared() { return cleared; },

    async save(_taskKey, fields) {
      cleared = false;
      state = capObservations(createCheckpointRecord({ ...(state ?? {}), ...fields }));
      return true;
    },
    async load() {
      return state ? { ok: true, checkpoint: state } : { ok: false, reason: 'absent' };
    },
    async clear() { state = null; cleared = true; },
    async hasIdempotencyKey(_taskKey, key) {
      return (state?.idempotencyKeys ?? []).includes(key);
    },
    async addIdempotencyKey(_taskKey, key) {
      if (!state) return;
      const keys = state.idempotencyKeys ?? [];
      if (!keys.includes(key)) state = { ...state, idempotencyKeys: [...keys, key] };
    },
  };
}

// An entity operation has to fit in a Durable payload, and a single tool result
// can be far larger than one. The VM path keeps the whole thing — sqlite does
// not care — so this cap is Azure-only and lives here rather than in the shared
// record.
//
// Truncating loses detail a resumed run would otherwise have. The proper fix is
// to put a large result in blob storage and keep a reference, which the spec
// carries as follow-up work (§8). Until then, failing to commit at all is worse
// than committing a marked truncation: an uncommitted step is one the run will
// do again.
const MAX_OBSERVATION_CHARS = 2_000;
const MAX_DELTA_CHARS = 10_000;

function capObservations(record) {
  const observations = record.observations ?? [];
  if (JSON.stringify(record).length <= MAX_DELTA_CHARS) return record;

  const capped = observations.map((obs) => {
    const json = JSON.stringify(obs);
    if (json.length <= MAX_OBSERVATION_CHARS) return obs;
    return {
      ...obs,
      result: undefined,
      text: undefined,
      truncated: true,
      summary: `${json.slice(0, MAX_OBSERVATION_CHARS)}… [truncated, ${json.length} characters]`,
    };
  });
  return { ...record, observations: capped };
}

/**
 * Advance a run by one step.
 *
 * @returns {Promise<{status: string, done: boolean, delta: object|null,
 *                    result?: unknown, error?: object, batch?: object, batchId?: string}>}
 *   `done` is true for any status the orchestration should stop on —
 *   completed, failed, cancelled or paused. A `suspended` run is not done.
 */
export async function runAdvance({ jobId, task, state = null, hostCtx, signal, onProgress, askUser }) {
  const checkpoint = createInMemoryCheckpoint(state);

  // What the strategy needs to pick up where the last advance left off. The
  // checkpoint carries the rest; this is the shape resumeContextFor produces on
  // the VM path, so the strategies see nothing new.
  const resumeFrom = state
    ? {
        observations: state.observations ?? [],
        plan: state.plan ?? null,
        budget: state.budget ?? null,
        interruptions: state.interruptions ?? 0,
        identity: state.identity ?? null,
        recalledFacts: state.recalledFacts ?? null,
        conversation: state.conversation ?? null,
      }
    : null;

  const run = await executeHostedTask({ ...task, id: jobId }, {
    api: hostCtx.api,
    activeDispatcher: hostCtx.activeDispatcher,
    toolRegistry: hostCtx.toolRegistry,
    runLoopConfig: hostCtx.runLoopConfig,
    routerConfig: hostCtx.routerConfig,
    budgetsConfig: hostCtx.budgetsConfig,
    guardrailsMod: hostCtx.guardrailsMod,
    memory: hostCtx.memory,
    logger: hostCtx.logger,
    signal,
    onProgress,
    askUser,
    checkpoint,
    resumeFrom,
    maxSteps: 1,
  });

  const done = run.status !== 'suspended';

  return {
    status: run.status,
    done,
    // Null when the step wrote nothing, so the orchestrator can skip a
    // pointless entity round trip — unless `cleared` says the run is over, in
    // which case the entity has to be cleared rather than left behind.
    delta: checkpoint.delta,
    cleared: checkpoint.cleared,
    ...(run.status === 'paused' ? { batch: run.batch, batchId: run.batchId } : {}),
    ...(done && run.status !== 'paused'
      ? { result: run.result ?? null, error: run.error ?? null }
      : {}),
  };
}
