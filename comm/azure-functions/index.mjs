// comm/azure-functions/index.mjs
// Registers the orchestrator and activity with Durable Functions.
export async function registerDurableFunctions({ hostContextFactory, pollMs = 2000 }) {
  const df = await import('durable-functions');
  const { ORCHESTRATOR_NAME, ACTIVITY_NAME } = await import('../../host/jobs/durable.mjs');
  const { runTaskOrchestrator } = await import('./orchestrator.mjs');
  const { createRunTaskActivity, setHostContextFactory } = await import('./activity.mjs');

  setHostContextFactory(hostContextFactory);
  const clientInput = df.input.durableClient();
  df.app.orchestration(ORCHESTRATOR_NAME, runTaskOrchestrator);
  df.app.activity(ACTIVITY_NAME, {
    extraInputs: [clientInput],
    handler: createRunTaskActivity({ getClient: (context) => df.getClient(context), pollMs }),
  });
  return { df, clientInput };
}

const ACTIVE_STATUSES = ['Pending', 'Running', 'Suspended', 'ContinuedAsNew'];
const DAY_MS = 86_400_000;

/**
 * Is this Completed instance a run parked on a question that somebody may
 * still answer?
 *
 * This is the sharpest hazard the durable human-input design introduces. A
 * paused run *is* a Completed orchestration, and its output is the only copy
 * of its state — so a blanket purge of completed instances destroys it.
 *
 * The skip is **bounded, not absolute**. An unconditional "never purge a
 * waiting run" means that if the question sweep ever stops, those instances
 * are shielded forever and the task hub grows without bound — which is the
 * very thing that breaks the sweep. Past its own deadline plus a grace period,
 * a paused run should already have settled; if it has not, the sweep is broken
 * and the run is unrecoverable anyway.
 */
export function isLivePausedInstance(instance, { now = new Date(), graceDays = 1 } = {}) {
  const paused = instance?.customStatus?.status === 'waiting_input' || instance?.output?.status === 'paused';
  if (!paused) return false;

  const expiresAt = Date.parse(
    instance.customStatus?.pendingInput?.expiresAt ?? instance.output?.batch?.expiresAt ?? '',
  );
  // No readable deadline: keep it. Deleting state we cannot reason about is
  // the worse of the two mistakes.
  if (!Number.isFinite(expiresAt)) return true;

  const at = now instanceof Date ? now.getTime() : now;
  return at < expiresAt + graceDays * DAY_MS;
}

export async function purgeStaleOrchestrations(client, { logger = console, graceDays = 1, now = () => new Date() } = {}) {
  try {
    const stale = await client.getStatusBy({ runtimeStatus: ACTIVE_STATUSES });
    if (stale.length) {
      logger.warn(`[durable] purging ${stale.length} stale orchestration(s) from previous run`);
      for (const inst of stale) {
        try {
          await client.terminate(inst.instanceId, 'purged at startup — stale from previous host');
          await client.purgeInstanceHistory(inst.instanceId);
        } catch (err) {
          logger.warn(`[durable] purge ${inst.instanceId} failed: ${err?.message ?? err}`);
        }
      }
    }

    const completed = await client.getStatusBy({ runtimeStatus: ['Completed', 'Failed', 'Terminated', 'Canceled'] });
    if (!completed.length) return;

    const at = now();
    const keep = completed.filter(i => isLivePausedInstance(i, { now: at, graceDays }));
    const purgeable = completed.filter(i => !keep.includes(i));

    if (keep.length) {
      logger.warn(`[durable] keeping ${keep.length} paused orchestration(s) waiting on a person`);
    }

    // Purged one at a time rather than with purgeInstanceHistoryBy, because
    // that call takes a time range and cannot exclude the paused ones. A
    // blanket purge here would silently delete every run waiting on an answer,
    // on every host restart.
    let purged = 0;
    for (const inst of purgeable) {
      try {
        await client.purgeInstanceHistory(inst.instanceId);
        purged += 1;
      } catch (err) {
        logger.warn(`[durable] purge ${inst.instanceId} failed: ${err?.message ?? err}`);
      }
    }
    if (purged) logger.warn(`[durable] purged ${purged} completed orchestration(s)`);
  } catch (err) {
    logger.warn(`[durable] startup purge failed (non-fatal): ${err?.message ?? err}`);
  }
}
