// host/human-input/resume.mjs
//
// Turning an answer into a run that can carry on.
//
// Backend agnostic on purpose: the in-process backend and the Azure one both
// call this and differ only in how they store the result and how they wake a
// worker. Everything that decides *whether* an answer is acceptable, and what
// state the run comes back with, lives here so the two cannot drift apart.

import { validateSubmission, isStale } from './batch.mjs';
import { resumeState } from './snapshot.mjs';
import { answeredBatchesFromHistory } from './ask.mjs';

// Refusal codes, and the HTTP status each maps to. Kept together so a new code
// cannot be added without someone deciding what it means over the wire.
export const REFUSALS = {
  not_found: 404,
  not_waiting: 409,
  batch_mismatch: 409,
  already_answered: 409,
  not_your_job: 403,
  validation_failed: 400,
  batch_expired: 410,
};

const refuse = (code, extra = {}) => ({ ok: false, code, status: REFUSALS[code], ...extra });

/**
 * Decide whether an answer is acceptable, and if it is, what the run resumes with.
 *
 * The guard against a second answer is the **status** — a job that has already
 * been answered is no longer `waiting_input`, so the second submission finds
 * the wrong status and is refused. That is why this does not need a
 * compare-and-set, and why `STORE_METHODS` is unchanged.
 *
 * Limitation, stated rather than hidden: read-then-write is not atomic across
 * processes. Two instances answering the same batch in the same millisecond
 * could both pass this check. That cannot happen in the shipped configuration
 * — one chat has one user, and `dispatch.concurrency` defaults to 1 — and the
 * realistic races (a double-click, a client retry) are single-process and are
 * caught here. Running several instances that answer concurrently would need a
 * conditional write modelled on the existing `claim`.
 */
export function planResume(record, submission, {
  history = [],
  identity = null,
  kitVersion = null,
  now = new Date(),
} = {}) {
  if (!record) return refuse('not_found');

  if (record.status !== 'waiting_input') {
    // Distinguish "already dealt with" from "was never waiting". The first is
    // a race a client can retry out of; the second is a bug in the caller.
    const code = hasAnswerFor(history, submission?.batchId) ? 'already_answered' : 'not_waiting';
    return refuse(code, { status: REFUSALS[code], jobStatus: record.status });
  }

  const batch = record.pendingInput;
  if (!batch) return refuse('not_waiting', { jobStatus: record.status });

  // Authorization. A batch id is not a capability: knowing one must not be
  // enough to answer on somebody else's behalf. Trivially satisfied by today's
  // single-user chats — the check exists so that stays true if chats are ever
  // shared.
  const owner = record.snapshot?.identity?.personId ?? null;
  if (owner && identity?.personId && identity.personId !== owner) {
    return refuse('not_your_job');
  }

  const verdict = validateSubmission(batch, submission, now);
  if (!verdict.ok) {
    if (verdict.reason === 'expired') return refuse('batch_expired', { expiresAt: verdict.expiresAt });
    if (verdict.reason === 'batch_mismatch') {
      return refuse('batch_mismatch', { expected: verdict.expected, received: verdict.received });
    }
    return refuse('validation_failed', { fields: verdict.fields });
  }

  const answeredBy = identity?.personId ?? submission.answeredBy ?? null;

  const { source, state, reason } = resumeState(record, history, { kitVersion, now });

  // Only the answer to the batch the run was parked on is replayed.
  //
  // Every *earlier* question has already had its effect folded into the
  // observations being restored — the tool that asked it returned, and that
  // result is in `state.observations`. Those tool calls are therefore not
  // repeated, so their answers would never be asked for again. Leaving them
  // queued means the next question receives the previous one's answer, which
  // is how an approval once came back as a denial nobody gave.
  //
  // *Limitation, stated rather than hidden:* if a snapshot is lost and the
  // rebuild from history cannot reproduce the earlier tool results, the run
  // re-runs those tools and their questions are asked again. That is annoying
  // and it is safe. Replaying a queue positionally to avoid it is neither —
  // it silently answers questions with the wrong answers. `askUser`
  // shape-checks whatever it is handed before consuming it, as a second line.
  const answered = [{ batchId: batch.batchId, answers: submission.answers }];

  return {
    ok: true,
    batch,
    answers: submission.answers,
    answeredBy,
    // Soft, not a refusal: the person is told the world may have moved, and
    // the run is told to say so. Refusing here would throw away work over a
    // threshold that is only advisory.
    stale: verdict.stale ?? isStale(batch, now),
    resumeFrom: {
      observations: state.observations,
      plan: state.plan,
      budget: state.budget,
      interruptions: state.interruptions,
      identity: state.identity,
      answered,
    },
    snapshotSource: source,
    snapshotReason: reason ?? null,
  };
}

function hasAnswerFor(history, batchId) {
  if (!batchId) return false;
  return history.some(e => e.type === 'answer_received' && e.batchId === batchId);
}

/**
 * The state a run resumes with after a batch expired unanswered.
 *
 * An expiry is not an answer. Nothing was approved, so anything gated on the
 * question stays ungated; the run is told the question went unanswered and
 * settles from there.
 */
export function planExpiry(record, history = [], { kitVersion = null, now = new Date() } = {}) {
  if (!record) return refuse('not_found');
  if (record.status !== 'waiting_input') return refuse('not_waiting', { jobStatus: record.status });

  const batch = record.pendingInput;
  if (!batch) return refuse('not_waiting', { jobStatus: record.status });

  const { state } = resumeState(record, history, { kitVersion, now });
  return { ok: true, batch, resumeFrom: { ...state, answered: answeredBatchesFromHistory(history) } };
}
