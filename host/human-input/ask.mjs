// host/human-input/ask.mjs
//
// `askUser` — how a run asks a person something and stops.
//
// The hard part is not asking. It is *stopping*: the run has to unwind out of
// the strategy generator and the run loop so the worker lease can be released,
// rather than blocking inside it holding a slot while somebody is at lunch.
//
// It unwinds by throwing. A sentinel return value would have to be recognised
// and propagated by every caller in both strategies and the guardrail — one
// missed branch and the run carries on as though it had asked and been
// refused, which executes something nobody declined. A throw is propagated by
// default and has to be swallowed deliberately.
//
// The counterpart is `resumeFrom.answers`: on a resumed run the questions
// already answered are handed back in order, so the strategy reaches the same
// point and gets an answer instead of pausing again.

import { createBatch, validateBatch } from './batch.mjs';
import { validateAnswers } from './questions.mjs';

// Control-flow signals, not failures.
//
// All three are marked with `isHumanInputSignal` so the layers in between —
// which turn every throw into an `{ ok: false }` value — can let them past
// without knowing what any of them mean. Without that marker they degrade into
// ordinary tool errors, and the run carries on: past a question nobody
// answered, or round a loop asking the same unanswerable thing forever.
class HumanInputSignal extends Error {
  constructor(message) {
    super(message);
    this.isHumanInputSignal = true;
  }
}

/** Thrown to unwind a run that is waiting on a person. */
export class PauseRequested extends HumanInputSignal {
  constructor(batch) {
    super(`waiting on input: ${batch.batchId}`);
    this.name = 'PauseRequested';
    this.batch = batch;
  }
}

/** Thrown when a run has interrupted a person too many times. */
export class TooManyInterruptions extends HumanInputSignal {
  constructor(limit, actual) {
    super(`asked ${actual} times; the limit is ${limit}`);
    this.name = 'TooManyInterruptions';
    this.limit = limit;
    this.actual = actual;
  }
}

/** Thrown when a run tries to ask a question that cannot be answered. */
export class InvalidQuestion extends HumanInputSignal {
  constructor(verdict) {
    super(`invalid question batch: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}`);
    this.name = 'InvalidQuestion';
    this.verdict = verdict;
  }
}

export const isPauseRequested = (err) => err?.name === 'PauseRequested';
export const isHumanInputSignal = (err) => err?.isHumanInputSignal === true;

export const DEFAULT_MAX_INTERRUPTIONS = 10;

/**
 * Build the `askUser` a run is given.
 *
 * @param {object} opts
 * @param {string} opts.jobId
 * @param {object} [opts.config]            `humanInput` config
 * @param {Array}  [opts.answered]          `[{ batchId, answers }]` in the order they were asked,
 *                                          rebuilt from history on a resume
 * @param {number} [opts.interruptions]     batches already raised on this run
 * @param {Function} [opts.onQuestion]      called with the batch before the pause is thrown, so the
 *                                          caller can persist it. If it throws, the pause fails —
 *                                          which is correct: an unpersisted question is one nobody
 *                                          will ever see.
 */
export function createAskUser({
  jobId,
  config = {},
  answered = [],
  interruptions = 0,
  onQuestion = null,
} = {}) {
  const maxInterruptions = config.maxInterruptions ?? DEFAULT_MAX_INTERRUPTIONS;
  const staleAfterMs = config.staleAfterMs;
  const expiresAfterMs = config.expiresAfterMs;

  const pending = [...answered];
  let raised = interruptions;

  async function askUser({ askedBy = 'agent', askedByDetail = null, questions = [] } = {}) {
    // A replayed answer is not a new interruption — nobody is being stopped.
    //
    // It is only replayed if it actually *fits* the question being asked.
    // Position alone is not enough: a resumed run is seeded with the
    // observations it already had, so the tool calls that raised earlier
    // questions are not repeated — and a queue replayed blindly would hand
    // the next question the previous one's answer. That once turned an
    // approval into a denial nobody gave.
    //
    // Checking the shape turns a silent wrong answer into a fresh question,
    // which is the safe direction to fail in.
    if (pending.length > 0 && validateAnswers(questions, pending[0].answers).ok) {
      const next = pending.shift();
      return { answered: true, replayed: true, batchId: next.batchId, answers: next.answers };
    }

    const batch = createBatch({
      jobId, askedBy, askedByDetail, questions, staleAfterMs, expiresAfterMs,
    });

    const verdict = validateBatch(batch);
    if (!verdict.ok) throw new InvalidQuestion(verdict);

    raised += 1;
    if (raised > maxInterruptions) {
      throw new TooManyInterruptions(maxInterruptions, raised);
    }

    // Persist before pausing. If this throws the pause fails and the run
    // settles failed — it must never continue as though it had asked and been
    // refused.
    if (onQuestion) await onQuestion(batch);

    throw new PauseRequested(batch);
  }

  return Object.assign(askUser, {
    interruptions: () => raised,
    outstandingAnswers: () => pending.length,
  });
}

/**
 * The answers a resumed run should replay, in the order they were asked.
 * Derived from history, which is the only ordered record of both.
 */
export function answeredBatchesFromHistory(history = []) {
  const out = [];
  for (const e of history) {
    if (e.type === 'answer_received') out.push({ batchId: e.batchId, answers: e.answers });
  }
  return out;
}

/**
 * Convenience for the commonest question there is: may I do this?
 * One field, `proceed`, so every caller reads the answer the same way.
 */
export function approvalQuestion(prompt, { fieldId = 'proceed' } = {}) {
  return { fieldId, kind: 'approval', prompt, required: true };
}

export const isApproved = (answer) => answer?.answers?.proceed === 'approve';
