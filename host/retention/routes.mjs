// host/retention/routes.mjs
//
// `POST /jobs/purge` — an operator clearing settled records by hand.
//
// Mounted only when `retention.expiry.mode` is `manual` or `both`. Under
// `auto` the timer owns the job, and offering a manual trigger as well invites
// two passes racing over the same records.

const json = (status, body) => ({ status, body });

export function buildRetentionRoutes({ retention }) {
  if (!retention?.routeEnabled) return { jobsPurge: null };

  return {
    jobsPurge: {
      method: 'POST', path: '/jobs/purge',
      handler: async ({ body }) => {
        const { olderThanDays, dryRun } = body ?? {};

        if (olderThanDays !== undefined && !(Number.isFinite(olderThanDays) && olderThanDays > 0)) {
          return json(400, { ok: false, error: 'invalid_request', message: 'olderThanDays must be a positive number of days' });
        }

        const out = await retention.sweep({ dryRun: dryRun === true, ...(olderThanDays ? { olderThanDays } : {}) });

        // `skipped` separates *still active* from *archiving failed*, because
        // those mean very different things: the first is normal, the second
        // needs somebody to look at it.
        return json(200, {
          ok: true,
          scanned: out.scanned,
          archived: out.archived,
          cleared: out.cleared,
          skipped: out.skipped,
          errors: out.errors,
          dryRun: out.dryRun,
        });
      },
    },
  };
}
