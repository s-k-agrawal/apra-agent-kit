// host/jobs/entity-retention.mjs
//
// Purging orchestration instances does not remove entities.
//
// This is the cost of putting state in the task hub: an entity outlives the
// orchestration that created it, by design — that is the whole reason the
// checkpoint can survive a completed orchestration and be read by the next one.
// Nothing reclaims them, so without this the storage account accumulates a
// checkpoint entity per run, forever.
//
// The rule is the one `purgeStaleOrchestrations` already follows, for the same
// reason: **a run parked on a question keeps its state whatever its age.** Its
// entity is the only copy of what the answer will resume from, and a blanket
// sweep by age would quietly make every waiting question unanswerable.
//
// The protection is bounded, not absolute. An unconditional "never purge a
// waiting run" means a broken sweep shields entities forever, which is the very
// thing that breaks the sweep. Past its own deadline plus a grace period, a
// paused run should already have settled; if it has not, it is unrecoverable
// anyway.

const DAY_MS = 86_400_000;

/**
 * Should this entity be kept?
 *
 * @param {object} entity        `{ key, state, lastUpdatedAt }`
 * @param {Set<string>} liveKeys checkpoint keys of runs still waiting on a person
 */
export function shouldKeepEntity(entity, liveKeys, { now = new Date(), afterDays = 30, graceDays = 1 } = {}) {
  if (liveKeys.has(entity.key)) {
    // Parked on a question. Keep it until its own deadline has passed with a
    // grace period, and no longer.
    const expiresAt = Date.parse(entity.state?.pendingInput?.expiresAt ?? entity.state?.expiresAt ?? '');
    if (!Number.isFinite(expiresAt)) return true;   // unreadable deadline: keeping is the safer mistake
    return nowMs(now) < expiresAt + graceDays * DAY_MS;
  }

  const updated = Date.parse(entity.lastUpdatedAt ?? entity.state?.writtenAt ?? '');
  if (!Number.isFinite(updated)) return true;       // same reasoning
  return nowMs(now) < updated + afterDays * DAY_MS;
}

const nowMs = (now) => (now instanceof Date ? now.getTime() : now);

/**
 * Sweep stale entities.
 *
 * `listEntities` is supplied rather than assumed, because how you enumerate
 * entities depends on the storage provider — the Azure Storage backend exposes
 * them through the Instances table, and a different provider would not.
 */
export async function purgeStaleEntities({
  client,
  listEntities,
  logger = console,
  afterDays = 30,
  graceDays = 1,
  now = () => new Date(),
} = {}) {
  if (typeof listEntities !== 'function') return { purged: 0, kept: 0 };

  try {
    const at = now();
    const entities = await listEntities();

    // Which runs are still waiting on somebody. Anything in here is untouchable
    // until its own deadline passes.
    const liveKeys = new Set();
    if (typeof client?.getStatusBy === 'function') {
      const completed = await client.getStatusBy({ runtimeStatus: ['Completed'] });
      for (const inst of completed) {
        const waiting = inst?.customStatus?.status === 'waiting_input' || inst?.output?.status === 'paused';
        const key = inst?.output?.checkpointKey;
        if (waiting && key) liveKeys.add(key);
      }
    }

    let purged = 0;
    let kept = 0;
    for (const entity of entities) {
      if (shouldKeepEntity(entity, liveKeys, { now: at, afterDays, graceDays })) {
        kept += 1;
        continue;
      }
      try {
        await client.signalEntity({ name: entity.name ?? 'checkpoint', key: entity.key }, 'clear');
        purged += 1;
      } catch (err) {
        logger.warn?.(`[durable] could not clear entity ${entity.key}: ${err?.message ?? err}`);
      }
    }

    if (purged) logger.warn?.(`[durable] cleared ${purged} stale entity/entities`);
    return { purged, kept };
  } catch (err) {
    // Retention failing is not a reason to take a host down.
    logger.warn?.(`[durable] entity retention sweep failed (non-fatal): ${err?.message ?? err}`);
    return { purged: 0, kept: 0 };
  }
}
