// host/checkpoint/rebuild.mjs
//
// Rebuild a checkpoint from history alone.
//
// This is what makes the checkpoint genuinely disposable, and it is the
// contract the whole design rests on: **nothing may live only in the
// checkpoint.** History is append-only and ordered, so the rebuild is a fold —
// later entries win.
//
// Moved here from host/human-input/snapshot.mjs unchanged apart from the
// record it builds. Its behaviour is the disposability contract; rewriting it
// during a refactor would hide a regression behind the move.

import { createCheckpointRecord, validateCheckpoint } from './record.mjs';

// Allow-listed, not filtered — same reasoning as record.mjs.
function safeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const out = {};
  if (identity.personId != null) out.personId = identity.personId;
  if (identity.tenantId != null) out.tenantId = identity.tenantId;
  return Object.keys(out).length === 0 ? null : out;
}

export function rebuildFromHistory(history = [], { taskKey, jobId, kitVersion = null, now = new Date() } = {}) {
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

  return createCheckpointRecord({
    taskKey,
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
 * The state a run resumes with: the loaded checkpoint if it is usable, a
 * rebuild from history otherwise.
 *
 * Takes the *loaded* checkpoint rather than reading it off the job record.
 * The record carries only a pointer, so there is nothing on it to read — the
 * caller loads from the store and hands the result here.
 *
 * Callers are told which they got, because a rebuild is worth logging: it
 * means a checkpoint was lost.
 */
export function resumeState(loaded, history, { kitVersion = null, now = new Date(), taskKey, jobId } = {}) {
  if (loaded?.ok) return { source: 'checkpoint', state: loaded.checkpoint };
  return {
    source: 'history',
    reason: loaded?.reason ?? 'absent',
    state: rebuildFromHistory(history, { taskKey, jobId, kitVersion, now }),
  };
}

export { validateCheckpoint };
