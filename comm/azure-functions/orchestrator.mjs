// comm/azure-functions/orchestrator.mjs
// One orchestration per job. Deterministic: it only reacts to Durable-delivered
// tasks (activity completion, 'progress' events, 'cancel' events). The activity
// (activity.mjs) is the run loop; this generator only records what it is told.
//
// customStatus contract read by host/jobs/durable.mjs:
//   { status, events: [{ seq, ...JobEvent }] (ring of 50, queued/started/settled always kept),
//     progress: { iteration, message, at }, cancelRequested, startedAt, finishedAt }
import { ACTIVITY_NAME } from '../../host/jobs/durable.mjs';

/** The per-step activity. One step, then it hands control back to commit. */
export const ADVANCE_NAME = 'advanceTaskActivity';

/** Upper bound on steps in one orchestration. See the loop for why. */
const MAX_STEPS = 50;
import { ringEvents } from '../../host/jobs/record.mjs';

const DURABLE_PAYLOAD_MAX_CHARS = 12_000; // stay safely under the 16 KB UTF-16 limit

function truncateOutput(output) {
  const json = JSON.stringify(output);
  if (json.length <= DURABLE_PAYLOAD_MAX_CHARS) return output;
  const safe = { ...output };
  if (typeof safe.result === 'string' && safe.result.length > 2000) {
    safe.result = safe.result.slice(0, 2000) + '… [truncated]';
  }
  if (JSON.stringify(safe).length > DURABLE_PAYLOAD_MAX_CHARS) {
    safe.result = typeof safe.result === 'string'
      ? safe.result.slice(0, 500) + '… [truncated]'
      : null;
  }
  return safe;
}

export function buildOrchestrator({ ringSize = 50 } = {}) {
  return function* runTaskOrchestrator(context) {
    const df = context.df;
    const input = df.getInput();
    const jobId = df.instanceId;
    const nowIso = () => (df.currentUtcDateTime ?? new Date()).toISOString();

    let seq = 0;
    const events = [];
    const push = (e) => { seq += 1; events.push({ ...e, seq }); };
    const state = {
      status: 'queued', events, progress: { iteration: 0, message: null, at: null },
      cancelRequested: false, startedAt: null, finishedAt: null,
    };
    const publish = () => df.setCustomStatus({ ...state, events: ringEvents(events, ringSize) });

    push(input.queuedEvent ?? { type: 'queued', jobId, at: nowIso(), position: 1 });
    state.status = 'processing';
    state.startedAt = nowIso();
    push({ type: 'started', jobId, at: state.startedAt });
    publish();

    // The run loop.
    //
    // Each pass advances the run by one step and commits the result before the
    // next one starts, because `callEntity` is reachable only from here — an
    // activity has no confirmed write. A crash between the two is safe: the
    // step's idempotency key is committed with its observation, so a retried
    // advance skips work that was already done.
    //
    // **Determinism.** The yield sequence below derives only from the input and
    // prior activity results. It must stay that way. An earlier version raced
    // `waitForExternalEvent('progress')` against the activity inside a loop, so
    // the number of tasks created varied with how many events had arrived by a
    // given replay; that drifted the SDK's event-ID counter until callActivity
    // stopped matching its history entry and scheduled a new activity every
    // time. One request produced 125 activities and exhausted the worker pool.
    // There are no external events here now — cancellation is polled by the
    // activity. See docs/specs/2026-09-30-azure-durable-entity-storage-spec.md §5.
    const checkpointKey = `cp-${jobId}`;
    const cpEntity = new df.EntityId('checkpoint', checkpointKey);

    let output = null;
    let steps = 0;

    // A bound, not a feature: an unbounded loop in an orchestrator is how a
    // replay bug becomes an unbounded bill.
    while (steps < MAX_STEPS) {
      steps += 1;
      const advanced = yield df.callActivity(ADVANCE_NAME, { ...input, jobId, checkpointKey });

      if (advanced.cleared) {
        // The run finished and dropped its checkpoint. Leaving the row behind
        // would keep state for a run that is over.
        yield df.callEntity(cpEntity, 'clear');
      } else if (advanced.delta) {
        yield df.callEntity(cpEntity, 'save', advanced.delta);
      }

      if (advanced.done) { output = advanced; break; }
    }

    if (!output) {
      output = {
        status: 'failed',
        result: null,
        error: {
          code: 'too_many_steps',
          message: `job ${jobId} did not finish within ${MAX_STEPS} steps; giving up rather than looping`,
        },
      };
    }

    const at = nowIso();

    // A pause ends the orchestration. It does not wait.
    //
    // `waitForExternalEvent` is the obvious alternative and it is the wrong
    // one twice over: the replay bug documented above returns the moment this
    // generator yields more than once, and an orchestration parked on an event
    // is billed and replayed for as long as the person takes. Instead the
    // orchestration *completes*, its output carries the state, and answering
    // starts a new one. See host/jobs/durable.mjs provideInput().
    if (output.status === 'paused') {
      state.status = 'waiting_input';
      state.finishedAt = null;
      // Small on purpose. customStatus has a hard size limit and is a live
      // view, never a source of truth - the state is in the output.
      state.pendingInput = {
        batchId: output.batchId,
        askedBy: output.batch?.askedBy ?? null,
        staleAfter: output.batch?.staleAfter ?? null,
        expiresAt: output.batch?.expiresAt ?? null,
      };
      push({ type: 'input_required', jobId, at, batchId: output.batchId, questions: output.batch?.questions ?? [], askedBy: output.batch?.askedBy ?? null, staleAfter: output.batch?.staleAfter ?? null, expiresAt: output.batch?.expiresAt ?? null });
      publish();
      // The pointer. `provideInput` reads the checkpoint entity by this key, so
      // an output without it is a paused run nobody can resume.
      return guardPausedOutput({
        status: 'paused',
        batchId: output.batchId,
        batch: output.batch,
        checkpointKey,
        asked: output.asked ?? [],
      }, jobId);
    }

    state.status = output.status;
    state.finishedAt = at;
    push({ type: 'settled', jobId, at, status: output.status, result: output.result ?? null, error: output.error ?? null });
    publish();
    // A clean settled output. `advance` returns an envelope carrying `done`,
    // `delta` and `cleared`, which are the loop's business and not part of the
    // contract mapDurableStatus reads.
    return truncateOutput({
      status: output.status,
      result: output.result ?? null,
      error: output.error ?? null,
      ...(output.history ? { history: output.history } : {}),
      ...(output.budget ? { budget: output.budget } : {}),
    });
  };
}

export const runTaskOrchestrator = buildOrchestrator();

/**
 * A paused output is a pointer now, so it cannot realistically exceed the
 * 16 KB Durable cap.
 *
 * This stays as an assertion rather than a path: if it ever fires, something
 * has started putting state back in the output, and failing loudly beats
 * truncating a pointer into nonsense.
 */
function guardPausedOutput(output, jobId) {
  const json = JSON.stringify(output);
  if (json.length <= DURABLE_PAYLOAD_MAX_CHARS) return output;

  return {
    status: 'failed',
    result: null,
    error: {
      code: 'pause_too_large',
      message:
        `job ${jobId} paused with ${json.length} characters of output; a paused output must be a ` +
        'pointer, not state. Something is writing run state into the orchestration output again.',
    },
  };
}
