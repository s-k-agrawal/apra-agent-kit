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
