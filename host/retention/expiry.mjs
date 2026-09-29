// host/retention/expiry.mjs
//
// Clearing settled job records out of the operational store.
//
// **Records, not questions.** A question that nobody answered expires after 7
// days and settles the run (`host/human-input/sweep.mjs`). A *record* expires
// after 30 days and is deleted. They are different clocks with different
// consequences and they are never the same operation.
//
// Purging is load-bearing rather than housekeeping. The staleness sweep finds
// paused runs by scanning the store; an un-purged store makes that scan slower
// every day until it times out — at which point nothing expires, paused runs
// accumulate, and the scan gets worse still.

import { TERMINAL_STATUSES } from '../jobs/record.mjs';

const DAY_MS = 86_400_000;

/**
 * Why a record may or may not be cleared.
 *
 * Returned as a reason rather than a boolean because the purge report has to
 * separate *skipped because still active* from *skipped because archiving
 * failed*: the first is normal, the second needs attention.
 *
 * @returns {{eligible: true} | {eligible: false, reason: string}}
 */
export function eligibility(record, {
  now = new Date(),
  afterDays = 30,
  graceDays = 1,
  archived = () => true,
} = {}) {
  if (!record) return { eligible: false, reason: 'missing' };

  const at = now instanceof Date ? now.getTime() : now;

  // A paused run is skipped only *while it is young*. An unconditional "never
  // purge waiting_input" means that if the question sweep ever stops, those
  // records are shielded forever and the store grows without bound — the exact
  // failure that breaks the sweep in the first place. The conditional form
  // self-heals: anything past its own question expiry should already have
  // settled, and if it has not, the sweep is broken and the record is
  // unrecoverable anyway.
  if (record.status === 'waiting_input') {
    const expiresAt = Date.parse(record.pendingInput?.expiresAt ?? '');
    if (!Number.isFinite(expiresAt)) return { eligible: false, reason: 'waiting' };
    if (at < expiresAt + graceDays * DAY_MS) return { eligible: false, reason: 'waiting' };
    return { eligible: true, reason: 'waiting_past_grace' };
  }

  if (!TERMINAL_STATUSES.has(record.status)) return { eligible: false, reason: 'active' };

  const finishedAt = Date.parse(record.finishedAt ?? '');
  if (!Number.isFinite(finishedAt)) return { eligible: false, reason: 'active' };
  if (at - finishedAt < afterDays * DAY_MS) return { eligible: false, reason: 'too_recent' };

  // Last, and deliberately last: never clear what failed to archive.
  if (!archived(record)) return { eligible: false, reason: 'unarchived' };

  return { eligible: true, reason: 'settled' };
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.archive       from `createArchive()`
 * @param {Function} deps.clear       (id) => Promise<void>
 * @param {Function} [deps.listAll]   () => Promise<JobRecord[]>
 */
export function createExpiry({
  store, archive, clear, listAll = null, config = {}, logger = console, now = () => new Date(),
} = {}) {
  const afterDays = config.afterDays ?? 30;
  const graceDays = config.graceDays ?? 1;

  async function everyRecord() {
    if (listAll) return listAll();
    // No single "list everything" method exists on the store contract, and
    // adding one for this would change `STORE_METHODS`. Walking the statuses
    // costs one query each and keeps the contract as it is.
    const statuses = [...TERMINAL_STATUSES, 'waiting_input'];
    const out = [];
    for (const s of statuses) out.push(...await store.listByStatus(s));
    return out;
  }

  /**
   * One pass. `dryRun` reports what *would* be cleared without clearing it —
   * the first thing anyone sensible runs.
   */
  async function sweep({ dryRun = false, olderThanDays = afterDays } = {}) {
    const at = now();
    const out = {
      scanned: 0, archived: 0, cleared: 0,
      skipped: { active: 0, waiting: 0, unarchived: 0, tooRecent: 0 },
      errors: [],
      dryRun,
    };

    for (const record of await everyRecord()) {
      out.scanned += 1;

      // Archive first, so `eligibility` can then ask whether it worked. A
      // record that has just been archived becomes eligible in the same pass.
      let current = record;
      if (archive?.enabled && !archive.archived(record)) {
        const res = await archive.archive(record);
        if (res.ok) {
          out.archived += 1;
          current = { ...record, archivedAt: res.archivedAt ?? record.archivedAt };
        } else {
          out.errors.push({ jobId: record.id, ...res });
        }
      }

      const verdict = eligibility(current, {
        now: at, afterDays: olderThanDays, graceDays,
        archived: (r) => (archive ? archive.archived(r) : true),
      });

      if (!verdict.eligible) {
        if (verdict.reason === 'too_recent') out.skipped.tooRecent += 1;
        else if (verdict.reason in out.skipped) out.skipped[verdict.reason] += 1;
        continue;
      }

      if (dryRun) { out.cleared += 1; continue; }

      try {
        await clear(current.id);
        out.cleared += 1;
      } catch (err) {
        out.errors.push({ jobId: current.id, reason: 'clear_failed', message: String(err?.message ?? err) });
        logger.warn(`[retention] could not clear ${current.id}: ${err?.message ?? err}`);
      }
    }

    return out;
  }

  let timer = null;
  return {
    sweep,
    eligibility: (record, opts) => eligibility(record, { now: now(), afterDays, graceDays, ...opts }),
    start() {
      // `manual` means an operator controls deletion explicitly. Some
      // deployments are obliged to, and a timer quietly doing it anyway would
      // defeat the point of the setting.
      if (config.mode === 'manual' || timer) return;
      timer = setInterval(() => void sweep().catch(err => logger.warn(`[retention] sweep failed: ${err?.message ?? err}`)), config.sweepIntervalMs ?? 3_600_000);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
