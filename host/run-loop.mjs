// host/run-loop.mjs
import { createOpenEndedStrategy } from './strategies/open-ended.mjs';
import { createPlanExecuteStrategy } from './strategies/plan-execute.mjs';
import { richEvent, PROGRESS_TYPES } from './tasks.mjs';

export async function runTask(task, {
  strategy = 'open-ended',
  tools,
  fleetApi,
  signal,
  budgets,
  guardrails,
  jobs,
  workspace,
  maxReplanAttempts = 3,
  maxReviewAttempts = 2,
  maxStepReviewAttempts = 2,
  maxNoActionTurns = 3,
  minReviewPolicy = 'irreversible',
  agentName,
  agentDescription,
  onIteration,
  traceId,
  memory,
  memories,
  conversation,
  askUser,
  resumeFrom = null,
} = {}) {
  // One id for the whole run, threaded into every tool call so a result in a
  // downstream system can be traced back to the plan that produced it.
  // Callers should pass their own; we only generate one so the field is never
  // empty.
  const runTraceId = traceId ?? task?.traceId ?? `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const runMemory = memory;

  const strategyOpts = {
    task, tools, fleetApi, guardrails, jobs, workspace,
    maxReplanAttempts, maxReviewAttempts, maxStepReviewAttempts,
    maxNoActionTurns, minReviewPolicy, agentName, agentDescription,
    traceId: runTraceId,
    memory: runMemory,
    memories,
    conversation,
    askUser, resumeFrom,
  };

  const strat = strategy === 'plan-execute'
    ? createPlanExecuteStrategy(strategyOpts)
    : createOpenEndedStrategy(strategyOpts);

  let result = null;
  let status = 'failed';
  let iteration = 0;
  let pausedBatch = null;

  try {
    for await (const event of strat.iterate()) {
      if (signal?.aborted) {
        status = 'cancelled';
        break;
      }

      if (onIteration && PROGRESS_TYPES.has(event.type)) {
        iteration += 1;
        try { await onIteration({ iteration, ...richEvent(event) }); } catch { /* progress is best-effort */ }
      }

      if (event.type === 'prompt_usage' && budgets) {
        const chars = typeof event.text === 'string' ? event.text.length : 0;
        budgets.record({ responseChars: chars });
        const check = budgets.check();
        if (!check.ok) {
          status = 'budget_exceeded';
          result = { budgetReason: check.reason, limit: check.limit, actual: check.actual };
          break;
        }
      }

      if (event.type === 'done') {
        result = typeof event.result === 'string'
          ? event.result
              .replace(/~~(.*?)~~/g, '$1')
              .replace(/([^\n])\*\*(Getting There|Morning|Afternoon|Evening|Stay|Meals|Day Cost Estimate)\*\*/g, '$1\n**$2**')
          : event.result;
        status = 'completed';
        break;
      }

      if (event.type === 'error') {
        status = 'failed';
        result = { error: event.reason, message: event.message };
        break;
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      status = 'cancelled';
    } else if (err?.name === 'PauseRequested') {
      // Not a failure. The run asked a person something and unwound so the
      // worker lease can be released; the caller persists and returns.
      status = 'paused';
      pausedBatch = err.batch;
      result = null;
    } else if (err?.name === 'TooManyInterruptions') {
      status = 'failed';
      result = { error: 'too_many_interruptions', message: err.message, limit: err.limit, actual: err.actual };
    } else if (err?.name === 'InvalidQuestion') {
      // A question nobody could answer. Failing is the only honest outcome —
      // continuing would mean proceeding past an approval that was never given.
      status = 'failed';
      result = { error: 'invalid_question', message: err.message };
    } else {
      status = 'failed';
      result = { error: 'unexpected', message: String(err?.message ?? err) };
    }
  }

  // Stop the budget clock before the snapshot is taken, not after. Time spent
  // waiting on a person is not time the run spent working, and anything that
  // happens between here and the persist — a slow store write, a retry — would
  // otherwise be charged against `timeoutMs` on resume.
  if (status === 'paused') budgets?.pause?.();

  const history = strat.history().map(o =>
    o.type === 'observation' && o.result?.error ? { ...o, ...o.result } : o,
  );

  const out = {
    status,
    result,
    history,
    traceId: runTraceId,
    budget: budgets?.snapshot() ?? null,
  };

  if (status === 'paused') {
    out.batchId = pausedBatch.batchId;
    out.batch = pausedBatch;
    // The strategy's own view of where it had got to. The caller turns this
    // into a snapshot; history remains the thing it can be rebuilt from.
    out.progress = strat.progress?.() ?? null;
  }

  return out;
}
