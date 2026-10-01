import { JobQueueFullError, JobsClosedError, InvalidCallbackUrlError, supportsHumanInput } from './jobs/interface.mjs';
import { kitInfo } from './kit-info.mjs';

const json = (status, body, headers) => ({ status, body, ...(headers ? { headers } : {}) });

function syncResponse(result) {
  if (result.status === 'failed' && result.result?.error === 'dispatch_failed') {
    return json(503, { ok: false, error: 'dispatch_failed', message: result.result.message });
  }
  return json(200, result);
}

export function buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb, runLoopEnabled, chatRoutes = null, guardrails = null, memoryRoutes = null, scheduler = null }) {
  const routes = {
    health: { method: 'GET', path: '/health', auth: false, handler: async () => json(200, { ok: true }) },
    // Identity and operational state sit apart from the liveness probe:
    // /health is consumed by infrastructure that checks its shape exactly,
    // so it stays minimal.
    kit: {
      method: 'GET', path: '/kit', auth: false,
      handler: async () => json(200, {
        kit: await kitInfo(),
        frozen: guardrails?.frozen?.() ?? false,
        dryRun: guardrails?.dryRun?.() ?? false,
      }),
    },
    mcp: { method: 'POST', path: '/mcp', raw: true, handler: mcpRaw, web: mcpWeb },
    task: null, jobGet: null, jobCancel: null, jobEvents: null, jobInput: null,
    chatPage: chatRoutes?.chatPage ?? null, chatScript: chatRoutes?.chatScript ?? null,
    memoryStore: memoryRoutes?.memoryStore ?? null,
    memoryQuery: memoryRoutes?.memoryQuery ?? null,
    memoryGet: memoryRoutes?.memoryGet ?? null,
    memoryUpdate: memoryRoutes?.memoryUpdate ?? null,
    memoryPromote: memoryRoutes?.memoryPromote ?? null,
    memoryRemove: memoryRoutes?.memoryRemove ?? null,
  };

  if (runLoopEnabled) {
    routes.task = {
      method: 'POST', path: '/task',
      handler: async (request) => {
        const body = request.body ?? {};
        if (typeof body.goal !== 'string' || !body.goal.trim()) {
          return json(400, { ok: false, error: 'invalid_task', message: 'goal (string) is required' });
        }
        const wait = String(request.query.wait ?? '').toLowerCase();
        if (!jobs || wait === 'true' || wait === '1') {
          return syncResponse(await runSync(body, { signal: request.signal }));
        }
        const { callbackUrl, metadata, ...task } = body;
        try {
          // `identity` is what park() copies onto the checkpoint and what
          // planResume reads back to decide who may answer. Writing only
          // `user` — a bare string under another key — left that guard with a
          // structurally null input, so a batch id WAS a capability.
          // Null when nobody is authenticated: an unauthenticated host keeps
          // working, and no owner is invented.
          const personId = request.user?.id ?? null;
          const out = await jobs.submit(task, {
            callbackUrl,
            metadata: {
              ...(metadata ?? {}),
              user: personId,
              identity: personId ? { personId } : null,
            },
          });
          return json(202, { ...out, links: { self: `/jobs/${out.jobId}`, events: `/jobs/${out.jobId}/events` } });
        } catch (err) {
          if (err instanceof JobQueueFullError) return json(429, { ok: false, error: 'queue_full', message: err.message }, { 'retry-after': '30' });
          if (err instanceof InvalidCallbackUrlError) return json(400, { ok: false, error: 'invalid_callback_url', message: err.message });
          if (err instanceof JobsClosedError) return json(503, { ok: false, error: 'shutting_down', message: err.message });
          if (err instanceof TypeError) return json(400, { ok: false, error: 'invalid_task', message: err.message });
          throw err;
        }
      },
    };
  }

  if (jobs) {
    const humanInput = supportsHumanInput(jobs);

    routes.jobGet = {
      method: 'GET', path: '/jobs/:id',
      handler: async ({ params }) => {
        const record = await jobs.get(params.id);
        if (!record) return json(404, { ok: false, error: 'not_found' });
        if (!humanInput) return json(200, record);

        // `pendingInput` and `stale` are added rather than nested so a client
        // that knows nothing about human input reads the record it always did.
        const pending = await jobs.pendingInput(params.id);
        return json(200, { ...record, pendingInput: pending ?? null, stale: pending?.stale ?? false });
      },
    };

    if (humanInput) {
      routes.jobInput = {
        method: 'POST', path: '/jobs/:id/input',
        handler: async ({ params, body, user }) => {
          const submission = body ?? {};
          if (typeof submission.batchId !== 'string' || !submission.batchId) {
            return json(400, { ok: false, error: 'validation_failed', fields: { batchId: 'required' } });
          }

          // The answer is attributed to the authenticated caller, never to
          // whatever the body claims. A batch id is not a capability.
          const identity = user?.id ? { personId: user.id } : null;
          const out = await jobs.provideInput(params.id, submission, { identity });

          if (out.ok) return json(200, { ok: true, status: out.status, stale: out.stale, batchId: out.batchId });

          // `code` and its HTTP status travel together from `REFUSALS`, so a
          // new refusal cannot be added without deciding what it means here.
          const { code, status, ok, ...detail } = out;
          return json(status ?? 409, { ok: false, error: code, ...detail });
        },
      };
    }
    routes.jobCancel = {
      method: 'DELETE', path: '/jobs/:id',
      handler: async ({ params }) => {
        const out = await jobs.cancel(params.id);
        if (out.ok && out.status === 'cancelling') return json(202, out);
        if (out.ok) return json(200, out);
        if (out.status === null) return json(404, { ok: false, error: 'not_found' });
        return json(409, { ok: false, error: 'already_terminal', status: out.status });
      },
    };
    if (notifier?.sseHandler) {
      routes.jobEvents = { method: 'GET', path: '/jobs/:id/events', handler: notifier.sseHandler };
    }
  }

  if (scheduler) {
    routes.schedules = {
      method: 'GET', path: '/schedules', auth: false,
      handler: async () => json(200, scheduler.getSchedules()),
    };
  }
  return routes;
}
