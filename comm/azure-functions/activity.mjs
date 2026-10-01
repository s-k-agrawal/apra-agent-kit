// comm/azure-functions/activity.mjs
// The run loop inside a Durable activity. Progress events are pushed directly
// to the jobs backend's SSE subscribers (bypassing the orchestrator) so the
// chat UI can show tool execution in real time.
import { executeHostedTask, settleWhenAborted } from '../../host/tasks.mjs';
import { settleFromRunResult, questionAskedEntry } from '../../host/jobs/record.mjs';
import { createAskUser } from '../../host/human-input/ask.mjs';
import { createCheckpoint } from '../../host/checkpoint/index.mjs';
import { runAdvance } from './advance.mjs';
import { checkpointKey } from '../../host/checkpoint/record.mjs';

let factory = null;
let contextPromise = null;

export function setHostContextFactory(fn) {
  factory = fn;
  contextPromise = null;
}

export function getHostContext() {
  if (!factory) return Promise.reject(new Error('host context factory not set; call setHostContextFactory first'));
  contextPromise ??= Promise.resolve().then(factory);
  return contextPromise;
}

export function createRunTaskActivity({ getClient, pollMs = 2000, getContext = getHostContext }) {
  return async function runTaskActivity(input, context) {
    const { jobId, task, callbackUrl, resume = null } = input;
    const client = getClient(context);
    const hostCtx = await getContext();
    const controller = new AbortController();
    const iso = () => new Date().toISOString();

    const emit = (event) => {
      if (hostCtx.jobs?.emitEvent) {
        hostCtx.jobs.emitEvent(jobId, event);
      }
    };

    const cancelPoll = setInterval(async () => {
      try {
        const st = await client.getStatus(jobId, { showHistory: false, showInput: false });
        if (st?.customStatus?.cancelRequested && !controller.signal.aborted) controller.abort('cancelled');
      } catch { /* transient; next tick retries */ }
    }, pollMs);
    cancelPoll.unref?.();

    // Human input on Azure. There is no job store here - the task hub is the
    // store - so a raised question travels back in the activity's return value
    // and the orchestration completes on it. `resume` carries the answers
    // already given, seeded by `provideInput` when it started this
    // orchestration.
    const humanInput = hostCtx.humanInputConfig ?? null;
    const askedHistory = [];
    const askUser = humanInput?.enabled
      ? createAskUser({
          jobId,
          config: humanInput,
          answered: resume?.answered ?? [],
          interruptions: resume?.resumeFrom?.interruptions ?? 0,
          onQuestion: (batch) => {
            askedHistory.push(questionAskedEntry(jobId, { batch }, new Date()));
            emit({ type: 'input_required', jobId, at: iso(), batchId: batch.batchId, questions: batch.questions, askedBy: batch.askedBy, staleAfter: batch.staleAfter, expiresAt: batch.expiresAt });
          },
        })
      : undefined;

    // One checkpoint for the whole activity: the strategies write it as the run
    // advances (so completed work is recorded and an irreversible step is not
    // repeated), and the pause below writes the final one. Building it only for
    // the pause left the run with nothing to save to or load from.
    const checkpoint = hostCtx.memory?.checkpointStore
      ? createCheckpoint({ store: hostCtx.memory.checkpointStore, logger: hostCtx.logger })
      : null;

    try {
      const run = await settleWhenAborted(
        executeHostedTask({ ...task, id: jobId }, {
          api: hostCtx.api,
          activeDispatcher: hostCtx.activeDispatcher,
          toolRegistry: hostCtx.toolRegistry,
          runLoopConfig: hostCtx.runLoopConfig,
          routerConfig: hostCtx.routerConfig,
          budgetsConfig: hostCtx.budgetsConfig,
          guardrailsMod: hostCtx.guardrailsMod,
          memory: hostCtx.memory,
          logger: hostCtx.logger,
          signal: controller.signal,
          onProgress: (progress) => emit({ type: 'progress', jobId, at: iso(), ...progress }),
          askUser,
          checkpoint,
          resumeFrom: resume?.resumeFrom ?? null,
        }),
        controller.signal,
      );

      // A paused run is not a settled one. It returns the state a later
      // orchestration will rebuild from - which on Azure is the *only* copy,
      // because there is no store beside the task hub.
      if (run.status === 'paused' && !controller.signal.aborted) {
        // The state goes to the memory store; the orchestration output carries
        // only a key. Durable caps that output at 16 KB, and a long run's state
        // does not fit — which is why #63 had to ship a pause_too_large failure.
        const taskKey = checkpointKey({ id: jobId });
        const saved = checkpoint && await checkpoint.save(taskKey, {
          jobId,
          traceId: run.traceId ?? null,
          task,
          agentName: hostCtx.runLoopConfig?.agentName ?? null,
          agentDescription: hostCtx.runLoopConfig?.agentDescription ?? null,
          strategy: run.routedTo ?? null,
          observations: run.progress?.observations ?? [],
          plan: run.progress?.plan ?? null,
          budget: run.budget ?? null,
          interruptions: askUser?.interruptions?.() ?? 0,
          identity: input.metadata?.identity ?? null,
          pendingBatchId: run.batchId,
        });

        // An unsaved pause is a question nobody will ever answer.
        if (!saved) {
          return {
            status: 'failed',
            result: null,
            error: {
              code: 'pause_failed',
              message: 'the checkpoint could not be written; the question would never be answered',
            },
          };
        }

        // `asked` is the audit record of what this segment put to a person.
        // Without it nobody can later say what they were agreeing to, and
        // learnableAnswers has no question to pair an answer with.
        return {
          status: 'paused', batchId: run.batchId, batch: run.batch,
          checkpointKey: taskKey, routedTo: run.routedTo ?? null,
          asked: askedHistory,
        };
      }

      const settled = settleFromRunResult(run);
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') {
        settled.status = 'cancelled';
        settled.result = null;
        settled.error = null;
      }
      emit({ type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result ?? null, error: settled.error ?? null, routedTo: run.routedTo ?? null });
      if (hostCtx.notifier && callbackUrl) {
        await hostCtx.notifier.publish(
          { type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result, error: settled.error },
          { callbackUrl },
        );
      }
      // Durable Functions caps activity return values at 16 KB (UTF-16).
      // UTF-16 doubles the byte count, so 16 KB UTF-16 = 8K chars max.
      // The full result is already emitted via SSE (emit) and webhook
      // (notifier) above, so the orchestrator only needs a slim payload.
      const { history, budget, ...trimmed } = settled;
      if (run.routedTo) trimmed.routedTo = run.routedTo;
      const MAX_CHARS = 7500;
      let json = JSON.stringify(trimmed);
      if (json.length > MAX_CHARS && typeof trimmed.result === 'string') {
        const overhead = json.length - trimmed.result.length;
        const room = Math.max(200, MAX_CHARS - overhead - 50);
        trimmed.result = trimmed.result.slice(0, room) + '\n\n[Full result delivered via SSE]';
        json = JSON.stringify(trimmed);
      }
      if (json.length > MAX_CHARS) {
        return { status: trimmed.status, routedTo: trimmed.routedTo ?? null, result: '[Full result delivered via SSE]', error: trimmed.error ?? null };
      }
      return trimmed;
    } finally {
      clearInterval(cancelPoll);
    }
  };
}

/**
 * The run loop's step, for the Azure path.
 *
 * Reads the run's committed state from the checkpoint entity, advances it by
 * one step, and returns a delta for the orchestrator to commit. It does not
 * write the entity itself: an activity has only `signalEntity`, which is
 * fire-and-forget, and a checkpoint nobody confirmed is one the run may lose.
 *
 * State is read rather than passed in the activity input because a run's
 * observations can exceed a Durable payload.
 */
export function createAdvanceActivity({ getClient, pollMs = 2000, getContext = getHostContext }) {
  return async function advanceTaskActivity(input, context) {
    const { jobId, task, checkpointKey, callbackUrl, resume = null } = input;
    const client = getClient(context);
    const hostCtx = await getContext();
    const controller = new AbortController();
    const iso = () => new Date().toISOString();

    const emit = (event) => {
      if (hostCtx.jobs?.emitEvent) hostCtx.jobs.emitEvent(jobId, event);
    };

    // Cancellation is polled, not raised as an external event. An orchestrator
    // that consumed events in a loop is what scheduled 125 activities for one
    // request; see orchestrator.mjs.
    const poll = setInterval(async () => {
      try {
        const st = await client.getStatus(jobId);
        if (st?.customStatus?.cancelRequested && !controller.signal.aborted) controller.abort('cancelled');
      } catch { /* a failed poll is not a reason to kill the run */ }
    }, pollMs);
    poll.unref?.();

    const humanInput = hostCtx.humanInputConfig ?? null;
    const askedHistory = [];
    const askUser = humanInput?.enabled
      ? createAskUser({
          jobId,
          config: humanInput,
          answered: resume?.answered ?? [],
          interruptions: resume?.resumeFrom?.interruptions ?? 0,
          onQuestion: (batch) => {
            askedHistory.push(questionAskedEntry(jobId, { batch }, new Date()));
            emit({ type: 'input_required', jobId, at: iso(), batchId: batch.batchId, questions: batch.questions, askedBy: batch.askedBy, staleAfter: batch.staleAfter, expiresAt: batch.expiresAt });
          },
        })
      : undefined;

    try {
      const state = await readCheckpointEntity(client, checkpointKey);

      const out = await runAdvance({
        jobId,
        task,
        state,
        hostCtx,
        signal: controller.signal,
        onProgress: (progress) => emit({ type: 'progress', jobId, at: iso(), ...progress }),
        askUser,
      });

      if (controller.signal.aborted && controller.signal.reason === 'cancelled') {
        return { status: 'cancelled', done: true, delta: null, cleared: true, result: null, error: null };
      }
      return { ...out, ...(askedHistory.length ? { asked: askedHistory } : {}) };
    } catch (err) {
      context?.warn?.(`[advance] job ${jobId} failed: ${err?.message ?? err}`);
      return {
        status: 'failed', done: true, delta: null, cleared: false, result: null,
        error: { code: 'advance_failed', message: String(err?.message ?? err) },
      };
    } finally {
      clearInterval(poll);
      if (callbackUrl) { /* the orchestrator settles; the webhook fires there */ }
    }
  };
}

/**
 * The committed state, or null when there is none.
 *
 * Null is the ordinary first case — a run that has not taken a step yet — and
 * also the fallback for a paused run created before entities existed, which
 * resumes from history instead.
 */
async function readCheckpointEntity(client, checkpointKey) {
  if (!checkpointKey || typeof client?.readEntityState !== 'function') return null;
  try {
    const df = await import('durable-functions');
    const res = await client.readEntityState(new df.EntityId('checkpoint', checkpointKey));
    return res?.entityExists ? (res.entityState ?? null) : null;
  } catch {
    return null;   // unreadable state rebuilds from history; it does not fail the run
  }
}
