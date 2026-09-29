// host/jobs/record.mjs
import { randomUUID } from 'node:crypto';
import { IllegalTransitionError } from './interface.mjs';

export const STATUSES = ['queued', 'processing', 'waiting_input', 'completed', 'failed', 'cancelled', 'budget_exceeded'];

// `waiting_input` is deliberately NOT terminal. Every terminal check in the
// notifier, the SSE handler and the store purge keeps working untouched, and a
// paused run stays visibly unfinished — which is what it is.
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

const TRANSITIONS = {
  queued: new Set(['processing', 'cancelled']),
  // A new Set, not TERMINAL_STATUSES itself — adding `waiting_input` to the
  // shared Set would quietly make a paused run look terminal everywhere.
  processing: new Set([...TERMINAL_STATUSES, 'waiting_input']),
  // An answered run goes back to `queued`, not straight to `processing`:
  // there is no worker holding it any more, and `store.claim()` — the existing
  // conditional write that stops two workers taking the same job — only claims
  // a `queued` row. Going via the queue reuses that unchanged, which is what
  // lets the whole feature land without a new store method.
  //
  // `processing` stays legal for a backend that resumes without a queue (the
  // durable one starts a fresh orchestration instead). `failed` is reachable
  // directly because the expiry sweep settles an unanswered batch without a
  // worker ever picking the job back up.
  waiting_input: new Set(['queued', 'processing', 'cancelled', 'failed']),
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function newJobId() {
  return `job-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

export function createRecord(task, { id = newJobId(), callbackUrl = null, metadata = {}, now = new Date() } = {}) {
  return {
    id,
    status: 'queued',
    task: {
      goal: task.goal,
      inputs: task.inputs ?? {},
      constraints: task.constraints ?? {},
      budget: task.budget ?? {},
    },
    submittedAt: iso(now),
    startedAt: null,
    finishedAt: null,
    attempts: 1,
    result: null,
    history: [],
    budget: null,
    progress: { iteration: 0, message: null, at: null },
    callbackUrl,
    metadata: metadata ?? {},
    error: null,
    // Human input. Both null on every run that never asks anything, so a
    // record with `humanInput` disabled is byte-for-byte what it was before
    // apart from these two nulls.
    pendingInput: null,   // the unanswered batch, or null
    snapshot: null,       // disposable resume cache; history remains the truth
  };
}

export const queuedEvent = (jobId, position, now = new Date()) =>
  ({ type: 'queued', jobId, at: iso(now), position });
export const startedEvent = (jobId, now = new Date()) =>
  ({ type: 'started', jobId, at: iso(now) });
export const progressEvent = (jobId, iteration, detail, now = new Date()) => {
  if (typeof detail === 'string') {
    return { type: 'progress', jobId, at: iso(now), iteration, message: detail };
  }
  return { type: 'progress', jobId, at: iso(now), iteration, ...detail };
};
export const settledEvent = (jobId, { status, result = null, error = null }, now = new Date()) =>
  ({ type: 'settled', jobId, at: iso(now), status, result, error });

// --- human input notifications -------------------------------------------
// These ride the existing notifier, so SSE and webhook both carry them with no
// transport change. They are a *view* for a waiting client, not history — the
// record of what was asked lives in the history entries below.
export const inputRequiredEvent = (jobId, batch, now = new Date()) => ({
  type: 'input_required',
  jobId,
  at: iso(now),
  batchId: batch.batchId,
  questions: batch.questions,
  askedBy: batch.askedBy,
  staleAfter: batch.staleAfter,
  expiresAt: batch.expiresAt,
});

export const INPUT_RESOLUTIONS = ['answered', 'timeout', 'cancelled'];

export const inputResolvedEvent = (jobId, { batchId, resolution }, now = new Date()) =>
  ({ type: 'input_resolved', jobId, at: iso(now), batchId, resolution });

// --- history entries ------------------------------------------------------
//
// Append-only, ordered, never edited, and never ring-buffered: `ringEvents()`
// above exists for the size-capped Azure `customStatus` view and must not be
// applied to stored history. These entries are what a cold resume is rebuilt
// from when the snapshot is missing, so dropping one loses real state.
//
// `seq` is assigned by the store on append, not here.

export const HISTORY_TYPES = [
  'run_started', 'planned',
  'step_started', 'step_completed', 'step_failed',
  'question_asked', 'answer_received', 'question_expired',
  'reversal_planned', 'reversal_step', 'reversal_finished',
  'run_settled',
];

const entry = (type, jobId, payload, now) => ({ type, jobId, at: iso(now), ...payload });

export const runStartedEntry = (jobId, { task, traceId }, now = new Date()) =>
  entry('run_started', jobId, { task, traceId }, now);

// `replanOf` names the batch whose answer caused the revision, so a plan change
// is always traceable to the question that prompted it.
export const plannedEntry = (jobId, { plan, replanOf = null }, now = new Date()) =>
  entry('planned', jobId, { plan, replanOf }, now);

export const stepStartedEntry = (jobId, { stepIndex, stepType, tool = null, args = null }, now = new Date()) =>
  entry('step_started', jobId, { stepIndex, stepType, tool, args }, now);

// `undo` is captured here, at execution time, rather than reconstructed during
// a reversal: the arguments needed to reverse a step are often derivable only
// from its result, which is gone by then.
export const stepCompletedEntry = (jobId, { stepIndex, result, reversible, undo = null }, now = new Date()) =>
  entry('step_completed', jobId, { stepIndex, result, reversible, undo }, now);

export const stepFailedEntry = (jobId, { stepIndex, error }, now = new Date()) =>
  entry('step_failed', jobId, { stepIndex, error }, now);

// The batch is stored whole. A question rendered to a person and then lost is
// an audit gap: nobody can later say what they were actually agreeing to.
export const questionAskedEntry = (jobId, { batch }, now = new Date()) =>
  entry('question_asked', jobId, { batch }, now);

export const answerReceivedEntry = (jobId, { batchId, answers, answeredBy }, now = new Date()) =>
  entry('answer_received', jobId, { batchId, answers, answeredBy }, now);

export const questionExpiredEntry = (jobId, { batchId }, now = new Date()) =>
  entry('question_expired', jobId, { batchId }, now);

export const reversalPlannedEntry = (jobId, { batchId, steps, undoable, notUndoable }, now = new Date()) =>
  entry('reversal_planned', jobId, { batchId, steps, undoable, notUndoable }, now);

export const reversalStepEntry = (jobId, { stepIndex, outcome, error = null }, now = new Date()) =>
  entry('reversal_step', jobId, { stepIndex, outcome, error }, now);

export const reversalFinishedEntry = (jobId, { undone, failed, skipped }, now = new Date()) =>
  entry('reversal_finished', jobId, { undone, failed, skipped }, now);

export const runSettledEntry = (jobId, { status, result = null, error = null }, now = new Date()) =>
  entry('run_settled', jobId, { status, result, error }, now);

// Keep the newest `max` events, but never drop queued/started/settled.
export function ringEvents(events, max = 50) {
  if (events.length <= max) return events;
  const keep = events.filter(e => e.type !== 'progress');
  const budget = Math.max(0, max - keep.length);
  const progress = events.filter(e => e.type === 'progress').slice(-budget);
  return events.filter(e => e.type !== 'progress' || progress.includes(e));
}

// Run loop → { status, result, error }. The run loop puts failure details in
// `result`; the job record wants them in `error`.
export function settleFromRunResult(run) {
  const base = { history: run.history ?? [], budget: run.budget ?? null };
  if (run.status === 'failed') {
    const code = run.result?.error === 'dispatch_failed' ? 'dispatch_failed' : 'run_failed';
    const message = run.result?.error
      ? `${run.result.error}: ${run.result.message ?? ''}`.trim().replace(/:$/, '')
      : 'run loop failed';
    return { status: 'failed', result: null, error: { code, message }, ...base };
  }
  return { status: run.status, result: run.result ?? null, error: null, ...base };
}
