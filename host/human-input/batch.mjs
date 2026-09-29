// host/human-input/batch.mjs
//
// A batch is one interruption carrying many questions: a form, not a chat.
//
// The unit matters. `maxInterruptions` counts batches, not questions, because
// what costs a person their attention is being stopped, not being asked. Ten
// fields in one form is one stop; ten forms of one field each is ten.

import { randomUUID } from 'node:crypto';
import { validateQuestion, validateAnswers } from './questions.mjs';

export const ASKED_BY = /** @type {const} */ (['guardrail', 'agent', 'tool']);

export const DEFAULT_STALE_AFTER_MS = 86_400_000;   // 24h — soft: warn on resume
export const DEFAULT_EXPIRES_AFTER_MS = 604_800_000; // 7d  — hard: treated as refused

export function newBatchId() {
  return `inp-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

const iso = (t) => (t instanceof Date ? t : new Date(t ?? Date.now())).toISOString();

/**
 * Build a question batch.
 *
 * Both timeouts are stamped at creation rather than computed on read, so a
 * batch that crosses a process restart — or a store, or a machine — carries
 * its own deadlines with it. A resumer needs no access to the config that
 * produced them.
 */
export function createBatch({
  jobId,
  askedBy,
  askedByDetail = null,
  questions,
  askedAt = new Date(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  expiresAfterMs = DEFAULT_EXPIRES_AFTER_MS,
  batchId = newBatchId(),
} = {}) {
  const at = askedAt instanceof Date ? askedAt : new Date(askedAt);
  return {
    batchId,
    jobId,
    askedBy,
    askedByDetail,
    questions,
    askedAt: at.toISOString(),
    staleAfter: iso(at.getTime() + staleAfterMs),
    expiresAt: iso(at.getTime() + expiresAfterMs),
  };
}

/**
 * Shape-check a batch. Run when it is raised, not when it is answered — an
 * unanswerable form should never reach a person in the first place.
 *
 * @returns {{ok: true} | {ok: false, reason: string, detail?: string}}
 */
export function validateBatch(batch) {
  if (!batch || typeof batch !== 'object') return { ok: false, reason: 'not_an_object' };

  if (typeof batch.batchId !== 'string' || !batch.batchId) return { ok: false, reason: 'batch_id_required' };
  if (typeof batch.jobId !== 'string' || !batch.jobId) return { ok: false, reason: 'job_id_required' };
  if (!ASKED_BY.includes(batch.askedBy)) return { ok: false, reason: 'unknown_asked_by', detail: String(batch.askedBy) };
  if (!Array.isArray(batch.questions) || batch.questions.length === 0) {
    return { ok: false, reason: 'questions_required' };
  }

  const seen = new Set();
  for (const q of batch.questions) {
    const verdict = validateQuestion(q);
    if (!verdict.ok) return verdict;
    if (seen.has(q.fieldId)) return { ok: false, reason: 'duplicate_field_id', detail: q.fieldId };
    seen.add(q.fieldId);
  }

  for (const key of ['askedAt', 'staleAfter', 'expiresAt']) {
    const v = batch[key];
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      return { ok: false, reason: 'invalid_timestamp', detail: key };
    }
  }

  return { ok: true };
}

export function isStale(batch, now = new Date()) {
  return Date.parse(batch.staleAfter) <= (now instanceof Date ? now.getTime() : now);
}

export function isExpired(batch, now = new Date()) {
  return Date.parse(batch.expiresAt) <= (now instanceof Date ? now.getTime() : now);
}

/**
 * Judge a submitted answer against the batch it claims to answer.
 *
 * Atomic: a submission is accepted whole or rejected whole. The caller resumes
 * nothing on a rejection, so there is no state to unwind.
 *
 * `reason` is a stable code for the HTTP layer to map:
 *   batch_mismatch → 409, expired → 410, invalid → 400.
 */
export function validateSubmission(batch, submission, now = new Date()) {
  if (!submission || typeof submission !== 'object') {
    return { ok: false, reason: 'invalid', fields: { _: 'submission_must_be_an_object' } };
  }

  // A stale batchId almost always means the caller is answering a form that has
  // already been superseded — worth its own code so the UI can say so.
  if (submission.batchId !== batch.batchId) {
    return { ok: false, reason: 'batch_mismatch', expected: batch.batchId, received: submission.batchId ?? null };
  }

  if (isExpired(batch, now)) {
    return { ok: false, reason: 'expired', expiresAt: batch.expiresAt };
  }

  const verdict = validateAnswers(batch.questions, submission.answers);
  if (!verdict.ok) return { ok: false, reason: 'invalid', fields: verdict.fields };

  return { ok: true, stale: isStale(batch, now) };
}
