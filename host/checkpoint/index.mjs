// host/checkpoint/index.mjs
//
// One checkpoint per run, in the memory store.
//
// The store adapter — filesystem, sqlite or cosmos — is resolved per
// deployment by the memory module. Nothing here knows or cares which, and
// there is deliberately no precedence rule: a production system is a VM or
// Functions, never both.
//
// Two triggers write this record. The strategies save after each step, for
// crash recovery; a pause saves on unwind, so the run can be picked up cold.
// Same function, different moments — saving more often is strictly safer for
// both purposes.
//
// **Errors are values.** A checkpoint is crash recovery: losing one degrades
// that and must not take down a run. `save` returns a boolean and the caller
// decides what a false means. The one caller for whom it is fatal is a pause,
// because an unsaved pause is a question nobody will ever answer.

import { createCheckpointRecord, validateCheckpoint } from './record.mjs';

export { CHECKPOINT_VERSION, checkpointKey, createCheckpointRecord, validateCheckpoint, scrub } from './record.mjs';
export { rebuildFromHistory, resumeState } from './rebuild.mjs';

// Tags the row so an operator reading the memory store can tell run state from
// the facts the agent has learnt. The retired run-state used `__run_state__`.
const TAG = '__checkpoint__';

export function createCheckpoint({ store, logger = console, kitVersion = null } = {}) {
  if (!store) throw new Error('createCheckpoint requires a memory store');

  /**
   * @returns {Promise<boolean>} false when the store could not be written.
   */
  async function save(taskKey, fields) {
    try {
      // One row per run. Two triggers write it, so an insert-only path would
      // grow the store with every step.
      const existing = await store.get(taskKey);

      // The writers know different things. The strategies hold the idempotency
      // keys, the recalled facts and the conversation; the pause path holds the
      // parked batch and knows nothing of the keys. A save that replaced the
      // row wholesale let the pause erase the keys, and the resumed run then
      // re-executed the irreversible step it had already completed.
      //
      // So a field the writer did not mention keeps the value already stored.
      // A field it did mention wins, including an explicit null — otherwise
      // settling could never clear the parked batch.
      let base = null;
      if (existing) {
        try { base = JSON.parse(existing.text); } catch { base = null; }
      }
      const merged = base ? { ...base, ...fields } : fields;

      const record = createCheckpointRecord({ ...merged, taskKey, kitVersion });
      const text = JSON.stringify(record);

      if (existing) {
        await store.update(taskKey, { text });
      } else {
        // The full memory-entry shape. A partial one binds undefined to the
        // sqlite store's columns and fails at insert; the retired run-state
        // supplied all of these, and so must this.
        const nowIso = new Date().toISOString();
        await store.store({
          id: taskKey,
          kind: 'procedure',
          text,
          tags: [TAG],
          source: 'system',
          confidence: 1.0,
          storageStrength: 1.0,
          retrievalStrength: 1.0,
          state: 'active',
          stability: 1.0,
          difficulty: 0,
          reps: 0,
          lapses: 0,
          lastPromotedAt: nowIso,
          lastReviewRating: null,
          createdAt: nowIso,
          lastUsedAt: null,
          useCount: 0,
          metadata: { type: 'checkpoint', taskKey },
        });
      }
      return true;
    } catch (err) {
      logger.warn?.(`[checkpoint] save failed for ${taskKey}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * @returns {Promise<{ok: true, checkpoint: object} | {ok: false, reason: string}>}
   *   `absent` for a run that has not checkpointed yet — the normal first
   *   case, not a fault.
   */
  async function load(taskKey) {
    let entry;
    try {
      entry = await store.get(taskKey);
    } catch (err) {
      logger.warn?.(`[checkpoint] load failed for ${taskKey}: ${err?.message ?? err}`);
      return { ok: false, reason: 'unreadable' };
    }
    if (!entry) return { ok: false, reason: 'absent' };

    let parsed;
    try {
      parsed = JSON.parse(entry.text);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    return validateCheckpoint(parsed);
  }

  async function clear(taskKey) {
    try {
      await store.remove(taskKey);
    } catch (err) {
      logger.warn?.(`[checkpoint] clear failed for ${taskKey}: ${err?.message ?? err}`);
    }
  }

  // Carried over from run-state: stops a step re-running after a crash
  // recovery that resumed mid-plan.
  async function hasIdempotencyKey(taskKey, key) {
    const out = await load(taskKey);
    if (!out.ok) return false;
    return (out.checkpoint.idempotencyKeys ?? []).includes(key);
  }

  async function addIdempotencyKey(taskKey, key) {
    const out = await load(taskKey);
    if (!out.ok) return;
    const keys = out.checkpoint.idempotencyKeys ?? [];
    if (keys.includes(key)) return;
    await save(taskKey, { ...out.checkpoint, idempotencyKeys: [...keys, key] });
  }

  return { save, load, clear, hasIdempotencyKey, addIdempotencyKey };
}
