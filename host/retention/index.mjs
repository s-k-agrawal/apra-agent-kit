// host/retention/index.mjs
//
// Archive and expiry, wired together.
//
// Two independent things on two clocks. Keeping them separate is the point:
// an adopter who wants history forever turns archiving on; one who wants a
// small store turns expiry up; one who is obliged to control deletion sets
// `mode: 'manual'`. None of those choices forces any of the others.

import { createArchive } from './archive.mjs';
import { createExpiry } from './expiry.mjs';

export { createArchive, createExpiry };
export { eligibility } from './expiry.mjs';

/**
 * @param {object} deps
 * @param {object} deps.config          `dispatch.retention`
 * @param {object} deps.store           the operational store
 * @param {object} [deps.archiveStore]  where long-term copies go
 * @param {Function} deps.clear         (id) => Promise<void>
 */
export function createRetention({
  config = {}, store, archiveStore = null, clear, listAll = null, logger = console, now = () => new Date(),
} = {}) {
  const archive = createArchive({ config: config.archive, store, archiveStore, logger });
  const expiry = createExpiry({ store, archive, clear, listAll, config: config.expiry, logger, now });

  const mode = config.expiry?.mode ?? 'auto';

  return {
    archive,
    expiry,
    mode,
    // The route exists only where an operator is meant to trigger a pass. Under
    // `auto` the timer owns it, and offering a manual trigger as well invites
    // two things racing over the same records.
    routeEnabled: mode === 'manual' || mode === 'both',
    sweep: (opts) => expiry.sweep(opts),
    start: () => expiry.start(),
    stop: () => expiry.stop(),
  };
}

/**
 * Where a store adapter cannot be built for the archive, say so rather than
 * silently running with archiving "enabled" and nowhere to put anything.
 */
export async function createArchiveStore(config = {}, { backend = 'in-process' } = {}) {
  if (!config?.enabled) return null;
  const { createStore } = await import('../jobs/store/resolve.mjs');
  return createStore({ ...config, kind: config.store }, backend);
}
