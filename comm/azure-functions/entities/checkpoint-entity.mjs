// comm/azure-functions/entities/checkpoint-entity.mjs
//
// The run checkpoint, held in the Durable task hub as an entity.
//
// Why an entity rather than the memory store: `callEntity` returns a Task that
// must be `yield`ed, so it is reachable only from the orchestrator generator —
// and a generator cannot `await` a promise without breaking replay determinism.
// The promise-based MEMORY_STORE_METHODS interface therefore cannot be used
// from the place that has to write this. See the spec, §9.1.
//
// `checkpointOps` is a pure `(state, input) => state` core so the part worth
// getting wrong is testable without a task hub. The Durable wrapper at the
// bottom is the only part that needs Azure to exercise.

import { createCheckpointRecord } from '../../../host/checkpoint/record.mjs';

export const checkpointOps = {
  /**
   * Merge, never replace.
   *
   * The orchestrator commits one step's delta at a time and knows nothing of
   * the idempotency keys that step produced — those come back inside the delta,
   * but a later commit that does not mention them must not erase them. A
   * replacing save would drop the keys and the resumed run would re-execute an
   * irreversible step it had already completed.
   *
   * A field the writer *does* mention wins, including an explicit null, so
   * settling can still clear `pendingBatchId`.
   */
  save(state, fields) {
    return createCheckpointRecord({ ...(state ?? {}), ...fields });
  },

  get(state) {
    return state ?? null;
  },

  clear() {
    return null;
  },

  addIdempotencyKey(state, key) {
    const keys = state?.idempotencyKeys ?? [];
    if (keys.includes(key)) return state;
    return { ...(state ?? {}), idempotencyKeys: [...keys, key] };
  },

  hasIdempotencyKey(state, key) {
    return (state?.idempotencyKeys ?? []).includes(key);
  },
};

/** Operations that answer rather than mutate. */
const READ_OPS = new Set(['get', 'hasIdempotencyKey']);

/**
 * Register the entity. Kept separate from the ops so importing this module in a
 * test does not require the Durable runtime.
 */
export function registerCheckpointEntity(df) {
  df.app.entity('checkpoint', (context) => {
    const op = context.df.operationName;
    const state = context.df.getState(() => null);
    const input = context.df.getInput();

    if (!Object.hasOwn(checkpointOps, op)) {
      throw new Error(`checkpoint entity: unknown operation "${op}"`);
    }
    if (READ_OPS.has(op)) {
      context.df.return(checkpointOps[op](state, input));
      return;
    }
    context.df.setState(checkpointOps[op](state, input));
  });
}
