// host/retention/archive.mjs
//
// The long-term copy of a settled run.
//
// The task hub — and the jobs store generally — is operational storage, not an
// archive. But this design deliberately builds history worth keeping: who
// approved what, what the agent actually did, what was reversed and what could
// not be. Purging destroys it.
//
// So a run can be copied somewhere durable before its operational record is
// ever cleared. Off by default: an adopter who does not care about history
// beyond the operational window pays nothing.
//
// **The invariant: never purge what failed to archive.** A purge that silently
// outruns a broken archive is the one way to lose data permanently, so the
// ordering is not negotiable and `archived()` is what the expiry sweep asks.

export function createArchive({ config = {}, store, archiveStore = null, logger = console } = {}) {
  const enabled = config.enabled === true;

  return {
    enabled,

    /**
     * Has this record been archived, or does it not need to be?
     *
     * A disabled archive answers `true` for everything — nothing is waiting to
     * be copied, so nothing blocks a purge.
     */
    archived(record) {
      if (!enabled) return true;
      return Boolean(record?.archivedAt);
    },

    /**
     * Copy one settled run's record and history to the archive store.
     *
     * Returns `{ ok: false }` rather than throwing: the caller is a sweep over
     * many records, and one unreachable archive must not stop the rest.
     */
    async archive(record) {
      if (!enabled) return { ok: true, skipped: 'disabled' };
      if (!archiveStore) {
        return { ok: false, reason: 'no_archive_store', message: 'archiving is enabled but no archive store was wired' };
      }
      if (record?.archivedAt) return { ok: true, skipped: 'already_archived' };

      try {
        const history = await store.events(record.id);

        // Written as one document carrying its own history, because an archive
        // is read whole — "what happened on this run?" — and never queried
        // event by event the way the live store is.
        const copy = {
          ...record,
          archivedAt: new Date().toISOString(),
          archivedHistory: history,
        };

        try {
          await archiveStore.insert(copy);
        } catch (err) {
          // An archive that already holds this run is a success, not a
          // failure: a retry after a partial pass lands here every time.
          if (!/exists/i.test(String(err?.message ?? err))) throw err;
        }

        await store.update(record.id, { archivedAt: copy.archivedAt });
        return { ok: true, archivedAt: copy.archivedAt };
      } catch (err) {
        logger.warn(`[retention] could not archive ${record?.id}: ${err?.message ?? err}`);
        return { ok: false, reason: 'archive_failed', message: String(err?.message ?? err) };
      }
    },
  };
}
