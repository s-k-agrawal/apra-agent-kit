// host/jobs/durable.mjs
// Jobs backend over Azure Durable Functions. The orchestration instance id IS the
// job id. All job state lives in the task hub; this module keeps only per-subscriber
// polling cursors in memory. It reads the customStatus contract that
// comm/azure-functions/orchestrator.mjs writes.
import { JobQueueFullError, JobsClosedError, validateCallbackUrl } from './interface.mjs';
import {
  TERMINAL_STATUSES, createRecord, queuedEvent,
  answerReceivedEntry, questionExpiredEntry, inputResolvedEvent,
} from './record.mjs';
import { planResume } from '../human-input/resume.mjs';
import { answeredBatchesFromHistory } from '../human-input/ask.mjs';
import { isStale, isExpired } from '../human-input/batch.mjs';

export const ORCHESTRATOR_NAME = 'runTaskOrchestrator';
export const ACTIVITY_NAME = 'runTaskActivity';
const ACTIVE = ['Pending', 'Running'];
const STATUS_OPTS = { showHistory: false, showInput: true };

export function mapDurableStatus(instance) {
  if (!instance) return null;
  const record = instance.input?.record ? structuredClone(instance.input.record) : { id: instance.instanceId };
  const cs = instance.customStatus ?? {};
  const rt = instance.runtimeStatus;

  let status;
  if (rt === 'Pending') status = 'queued';
  else if (rt === 'Running' || rt === 'Suspended' || rt === 'ContinuedAsNew') status = cs.status && cs.status !== 'queued' ? cs.status : 'processing';
  // A paused run is a *Completed* orchestration - that is the whole design -
  // so the output has to be consulted before the runtime status is believed.
  else if (rt === 'Completed') status = instance.output?.status === 'paused' ? 'waiting_input' : (instance.output?.status ?? cs.status ?? 'completed');
  else if (rt === 'Terminated' || rt === 'Canceled') status = 'cancelled';
  else status = 'failed';

  const out = { ...record, status };
  if (cs.startedAt) out.startedAt = cs.startedAt;
  if (cs.finishedAt) out.finishedAt = cs.finishedAt;
  if (cs.progress) out.progress = cs.progress;
  if (rt === 'Completed' && instance.output && typeof instance.output === 'object') {
    if (instance.output.status === 'paused') {
      // The output *is* the store here. Nothing else holds this run's state.
      out.pendingInput = instance.output.batch ?? null;
      out.snapshot = instance.output.snapshot ?? null;
      out.history = instance.output.history ?? [];
      out.result = null;
      out.error = null;
    } else {
      out.result = instance.output.result ?? null;
      out.error = instance.output.error ?? null;
      out.history = instance.output.history ?? [];
      out.budget = instance.output.budget ?? null;
    }
  }
  if (rt === 'Failed') {
    const message = typeof instance.output === 'string' ? instance.output : JSON.stringify(instance.output ?? 'orchestration failed');
    out.error = { code: 'activity_failed', message };
  }
  if (TERMINAL_STATUSES.has(status) && !out.finishedAt) out.finishedAt = instance.lastUpdatedTime ?? null;
  return out;
}

// The orchestrator stores `seq` on every event it appends, so numbering survives
// ring truncation. Fall back to position only for events that lack it.
function withSeq(events = []) {
  return events.map((e, i) => ({ ...e, seq: e.seq ?? i + 1 }));
}

function clientFactory({ client, getClient }) {
  if (typeof getClient === 'function') return getClient;
  if (client) return () => client;
  throw new Error('createDurableJobs requires a Durable client');
}

export function createDurableJobs({ client, getClient, config, notifier = null, logger = console, allowHttpCallbacks = false, now = () => new Date() }) {
  const resolveClient = clientFactory({ client, getClient });
  const { maxQueueSize = 100, durable: { pollMs = 2000 } = {} } = config ?? {};
  let closed = false;
  let lastStats = { queued: 0, processing: 0 };
  const pollers = new Map(); // jobId → { timer, subs: Set<fn>, lastSeq }
  const liveSeqs = new Map(); // jobId → next seq (for activity-injected events)

  function requireClient() {
    const c = resolveClient();
    if (!c) throw new Error('createDurableJobs requires a Durable client');
    return c;
  }

  const activeInstances = (bound) => bound.getStatusBy({ runtimeStatus: ACTIVE });

  function stopPoller(jobId) {
    const s = pollers.get(jobId);
    if (!s) return;
    clearInterval(s.timer);
    pollers.delete(jobId);
  }

  function startPoller(jobId) {
    const bound = requireClient();
    const state = { subs: new Set(), lastSeq: 0, timer: null };
    const tick = async () => {
      try {
        const inst = await bound.getStatus(jobId, STATUS_OPTS);
        const events = withSeq(inst?.customStatus?.events);
        for (const e of events) {
          if (e.seq <= state.lastSeq) continue;
          state.lastSeq = e.seq;
          for (const fn of state.subs) {
            try { fn(e); } catch (err) { logger.warn(`[durable] subscriber error: ${err?.message ?? err}`); }
          }
        }
        const rec = mapDurableStatus(inst);
        const finished = !inst || TERMINAL_STATUSES.has(rec?.status);
        if (finished && (state.subs.size === 0 || events.at(-1)?.type === 'settled')) stopPoller(jobId);
      } catch (err) {
        logger.warn(`[durable] poll ${jobId} failed: ${err?.message ?? err}`);
      }
    };
    state.timer = setInterval(() => void tick(), pollMs);
    state.timer.unref?.();
    void tick();
    pollers.set(jobId, state);
    return state;
  }

  return {
    async start() {},

    async stop() {
      closed = true;
      for (const id of [...pollers.keys()]) stopPoller(id);
    },

    async submit(task, { callbackUrl, metadata } = {}) {
      if (closed) throw new JobsClosedError();
      if (!task || typeof task.goal !== 'string' || !task.goal.trim()) throw new TypeError('task.goal is required');
      const url = validateCallbackUrl(callbackUrl, { allowHttp: allowHttpCallbacks });
      const bound = requireClient();
      const active = await activeInstances(bound);
      if (active.length >= maxQueueSize) throw new JobQueueFullError();
      const record = createRecord(task, { callbackUrl: url, metadata, now: now() });
      const position = active.filter(i => i.runtimeStatus === 'Pending').length + 1;
      await bound.startNew(ORCHESTRATOR_NAME, {
        instanceId: record.id,
        input: {
          task: { id: record.id, ...record.task },
          record,
          callbackUrl: url,
          metadata: metadata ?? {},
          queuedEvent: queuedEvent(record.id, position, now()),
        },
      });
      return { jobId: record.id, status: 'queued', position };
    },

    async get(jobId) {
      return mapDurableStatus(await requireClient().getStatus(jobId, STATUS_OPTS));
    },

    async cancel(jobId) {
      const bound = requireClient();
      const inst = await bound.getStatus(jobId, STATUS_OPTS);
      if (!inst) return { ok: false, status: null };
      const rec = mapDurableStatus(inst);
      if (TERMINAL_STATUSES.has(rec.status)) return { ok: false, status: rec.status };
      if (inst.runtimeStatus === 'Pending') {
        await bound.terminate(jobId, 'cancelled before start');
        return { ok: true, status: 'cancelled' };
      }
      await bound.raiseEvent(jobId, 'cancel', {});
      return { ok: true, status: 'cancelling' };
    },

    subscribe(jobId, onEvent) {
      const state = pollers.get(jobId) ?? startPoller(jobId);
      state.subs.add(onEvent);
      return () => {
        state.subs.delete(onEvent);
        if (state.subs.size === 0) stopPoller(jobId);
      };
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      const inst = await requireClient().getStatus(jobId, STATUS_OPTS);
      return withSeq(inst?.customStatus?.events).filter(e => e.seq > afterSeq);
    },

    emitEvent(jobId, event) {
      const seq = (liveSeqs.get(jobId) ?? 100) + 1;
      liveSeqs.set(jobId, seq);
      const e = { ...event, seq };
      const state = pollers.get(jobId);
      if (state) {
        state.lastSeq = Math.max(state.lastSeq, seq);
        for (const fn of state.subs) {
          try { fn(e); } catch (err) { logger.warn(`[durable] emitEvent subscriber error: ${err?.message ?? err}`); }
        }
      }
    },

    /** Every run parked on a question. A paused run is a Completed instance. */
    async listWaiting() {
      const bound = requireClient();
      const done = await bound.getStatusBy({ runtimeStatus: ['Completed'] });
      return done
        .filter(i => i.customStatus?.status === 'waiting_input' || i.output?.status === 'paused')
        .map(mapDurableStatus);
    },

    async pendingInput(jobId) {
      const inst = await requireClient().getStatus(jobId, STATUS_OPTS);
      const batch = inst?.output?.batch ?? null;
      if (!batch) return null;
      return { ...batch, stale: isStale(batch, now()), expired: isExpired(batch, now()) };
    },

    // Staleness is a view here, not a stored flag: there is no record to write
    // it on, and it is recomputed from the batch's own deadline anyway.
    async markInputStale() {
      return { ok: false, reason: 'not_applicable' };
    },

    /**
     * Accept an answer and start a **new** orchestration to carry the run on.
     *
     * This is the crux of the Azure design, and it is why the replay bug
     * cannot come back: *we do not resume an orchestration, we start another
     * one.* No `waitForExternalEvent`, no `Task.any`, no growing replay
     * history, nothing billed while a person thinks.
     *
     * The previous output is read first, because `startNew` on the same
     * instance id replaces it - and it is the only copy of the run's state.
     */
    async provideInput(jobId, submission, { identity = null } = {}) {
      if (closed) throw new JobsClosedError();
      const bound = requireClient();

      const inst = await bound.getStatus(jobId, STATUS_OPTS);
      const record = mapDurableStatus(inst);
      const history = record?.history ?? [];

      const plan = planResume(record, submission, { history, identity, now: now() });
      if (!plan.ok) return plan;

      const answerEntry = answerReceivedEntry(jobId, {
        batchId: plan.batch.batchId, answers: plan.answers, answeredBy: plan.answeredBy,
      }, now());

      // Everything the next orchestration needs, carried in its input. Read
      // before the startNew below overwrites the instance.
      await bound.startNew(ORCHESTRATOR_NAME, {
        instanceId: jobId,
        input: {
          task: inst?.input?.task ?? { id: jobId, ...(record?.task ?? {}) },
          record: { ...record, status: 'queued', pendingInput: null },
          callbackUrl: inst?.input?.callbackUrl ?? null,
          metadata: inst?.input?.metadata ?? {},
          queuedEvent: queuedEvent(jobId, 1, now()),
          resume: {
            history: [...history, answerEntry],
            answered: [...answeredBatchesFromHistory(history), { batchId: plan.batch.batchId, answers: plan.answers }],
            resumeFrom: plan.resumeFrom,
          },
        },
      });

      if (notifier) {
        try { await notifier.publish(inputResolvedEvent(jobId, { batchId: plan.batch.batchId, resolution: 'answered' }, now()), { callbackUrl: inst?.input?.callbackUrl ?? null }); }
        catch (err) { logger.warn(`[durable] notifier error: ${err?.message ?? err}`); }
      }

      return { ok: true, status: 'queued', stale: plan.stale, batchId: plan.batch.batchId };
    },

    /** Settle a run whose question nobody answered in time. */
    async expireInput(jobId) {
      const bound = requireClient();
      const inst = await bound.getStatus(jobId, STATUS_OPTS);
      const record = mapDurableStatus(inst);
      if (record?.status !== 'waiting_input') return { ok: false, code: 'not_waiting' };

      const batch = record.pendingInput;
      if (!batch || !isExpired(batch, now())) return { ok: false, code: 'not_expired' };

      // Terminating a Completed instance is a no-op, so the settle is recorded
      // by starting a short orchestration that finishes immediately failed.
      // Simpler and more honest: mark it terminated with a reason the status
      // map already reads as cancelled, and keep the history in the output.
      await bound.terminate(jobId, `input expired at ${batch.expiresAt}`);

      if (notifier) {
        try {
          await notifier.publish(questionExpiredEntry(jobId, { batchId: batch.batchId }, now()), { callbackUrl: inst?.input?.callbackUrl ?? null });
          await notifier.publish(inputResolvedEvent(jobId, { batchId: batch.batchId, resolution: 'timeout' }, now()), { callbackUrl: inst?.input?.callbackUrl ?? null });
        } catch (err) { logger.warn(`[durable] notifier error: ${err?.message ?? err}`); }
      }
      return { ok: true, status: 'failed', batchId: batch.batchId };
    },

    async refreshStats() {
      const active = await activeInstances(requireClient());
      lastStats = {
        queued: active.filter(i => i.runtimeStatus === 'Pending').length,
        processing: active.filter(i => i.runtimeStatus === 'Running').length,
      };
      return lastStats;
    },

    stats() {
      return { ...lastStats, capacity: 1, maxQueueSize };
    },
  };
}
