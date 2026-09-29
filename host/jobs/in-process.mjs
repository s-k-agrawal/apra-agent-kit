import { JobQueueFullError, JobsClosedError, validateCallbackUrl } from './interface.mjs';
import {
  TERMINAL_STATUSES, createRecord, queuedEvent, startedEvent, progressEvent, settledEvent, settleFromRunResult,
  inputRequiredEvent, inputResolvedEvent,
  questionAskedEntry, answerReceivedEntry, questionExpiredEntry,
} from './record.mjs';
import { capture, resumeState } from '../human-input/snapshot.mjs';
import { createAskUser, answeredBatchesFromHistory } from '../human-input/ask.mjs';
import { planResume } from '../human-input/resume.mjs';
import { isStale, isExpired } from '../human-input/batch.mjs';

const FORCE_SETTLE_AFTER_ABORT_MS = 30_000;

export function createInProcessJobs({
  store, runJob, notifier = null, config, logger = console, now = () => new Date(),
  allowHttpCallbacks = false, humanInput = null, kitVersion = null,
}) {
  if (!store) throw new Error('createInProcessJobs requires store');
  if (typeof runJob !== 'function') throw new Error('createInProcessJobs requires runJob');
  const {
    maxQueueSize = 100, concurrency: requestedConcurrency = 1, leaseTimeoutMs = 660_000,
    retentionMs = 86_400_000, drainMs = 30_000, capacity = 1,
    sweepIntervalMs = Math.max(1000, Math.min(15_000, Math.floor(leaseTimeoutMs / 4))),
  } = config ?? {};

  let concurrency = requestedConcurrency;
  if (concurrency > capacity) {
    logger.warn(`[jobs] dispatch.concurrency ${concurrency} exceeds worker capacity ${capacity}; clamping`);
    concurrency = Math.max(1, capacity);
  }

  const queue = [];                    // job ids in submit order
  const running = new Map();           // jobId → { controller, startedAt, promise }
  const subscribers = new Map();       // jobId → Set<fn>
  const callbackUrls = new Map();      // jobId → callbackUrl (for notifier ctx)
  let submitting = 0;                  // slots reserved in submit() before queue.push
  let closed = false;
  let started = false;
  let sweepTimer = null;
  let purgeTimer = null;

  const iso = () => now().toISOString();

  async function publish(jobId, event) {
    const seq = await store.appendEvent(jobId, event);
    const full = { seq, ...event };
    for (const fn of subscribers.get(jobId) ?? []) {
      try { fn(full); } catch (err) { logger.warn(`[jobs] subscriber error: ${err?.message ?? err}`); }
    }
    if (notifier) {
      try { await notifier.publish(full, { callbackUrl: callbackUrls.get(jobId) ?? null }); }
      catch (err) { logger.warn(`[jobs] notifier error: ${err?.message ?? err}`); }
    }
    return full;
  }

  async function settle(jobId, { status, result, error, history = [], budget = null }) {
    // A settled job holds no unanswered question. Leaving `pendingInput` set
    // would leave a form on screen for a run that has finished.
    await store.update(jobId, { status, result, error, history, budget, finishedAt: iso(), pendingInput: null });
    await publish(jobId, settledEvent(jobId, { status, result, error }, now()));
    callbackUrls.delete(jobId);
    if (TERMINAL_STATUSES.has(status)) subscribers.delete(jobId);
  }

  const humanInputEnabled = humanInput?.enabled === true;

  // What a fresh worker needs to pick a run back up. Derived from the record
  // and its history every time rather than held in memory, so a resume works
  // identically after a restart — which is the whole point of the feature.
  async function resumeContextFor(jobId, record) {
    const history = await store.events(jobId);

    // Only the most recent answer is replayed. Restored observations already
    // carry the effect of every earlier question, so those tool calls are not
    // repeated and their answers would never be asked for again — queueing
    // them hands the next question a stale answer. See resume.mjs.
    const answered = answeredBatchesFromHistory(history).slice(-1);

    let resumeFrom = null;
    if (record.snapshot || answered.length > 0) {
      const { state, source, reason } = resumeState(record, history, { kitVersion, now: now() });
      if (source === 'history' && reason !== 'absent') {
        logger.warn(`[jobs] job ${jobId} resumed from history (${reason}); its snapshot was unusable`);
      }
      resumeFrom = {
        observations: state.observations,
        plan: state.plan,
        budget: state.budget,
        interruptions: state.interruptions,
        identity: state.identity,
      };
    }

    const askUser = createAskUser({
      jobId,
      config: humanInput,
      answered,
      interruptions: resumeFrom?.interruptions ?? 0,
      // Written before the pause unwinds. If this throws the pause fails and
      // the run settles failed — an unpersisted question is one nobody sees.
      onQuestion: (batch) => store.appendEvent(jobId, questionAskedEntry(jobId, { batch }, now())),
    });

    return { resumeFrom, askUser };
  }

  /**
   * Park a run that asked a person something.
   *
   * The lease is released by `runOne`'s `finally` exactly as it is for a
   * settled job — that is what stops one unanswered question holding a worker
   * slot for a week at `dispatch.concurrency: 1`.
   */
  async function park(jobId, record, outcome, askUser) {
    const snapshot = capture({
      jobId,
      traceId: outcome.traceId ?? null,
      kitVersion,
      task: record.task,
      observations: outcome.progress?.observations ?? outcome.history ?? [],
      plan: outcome.progress?.plan ?? null,
      budget: outcome.budget ?? null,
      interruptions: askUser?.interruptions?.() ?? 0,
      identity: record.metadata?.identity ?? null,
      pendingBatchId: outcome.batchId,
      writtenAt: now(),
    });

    await store.update(jobId, {
      status: 'waiting_input',
      pendingInput: outcome.batch,
      snapshot,
      history: outcome.history ?? [],
      budget: outcome.budget ?? null,
    });
    await publish(jobId, inputRequiredEvent(jobId, outcome.batch, now()));
  }

  function settlementFromAbort(reason) {
    if (reason === 'lease_expired') {
      return { status: 'failed', result: null, error: { code: 'lease_expired', message: `exceeded leaseTimeoutMs ${leaseTimeoutMs}` }, history: [], budget: null };
    }
    if (reason === 'shutdown') {
      return { status: 'failed', result: null, error: { code: 'interrupted', message: 'host shut down while processing' }, history: [], budget: null };
    }
    if (reason === 'cancelled') {
      return { status: 'cancelled', result: null, error: null, history: [], budget: null };
    }
    return null;
  }

  async function runOne(jobId, entry) {
    try {
      const claimed = await store.claim(jobId, entry.startedAt);
      if (!claimed) return;                                   // cancelled meanwhile or claimed elsewhere

      const abortBeforeStart = settlementFromAbort(entry.controller.signal.aborted ? entry.controller.signal.reason : null);
      if (abortBeforeStart) {
        await settle(jobId, abortBeforeStart);
        return;
      }

      const record = await store.get(jobId);
      if (!record) return;
      await publish(jobId, startedEvent(jobId, now()));

      const abortAfterStarted = settlementFromAbort(entry.controller.signal.aborted ? entry.controller.signal.reason : null);
      if (abortAfterStarted) {
        await settle(jobId, abortAfterStarted);
        return;
      }

      const onProgress = async ({ iteration, message, ...detail }) => {
        if (entry.controller.signal.aborted) return;
        await store.update(jobId, { progress: { iteration, message, at: iso() } });
        await publish(jobId, progressEvent(jobId, iteration, { message, ...detail }, now()));
      };

      const task = { id: jobId, ...record.task };
      const { resumeFrom, askUser } = humanInputEnabled
        ? await resumeContextFor(jobId, record)
        : { resumeFrom: null, askUser: undefined };

      const run = Promise.resolve()
        .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
        .then(() => runJob(task, { signal: entry.controller.signal, onProgress, askUser, resumeFrom }))
        .catch(err => ({ status: 'failed', result: { error: 'run_failed', message: String(err?.message ?? err) }, history: [], budget: null }));

      // If aborted and the run loop does not return within the grace period, settle anyway.
      let forceTimer = null;
      const forced = new Promise((resolve) => {
        const arm = () => {
          forceTimer = setTimeout(() => resolve({ status: 'cancelled', result: null, history: [], budget: null }), FORCE_SETTLE_AFTER_ABORT_MS);
          forceTimer.unref?.();
        };
        if (entry.controller.signal.aborted) arm();
        else entry.controller.signal.addEventListener('abort', arm, { once: true });
      });

      const outcome = await Promise.race([run, forced]);
      clearTimeout(forceTimer);
      const reason = entry.controller.signal.aborted ? entry.controller.signal.reason : null;

      // A run that asked a person something parks instead of settling. An
      // abort still wins: a cancelled run is cancelled whether or not it had a
      // question outstanding.
      if (outcome.status === 'paused' && !reason) {
        try {
          await park(jobId, record, outcome, askUser);
        } catch (err) {
          // The question was never stored, so nobody will ever answer it.
          // Settling failed is the only honest outcome — carrying on would
          // mean proceeding past an approval that was never given.
          logger.warn(`[jobs] job ${jobId} could not be parked: ${err?.message ?? err}`);
          await settle(jobId, {
            status: 'failed', result: null,
            error: { code: 'pause_failed', message: String(err?.message ?? err) },
            history: outcome.history ?? [], budget: outcome.budget ?? null,
          });
        }
        return;
      }

      let settled = settleFromRunResult(outcome);
      const fromAbort = settlementFromAbort(reason);
      if (fromAbort) settled = { ...settled, status: fromAbort.status, result: fromAbort.result, error: fromAbort.error };
      await settle(jobId, settled);
    } finally {
      running.delete(jobId);
      pump();
    }
  }

  function pump() {
    if (closed) return;
    while (running.size < concurrency && queue.length > 0) {
      const jobId = queue.shift();
      const controller = new AbortController();
      const entry = { controller, startedAt: iso(), promise: null };
      running.set(jobId, entry);
      entry.promise = runOne(jobId, entry).catch(err => logger.warn(`[jobs] runOne failed: ${err?.message ?? err}`));
    }
  }

  async function sweepLeases() {
    const cutoff = now().getTime() - leaseTimeoutMs;
    for (const [jobId, entry] of running) {
      if (!entry.controller.signal.aborted && new Date(entry.startedAt).getTime() < cutoff) {
        logger.warn(`[jobs] job ${jobId} exceeded leaseTimeoutMs; aborting`);
        entry.controller.abort('lease_expired');
      }
    }
  }

  async function purge() {
    const cutoff = new Date(now().getTime() - retentionMs).toISOString();
    const n = await store.purgeFinishedBefore(cutoff);
    if (n) logger.info(`[jobs] purged ${n} finished jobs older than ${cutoff}`);
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await store.open();
      for (const r of await store.listByStatus('processing')) {
        await store.update(r.id, {
          status: 'failed', finishedAt: iso(),
          error: { code: 'interrupted', message: 'process restarted while job was processing' },
        });
        await publish(r.id, settledEvent(r.id, { status: 'failed', result: null, error: { code: 'interrupted', message: 'process restarted while job was processing' } }, now()));
      }
      for (const r of await store.listByStatus('queued')) {
        queue.push(r.id);
        if (r.callbackUrl) callbackUrls.set(r.id, r.callbackUrl);
      }
      await purge();
      sweepTimer = setInterval(() => void sweepLeases(), sweepIntervalMs); sweepTimer.unref?.();
      purgeTimer = setInterval(() => void purge(), Math.max(60_000, Math.floor(retentionMs / 24))); purgeTimer.unref?.();
      pump();
    },

    async stop({ drainMs: drain = drainMs } = {}) {
      closed = true;
      clearInterval(sweepTimer); clearInterval(purgeTimer);
      const inflight = [...running.values()].map(e => e.promise).filter(Boolean);
      if (inflight.length) {
        let drainTimer;
        await Promise.race([
          Promise.allSettled(inflight),
          new Promise(r => { drainTimer = setTimeout(r, drain); }),
        ]);
        clearTimeout(drainTimer);
        for (const entry of running.values()) entry.controller.abort('shutdown');
        await Promise.allSettled([...running.values()].map(e => e.promise));
      }
      await store.close();
    },

    async submit(task, { callbackUrl, metadata } = {}) {
      if (closed) throw new JobsClosedError();
      if (!task || typeof task.goal !== 'string' || !task.goal.trim()) throw new TypeError('task.goal is required');
      const url = validateCallbackUrl(callbackUrl, { allowHttp: allowHttpCallbacks });
      if (queue.length + submitting >= maxQueueSize) throw new JobQueueFullError();
      submitting += 1;
      let record;
      try {
        record = createRecord(task, { callbackUrl: url, metadata, now: now() });
        await store.insert(record);
        if (url) callbackUrls.set(record.id, url);
        queue.push(record.id);
      } finally {
        submitting -= 1;
      }
      // Position is FIFO rank among unfinished jobs. pump() may already have
      // shifted an earlier id off `queue`, so queue.length alone is too small.
      const counts = await store.countByStatus();
      const position = (counts.queued ?? 0) + (counts.processing ?? 0);
      await publish(record.id, queuedEvent(record.id, position, now()));
      pump();
      return { jobId: record.id, status: 'queued', position };
    },

    async get(jobId) { return store.get(jobId); },

    async cancel(jobId) {
      const record = await store.get(jobId);
      if (!record) return { ok: false, status: null };
      if (TERMINAL_STATUSES.has(record.status)) return { ok: false, status: record.status };
      const entry = running.get(jobId);
      if (entry) {
        if (!entry.controller.signal.aborted) entry.controller.abort('cancelled');
        return { ok: true, status: 'cancelling' };
      }
      // Cancelling while waiting is straightforward precisely because nothing
      // is running: no abort signal, no force-settle timer, no grace period.
      if (record.status === 'waiting_input') {
        const batchId = record.pendingInput?.batchId ?? null;
        await settle(jobId, { status: 'cancelled', result: null, error: null });
        if (batchId) await publish(jobId, inputResolvedEvent(jobId, { batchId, resolution: 'cancelled' }, now()));
        return { ok: true, status: 'cancelled' };
      }

      if (record.status === 'queued') {
        const idx = queue.indexOf(jobId);
        if (idx >= 0) queue.splice(idx, 1);
        await settle(jobId, { status: 'cancelled', result: null, error: null });
        return { ok: true, status: 'cancelled' };
      }
      return { ok: true, status: 'cancelling' };
    },

    /** Every job parked on a question. The sweep's whole input. */
    async listWaiting() {
      return store.listByStatus('waiting_input');
    },

    /**
     * Record that a question has gone stale. Soft — the batch stays answerable;
     * this only means the person is told the world may have moved.
     */
    async markInputStale(jobId) {
      const record = await store.get(jobId);
      if (record?.status !== 'waiting_input' || record.staleNotifiedAt) return { ok: false };
      await store.update(jobId, { staleNotifiedAt: iso() });
      return { ok: true };
    },

    /** The unanswered batch for a job, with whether it has gone stale. */
    async pendingInput(jobId) {
      const record = await store.get(jobId);
      if (!record?.pendingInput) return null;
      return {
        ...record.pendingInput,
        stale: isStale(record.pendingInput, now()),
        expired: isExpired(record.pendingInput, now()),
      };
    },

    /**
     * Accept an answer and put the job back in the queue.
     *
     * The guard against a double answer is the status transition itself: the
     * first answer moves the job out of `waiting_input`, so the second finds
     * the wrong status and is refused. See `planResume` for why that is enough
     * here, and where it would not be.
     */
    async provideInput(jobId, submission, { identity = null } = {}) {
      if (closed) throw new JobsClosedError();

      const record = await store.get(jobId);
      const history = record ? await store.events(jobId) : [];
      const plan = planResume(record, submission, { history, identity, kitVersion, now: now() });
      if (!plan.ok) return plan;

      // History first. If the transition below fails, the answer is still
      // recorded — the opposite order could accept an answer, resume on it,
      // and have no record of what was agreed.
      await store.appendEvent(jobId, answerReceivedEntry(jobId, {
        batchId: plan.batch.batchId, answers: plan.answers, answeredBy: plan.answeredBy,
      }, now()));

      // Back to `queued`, not straight to `processing`: no worker holds this
      // job, and `store.claim()` is what stops two workers taking it. Going
      // through the queue reuses that unchanged.
      await store.update(jobId, { status: 'queued', pendingInput: null });
      await publish(jobId, inputResolvedEvent(jobId, { batchId: plan.batch.batchId, resolution: 'answered' }, now()));

      queue.push(jobId);
      pump();

      return { ok: true, status: 'queued', stale: plan.stale, batchId: plan.batch.batchId };
    },

    /**
     * Settle a run whose question nobody answered in time.
     *
     * An expiry is not an answer: nothing was approved, so the run settles
     * rather than continuing as though it had been refused.
     */
    async expireInput(jobId) {
      const record = await store.get(jobId);
      if (!record || record.status !== 'waiting_input') return { ok: false, code: 'not_waiting' };
      const batch = record.pendingInput;
      if (!batch || !isExpired(batch, now())) return { ok: false, code: 'not_expired' };

      await store.appendEvent(jobId, questionExpiredEntry(jobId, { batchId: batch.batchId }, now()));
      await settle(jobId, {
        status: 'failed', result: null,
        error: { code: 'input_expired', message: `nobody answered by ${batch.expiresAt}` },
        history: record.history ?? [], budget: record.budget ?? null,
      });
      await publish(jobId, inputResolvedEvent(jobId, { batchId: batch.batchId, resolution: 'timeout' }, now()));
      return { ok: true, status: 'failed', batchId: batch.batchId };
    },

    subscribe(jobId, onEvent) {
      const set = subscribers.get(jobId) ?? new Set();
      set.add(onEvent); subscribers.set(jobId, set);
      return () => { set.delete(onEvent); if (set.size === 0) subscribers.delete(jobId); };
    },

    async events(jobId, { afterSeq = 0 } = {}) { return store.events(jobId, { afterSeq }); },

    stats() {
      return { queued: queue.length, processing: running.size, capacity: concurrency, maxQueueSize };
    },
  };
}
