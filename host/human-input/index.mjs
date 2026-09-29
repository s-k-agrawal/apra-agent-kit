// host/human-input/index.mjs
//
// Durable human input: a run that needs something from a person writes down
// where it had got to, releases its worker and stops. When the answer arrives
// — on any machine, after any restart — a fresh worker rebuilds the run and
// carries on. Completed work is never re-executed.
//
// The pieces, and which file owns what:
//
//   questions.mjs  the five kinds of question, and what counts as an answer
//   batch.mjs      one interruption carrying many questions, and its deadlines
//   ask.mjs        `askUser` — raise a batch, persist it, unwind the run
//   snapshot.mjs   the disposable resume cache, and the rebuild that makes it
//                  disposable
//   resume.mjs     whether an answer is acceptable, and what the run comes
//                  back with — shared by every backend
//   sweep.mjs      the two deadlines, enforced on a schedule
//
// Nothing here knows about HTTP, storage or Azure. The jobs backends supply
// those, which is what keeps the in-process and durable paths from drifting.

export {
  KINDS, APPROVAL_VALUES, isApproval,
  validateQuestion, validateAnswer, validateAnswers,
} from './questions.mjs';

export {
  ASKED_BY, DEFAULT_STALE_AFTER_MS, DEFAULT_EXPIRES_AFTER_MS,
  newBatchId, createBatch, validateBatch, validateSubmission, isStale, isExpired,
} from './batch.mjs';

export {
  PauseRequested, TooManyInterruptions, InvalidQuestion,
  isPauseRequested, isHumanInputSignal,
  createAskUser, answeredBatchesFromHistory, approvalQuestion, isApproved,
  DEFAULT_MAX_INTERRUPTIONS,
} from './ask.mjs';

export {
  SNAPSHOT_VERSION, capture, restore, rebuildFromHistory, resumeState, scrub,
} from './snapshot.mjs';

export { REFUSALS, planResume, planExpiry } from './resume.mjs';

export { createQuestionSweep, DEFAULT_SWEEP_INTERVAL_MS } from './sweep.mjs';
