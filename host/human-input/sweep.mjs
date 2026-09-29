// host/human-input/sweep.mjs
//
// The two deadlines on a question, enforced.
//
// `staleAfter` is soft: the question is still answerable, but the world may
// have moved and the person should be told before they answer. `expiresAt` is
// hard: nobody answered, the pending action is treated as refused, and the run
// settles with its history intact.
//
// The hard stop exists because resuming stale work has a real cost. Compute
// while waiting is free; quality on resume is not — the model is re-fed the
// whole history and a cold resume of week-old work can be worse than a fresh
// start.
//
// This sweep is about *questions*. Clearing settled job records from storage is
// retention, a separate concern on a separate schedule.

import { isStale, isExpired } from './batch.mjs';

export const DEFAULT_SWEEP_INTERVAL_MS = 300_000;   // 5 minutes

/**
 * @param {object} deps
 * @param {Function} deps.listWaiting  () => Promise<JobRecord[]> — every job in `waiting_input`
 * @param {Function} deps.expireInput  (jobId) => Promise<{ok}> — settle one expired run
 * @param {Function} [deps.markStale]  (jobId, batch) => Promise<void> — record that a batch went stale
 */
export function createQuestionSweep({
  listWaiting,
  expireInput,
  markStale = null,
  intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  logger = console,
  now = () => new Date(),
} = {}) {
  let timer = null;
  let running = false;

  async function sweepOnce() {
    // Overlapping passes would double-settle a run that expired while the
    // previous pass was still working through the list.
    if (running) return { skipped: true };
    running = true;

    const at = now();
    const out = { scanned: 0, expired: 0, staleMarked: 0, errors: [] };

    try {
      for (const record of await listWaiting()) {
        // A job that was answered between the listing and here is no longer
        // waiting. Checking the record we were handed rather than re-reading
        // keeps the sweep cheap; the backend refuses a stale decision anyway.
        const batch = record.pendingInput;
        if (!batch) continue;
        out.scanned += 1;

        try {
          if (isExpired(batch, at)) {
            // `expireInput` re-checks the status, so an answer that landed a
            // millisecond ago wins and this is a no-op.
            const res = await expireInput(record.id);
            if (res?.ok) out.expired += 1;
            continue;
          }

          // Soft: mark it and leave it answerable. Settling here would throw
          // away work over a threshold that is only advisory.
          if (markStale && isStale(batch, at) && !record.staleNotifiedAt) {
            await markStale(record.id, batch);
            out.staleMarked += 1;
          }
        } catch (err) {
          // One bad record must not stop the sweep; the next pass retries it.
          out.errors.push({ jobId: record.id, message: String(err?.message ?? err) });
          logger.warn(`[human-input] sweep failed for ${record.id}: ${err?.message ?? err}`);
        }
      }
    } finally {
      running = false;
    }

    return out;
  }

  return {
    sweepOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => void sweepOnce(), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
