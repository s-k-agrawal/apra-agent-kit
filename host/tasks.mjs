// host/tasks.mjs
// The one function both the sync /task route and every jobs backend call.
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { classify, executeWorkflow } from './router.mjs';
import { runTask } from './run-loop.mjs';
import { createBudgets } from './budgets.mjs';

export const PROGRESS_TYPES = new Set(['plan', 'action', 'observation', 'review', 'step_review', 'step_started', 'step_failed']);

export function describeEvent(event) {
  switch (event.kind ?? event.type) {
    case 'plan':           return `plan with ${event.plan?.steps?.length ?? 0} steps`;
    case 'replan':         return `revised plan with ${event.plan?.steps?.length ?? 0} steps`;
    case 'step_started':   return `starting step ${event.stepIndex}: ${event.step?.tool ?? event.step?.type ?? 'step'}`;
    case 'step_completed': return `completed step ${event.stepIndex}: ${event.step?.tool ?? event.step?.type ?? 'step'}`;
    case 'step_failed':    return `step ${event.stepIndex} failed: ${event.error ?? 'unknown'}`;
    case 'review':         return `${event.reviewType ?? 'plan'} review ${event.approved ? 'approved' : 'rejected'}`;
    case 'step_review':    return `step review ${event.approved ? 'approved' : 'rejected'}${event.step ? ': ' + event.step : ''}`;
    case 'action':         return `calling ${event.tool}`;
    case 'observation':    return `observed ${event.tool ?? event.stepType ?? 'step'}`;
    default:               return event.kind ?? event.type;
  }
}

function formatPlanSteps(plan) {
  if (!plan?.steps) return [];
  return plan.steps.map((s, i) => ({
    index: i,
    type: s.type,
    ...(s.tool ? { tool: s.tool } : {}),
    description: s.prompt ?? s.tool ?? s.type,
    status: 'pending',
  }));
}

export function richEvent(event, { stepIndex } = {}) {
  switch (event.type) {
    case 'plan':
      return {
        kind: event._replan ? 'replan' : 'plan',
        message: describeEvent(event),
        plan: { steps: formatPlanSteps(event.plan) },
      };
    case 'step_started':
      return {
        kind: 'step_started',
        message: `starting: ${event.step?.tool ?? event.step?.type ?? 'step'}`,
        stepIndex: event.stepIndex ?? stepIndex,
        step: { type: event.step?.type, ...(event.step?.tool ? { tool: event.step.tool } : {}), ...(event.args ? { args: event.args } : {}) },
      };
    case 'observation': {
      const ok = event.ok !== false;
      return {
        kind: ok ? 'step_completed' : 'step_failed',
        message: ok
          ? `completed: ${event.tool ?? event.stepType ?? 'step'}`
          : `failed: ${event.tool ?? event.stepType ?? 'step'}`,
        stepIndex: event.stepIndex ?? stepIndex,
        step: { type: event.stepType, ...(event.tool ? { tool: event.tool } : {}) },
        ...(ok
          ? { result: { ok: true, result: typeof event.result === 'string' ? event.result : (event.text ?? JSON.stringify(event.result ?? null)) } }
          : { error: event.error ?? event.message ?? 'unknown error', willRetry: false }),
      };
    }
    case 'step_failed':
      return {
        kind: 'step_failed',
        message: `failed: ${event.step?.tool ?? 'step'}`,
        stepIndex: event.stepIndex ?? stepIndex,
        step: event.step ?? {},
        error: event.error ?? 'unknown error',
        willRetry: event.willRetry ?? false,
      };
    case 'review':
    case 'step_review':
      return {
        kind: 'review',
        message: describeEvent(event),
        reviewType: event.type === 'step_review' ? 'step' : 'plan',
        approved: event.approved,
        feedback: event.feedback ?? null,
        ...(event.step ? { step: event.step } : {}),
      };
    case 'action':
      return {
        kind: 'step_started',
        message: `calling ${event.tool}`,
        stepIndex: event.stepIndex ?? stepIndex,
        step: { type: 'tool', tool: event.tool, ...(event.args ? { args: event.args } : {}) },
      };
    default:
      return { kind: event.type, message: describeEvent(event) };
  }
}

export function settleWhenAborted(run, signal) {
  if (!signal) return run;
  if (signal.aborted) {
    run.catch(() => {});
    return Promise.resolve({ status: 'cancelled', result: null, history: [], budget: null });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      run.catch(() => {});
      resolve({ status: 'cancelled', result: null, history: [], budget: null });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    run.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export function mergeBudgetConfig(baseConfig, task) {
  const merged = { ...baseConfig };
  const constraints = task.constraints ?? {};
  const budgetOverride = task.budget ?? {};
  const pickStricter = (key, source) => {
    const values = [source[key], merged[key]].filter(v => typeof v === 'number');
    if (values.length) merged[key] = Math.min(...values);
  };
  pickStricter('maxIterations', constraints);
  pickStricter('timeoutMs', constraints);
  pickStricter('maxCostUsd', budgetOverride);
  pickStricter('maxTokens', budgetOverride);
  return merged;
}

export async function executeHostedTask(task, {
  api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig,
  budgetsConfig, guardrailsMod, jobs, signal, onProgress,
  askUser, resumeFrom = null,
}) {
  const fullTask = { id: task.id ?? `t-${Date.now().toString(36)}`, ...task };
  // Accept a caller-supplied trace id so a run can be correlated with the
  // request that started it; generate one only when the caller has none.
  const traceId = task.traceId ?? `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // A resumed run continues its budget rather than starting a fresh one.
  // Without this a run could pause and resume indefinitely and never exhaust
  // anything — the limits would be decorative.
  const budgetsMod = budgetsConfig
    ? createBudgets(mergeBudgetConfig(budgetsConfig, fullTask), resumeFrom?.budget ?? null)
    : null;
  const useRouter = routerConfig?.enabled && !task.strategy;
  let lease;
  try {
    lease = await activeDispatcher.dispatch(useRouter ? { signal, members: ['doer'] } : { signal });
  } catch (err) {
    return {
      taskId: fullTask.id,
      traceId,
      status: 'failed',
      result: { error: 'dispatch_failed', message: String(err?.message ?? err) },
      history: [],
      budget: null,
    };
  }
  try {
    const combined = new AbortController();
    const forwardAbort = (reason) => { if (!combined.signal.aborted) combined.abort(reason); };
    if (signal) {
      if (signal.aborted) combined.abort(signal.reason);
      else signal.addEventListener('abort', () => forwardAbort(signal.reason), { once: true });
    }
    if (lease.signal) {
      if (lease.signal.aborted) combined.abort(lease.signal.reason);
      else lease.signal.addEventListener('abort', () => forwardAbort(lease.signal.reason), { once: true });
    }

    let strategy = task.strategy ?? null;
    let workflowName = null;
    let workflowArgs = null;
    let routedTo = null;

    let routeDebug = null;
    if (!strategy && routerConfig?.enabled) {
      const route = await classify(task.goal ?? task.id, {
        fleetApi: createPooledFleetApi(api, lease),
        registry: toolRegistry,
        fallbackStrategy: routerConfig.fallbackStrategy ?? 'open-ended',
        signal: combined.signal,
      });
      routeDebug = route._debug ?? null;
      if (route.path === 'workflow') {
        workflowName = route.workflow;
        workflowArgs = route.args;
        strategy = 'workflow';
      } else {
        strategy = route.path;
      }
    }

    strategy ??= runLoopConfig.strategy ?? 'open-ended';
    routedTo = workflowName ? `workflow:${workflowName}` : strategy;

    if (onProgress) {
      try { await onProgress({ kind: 'routed', routedTo, ...(routeDebug ? { _debug: routeDebug } : {}) }); } catch { /* best-effort */ }
    }

    if (strategy === 'plan-execute' && lease.upgradeToReviewer && !lease.reviewer) {
      try {
        await lease.upgradeToReviewer();
      } catch (err) {
        return {
          taskId: fullTask.id,
          traceId,
          routedTo,
          status: 'failed',
          result: { error: 'upgrade_failed', message: String(err?.message ?? err) },
          history: [],
          budget: null,
        };
      }
    }

    const workspace = { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer };

    if (strategy === 'workflow') {
      const wfResult = await executeWorkflow(workflowName, workflowArgs, {
        fleetApi: createPooledFleetApi(api, lease),
        toolRegistry,
        signal: combined.signal,
        onProgress,
        workspace,
      });
      return { taskId: fullTask.id, traceId, routedTo, ...wfResult };
    }

    const result = await runTask(fullTask, {
      tools: toolRegistry,
      fleetApi: createPooledFleetApi(api, lease),
      budgets: budgetsMod,
      guardrails: guardrailsMod,
      ...runLoopConfig,
      strategy,
      jobs,
      traceId,
      signal: combined.signal,
      workspace,
      onIteration: onProgress,
      askUser,
      resumeFrom,
    });
    return { taskId: fullTask.id, traceId, routedTo, ...result };
  } finally {
    await lease.release();
  }
}
