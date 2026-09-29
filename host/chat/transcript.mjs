// host/chat/transcript.mjs
// Pure transcript state for one chat turn. No DOM, no globals, no imports.
// node:test imports this file as an ES module; the browser receives it inlined
// ahead of app.mjs with the `export` keywords stripped (see host/chat/routes.mjs),
// so every declaration here must be a top-level const/function.

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

export function initialTurn(goal) {
  return { goal, jobId: null, status: 'submitting', position: null, iteration: 0, plan: null, replans: 0, reviews: [], answer: null, error: null, routedTo: null, memoryRecall: null, memoryLearn: null, pendingInput: null, inputError: null, submittingInput: false };
}

export function isLive(turn) {
  return !TERMINAL.has(turn.status) && turn.status !== 'error';
}

export function accepted(turn, { jobId, position = null }) {
  return { ...turn, jobId, status: 'queued', position };
}

export function submitFailed(turn, { message }) {
  return { ...turn, status: 'error', error: { message: String(message ?? 'submit failed') } };
}

export function cancelling(turn) {
  return isLive(turn) ? { ...turn, status: 'cancelling' } : turn;
}

// 'cancelling' is sticky until settled; everything else that is live becomes 'running'.
function liveStatus(turn) {
  return turn.status === 'cancelling' ? 'cancelling' : 'running';
}

// A run parked on a question is still live - it has not finished, and the
// composer must stay disabled - but it is not 'running' either: nothing is
// executing, and telling the user otherwise is a lie they can see through.
export function isWaitingForInput(turn) {
  return turn.status === 'waiting_input' && !!turn.pendingInput;
}

export function inputSubmitting(turn) {
  return { ...turn, submittingInput: true, inputError: null };
}

export function inputRejected(turn, { message, fields = null }) {
  return { ...turn, submittingInput: false, inputError: { message: String(message ?? 'that answer was not accepted'), fields } };
}

function describeStep(step) {
  return step?.description ?? step?.tool ?? step?.type ?? 'step';
}

function planFromEvent(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return {
    steps: steps.map((s, i) => ({
      index: Number.isInteger(s.index) ? s.index : i,
      type: s.type ?? 'step',
      ...(s.tool ? { tool: s.tool } : {}),
      description: describeStep(s),
      status: 'pending',
    })),
  };
}

// Find the checklist row an event refers to. With a stepIndex, match by index and
// append if unknown. Without one (open-ended strategy): step_started appends, while
// completed/failed update the most recent running or retrying row.
function locateStep(steps, event, { create }) {
  const hasIndex = Number.isInteger(event.stepIndex);
  let i = hasIndex ? steps.findIndex(s => s.index === event.stepIndex) : -1;
  if (i < 0 && !hasIndex && !create) {
    for (let k = steps.length - 1; k >= 0; k--) {
      if (steps[k].status === 'running' || steps[k].status === 'retrying') { i = k; break; }
    }
  }
  if (i < 0) {
    steps.push({
      index: hasIndex ? event.stepIndex : steps.length,
      type: event.step?.type ?? 'step',
      ...(event.step?.tool ? { tool: event.step.tool } : {}),
      description: describeStep(event.step),
      status: 'pending',
    });
    i = steps.length - 1;
  }
  return i;
}

function updateStep(turn, event, patch, opts) {
  const steps = (turn.plan?.steps ?? []).map(s => ({ ...s }));
  const i = locateStep(steps, event, opts);
  steps[i] = { ...steps[i], ...patch };
  return { ...turn, plan: { steps } };
}

function reduceProgress(turn, event) {
  const next = { ...turn, status: liveStatus(turn) };
  switch (event.kind) {
    case 'plan':
      return { ...next, plan: planFromEvent(event.plan) };
    case 'replan':
      return { ...next, plan: planFromEvent(event.plan), replans: turn.replans + 1 };
    case 'step_started':
      return updateStep(next, event, { status: 'running' }, { create: true });
    case 'step_completed':
      return updateStep(next, event, { status: 'completed', result: event.result?.result ?? null, error: null }, { create: false });
    case 'step_failed':
      return updateStep(next, event, { status: event.willRetry ? 'retrying' : 'failed', error: event.error ?? 'unknown error' }, { create: false });
    case 'review':
      return { ...next, reviews: [...turn.reviews, { reviewType: event.reviewType ?? 'plan', approved: !!event.approved, feedback: event.feedback ?? null }] };
    case 'routed':
      return { ...next, routedTo: event.routedTo ?? null };
    case 'memory_recall':
      return { ...next, memoryRecall: { count: event.count ?? 0, facts: event.facts ?? [] } };
    case 'memory_learn':
      return { ...next, memoryLearn: { newFacts: event.newFacts ?? [], promotedIds: event.promotedIds ?? [] } };
    default:
      return next;
  }
}

function settledError(event, status) {
  if (event.error && typeof event.error === 'object') {
    return { ...(event.error.code ? { code: event.error.code } : {}), message: event.error.message ?? status };
  }
  return { message: event.error ? String(event.error) : status };
}

export function reduce(turn, event) {
  if (!event || typeof event !== 'object') return turn;
  if (!isLive(turn)) return turn;
  const next = Number.isInteger(event.iteration) ? { ...turn, iteration: event.iteration } : turn;
  switch (event.type) {
    case 'queued':
      return { ...next, status: 'queued', position: event.position ?? null };
    case 'started':
      return { ...next, status: liveStatus(next) };
    case 'progress':
      return reduceProgress(next, event);
    // The run is parked on a question. The form is rendered from this.
    case 'input_required':
      return {
        ...next,
        status: 'waiting_input',
        submittingInput: false,
        inputError: null,
        pendingInput: {
          batchId: event.batchId,
          questions: Array.isArray(event.questions) ? event.questions : [],
          askedBy: event.askedBy ?? null,
          staleAfter: event.staleAfter ?? null,
          expiresAt: event.expiresAt ?? null,
        },
      };
    // Answered, timed out or cancelled - the form comes down either way. The
    // run's own status is reported by the events that follow.
    case 'input_resolved':
      return {
        ...next,
        pendingInput: null,
        submittingInput: false,
        inputError: null,
        status: next.status === 'waiting_input' ? 'running' : next.status,
      };
    case 'settled': {
      const status = TERMINAL.has(event.status) ? event.status : 'failed';
      const routedTo = event.routedTo ?? next.routedTo;
      if (status === 'completed') return { ...next, status, answer: event.result ?? null, error: null, routedTo, pendingInput: null };
      return { ...next, status, answer: null, error: settledError(event, status), routedTo, pendingInput: null };
    }
    default:
      return next;
  }
}
