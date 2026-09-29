// tests/host-human-input-questions.test.mjs
//
// The five question kinds and what counts as an answer to each, plus the
// batch that carries them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  KINDS, APPROVAL_VALUES, isApproval, validateQuestion, validateAnswer, validateAnswers,
} = await import('../host/human-input/questions.mjs');

const {
  newBatchId, createBatch, validateBatch, validateSubmission, isStale, isExpired,
  DEFAULT_STALE_AFTER_MS, DEFAULT_EXPIRES_AFTER_MS,
} = await import('../host/human-input/batch.mjs');

const q = (over = {}) => ({ fieldId: 'f', kind: 'text', prompt: 'Say something', required: true, ...over });

const picker = (kind, over = {}) => q({
  kind,
  options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }],
  ...over,
});

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

test('questions: the five kinds are exactly the ones the spec names', () => {
  assert.deepEqual([...KINDS], ['approval', 'pick_one', 'pick_many', 'text', 'pick_one_or_text']);
});

test('questions: approval is its own kind, not a two-item pick_one', () => {
  // The guardrail has to recognise permission as permission; it cannot infer
  // that from option labels.
  assert.equal(isApproval(q({ kind: 'approval' })), true);
  assert.equal(isApproval(picker('pick_one')), false);
  assert.deepEqual([...APPROVAL_VALUES], ['approve', 'deny']);
});

// ---------------------------------------------------------------------------
// Question shape
// ---------------------------------------------------------------------------

test('questions: a choice kind without options is rejected at authoring time', () => {
  for (const kind of ['pick_one', 'pick_many', 'pick_one_or_text']) {
    const res = validateQuestion(q({ kind }));
    assert.equal(res.ok, false, `${kind} must require options`);
    assert.equal(res.reason, 'options_required');
  }
});

test('questions: approval and text must not carry options', () => {
  for (const kind of ['approval', 'text']) {
    const res = validateQuestion(picker(kind));
    assert.equal(res.ok, false, `${kind} must not accept options`);
    assert.equal(res.reason, 'options_not_allowed');
  }
});

test('questions: duplicate option values are rejected', () => {
  const res = validateQuestion(q({
    kind: 'pick_one',
    options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'Also A' }],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'duplicate_option_value');
});

test('questions: allowOther only means something on pick_one_or_text', () => {
  assert.equal(validateQuestion(picker('pick_one', { allowOther: true })).reason, 'allow_other_not_allowed');
  assert.equal(validateQuestion(picker('pick_one_or_text', { allowOther: true })).ok, true);
});

test('questions: a blank prompt is rejected', () => {
  assert.equal(validateQuestion(q({ prompt: '   ' })).reason, 'prompt_required');
});

// ---------------------------------------------------------------------------
// Per-kind answers
// ---------------------------------------------------------------------------

test('answers: approval takes approve or deny and nothing else', () => {
  const question = q({ kind: 'approval' });
  assert.equal(validateAnswer(question, 'approve').ok, true);
  assert.equal(validateAnswer(question, 'deny').ok, true);
  assert.equal(validateAnswer(question, 'yes').ok, false);
  assert.equal(validateAnswer(question, true).ok, false);
});

test('answers: pick_one takes one known option value', () => {
  const question = picker('pick_one');
  assert.equal(validateAnswer(question, 'a').ok, true);
  assert.equal(validateAnswer(question, 'z').reason, 'unknown_option');
  assert.equal(validateAnswer(question, ['a']).reason, 'expected_single_option');
});

test('answers: pick_many takes an array, and an empty one is a real answer', () => {
  const question = picker('pick_many');
  assert.equal(validateAnswer(question, ['a', 'b']).ok, true);
  // "none of these" is a choice the person made, not a missing field.
  assert.equal(validateAnswer(question, []).ok, true);
  assert.equal(validateAnswer(question, 'a').reason, 'expected_array');
  assert.equal(validateAnswer(question, ['a', 'a']).reason, 'duplicate_selection');
  assert.equal(validateAnswer(question, ['a', 'z']).reason, 'unknown_option');
});

test('answers: pick_many empty is accepted, but pick_many absent is still missing', () => {
  const question = picker('pick_many', { fieldId: 'tags' });
  assert.equal(validateAnswers([question], { tags: [] }).ok, true);
  assert.deepEqual(validateAnswers([question], {}).fields, { tags: 'required' });
});

test('answers: text must be non-empty', () => {
  const question = q({ kind: 'text' });
  assert.equal(validateAnswer(question, 'a real answer').ok, true);
  assert.equal(validateAnswer(question, '   ').reason, 'empty_text');
  assert.equal(validateAnswer(question, 42).reason, 'expected_text');
});

test('answers: pick_one_or_text accepts an option, or Other when Other is offered', () => {
  const offered = picker('pick_one_or_text', { allowOther: true, otherPrompt: 'Something else' });
  assert.equal(validateAnswer(offered, 'a').ok, true);
  assert.equal(validateAnswer(offered, { other: 'Late September' }).ok, true);
  assert.equal(validateAnswer(offered, { other: '  ' }).reason, 'empty_other');
  assert.equal(validateAnswer(offered, 'z').reason, 'unknown_option');
});

test('answers: pick_one_or_text refuses Other when Other was not offered', () => {
  const closed = picker('pick_one_or_text', { allowOther: false });
  assert.equal(validateAnswer(closed, 'a').ok, true);
  assert.equal(validateAnswer(closed, { other: 'anything' }).reason, 'other_not_allowed');
});

// ---------------------------------------------------------------------------
// Whole-set validation
// ---------------------------------------------------------------------------

test('answers: a missing required field fails, an optional one does not', () => {
  const questions = [q({ fieldId: 'need' }), q({ fieldId: 'nice', required: false })];
  assert.deepEqual(validateAnswers(questions, {}).fields, { need: 'required' });
  assert.equal(validateAnswers(questions, { need: 'here' }).ok, true);
});

test('answers: an unknown key is rejected rather than ignored', () => {
  // Silently dropping a field the caller believed they answered is how a UI
  // and a service drift apart unnoticed.
  const res = validateAnswers([q({ fieldId: 'known' })], { known: 'x', surprise: 'y' });
  assert.equal(res.ok, false);
  assert.equal(res.fields.surprise, 'unknown_field');
});

test('answers: validation is atomic - one bad field fails the whole set', () => {
  const questions = [
    q({ fieldId: 'ok1' }),
    picker('pick_one', { fieldId: 'bad' }),
    q({ fieldId: 'ok2' }),
  ];
  const res = validateAnswers(questions, { ok1: 'fine', bad: 'nope', ok2: 'fine' });
  assert.equal(res.ok, false);
  assert.equal(res.fields.bad.startsWith('unknown_option'), true);
  // The good fields are reported clean, but the set as a whole does not pass -
  // so nothing resumes partially.
  assert.equal(Object.keys(res.fields).length, 1);
});

test('answers: a non-object submission is rejected outright', () => {
  assert.equal(validateAnswers([q()], null).ok, false);
  assert.equal(validateAnswers([q()], ['a']).ok, false);
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

test('batch: ids are prefixed and unique', () => {
  const a = newBatchId();
  assert.match(a, /^inp-[0-9a-f]{12}$/);
  assert.notEqual(a, newBatchId());
});

test('batch: both deadlines are stamped at creation, not computed on read', () => {
  // A batch that crosses a restart, a store or a machine carries its own
  // deadlines; a resumer needs no access to the config that produced them.
  const askedAt = new Date('2026-09-24T09:14:22.104Z');
  const batch = createBatch({ jobId: 'job-1', askedBy: 'agent', questions: [q()], askedAt });
  assert.equal(batch.askedAt, askedAt.toISOString());
  assert.equal(Date.parse(batch.staleAfter) - askedAt.getTime(), DEFAULT_STALE_AFTER_MS);
  assert.equal(Date.parse(batch.expiresAt) - askedAt.getTime(), DEFAULT_EXPIRES_AFTER_MS);
  assert.equal(validateBatch(batch).ok, true);
});

test('batch: a duplicate fieldId is rejected - the answer key would be ambiguous', () => {
  const batch = createBatch({
    jobId: 'job-1', askedBy: 'agent',
    questions: [q({ fieldId: 'same' }), q({ fieldId: 'same' })],
  });
  assert.equal(validateBatch(batch).reason, 'duplicate_field_id');
});

test('batch: askedBy must be one of the three askers', () => {
  const batch = createBatch({ jobId: 'job-1', askedBy: 'somebody', questions: [q()] });
  assert.equal(validateBatch(batch).reason, 'unknown_asked_by');
});

test('batch: an empty question list is rejected', () => {
  const batch = createBatch({ jobId: 'job-1', askedBy: 'tool', questions: [] });
  assert.equal(validateBatch(batch).reason, 'questions_required');
});

test('batch: staleness is soft and expiry is hard, and they are independent', () => {
  const askedAt = new Date('2026-09-24T00:00:00.000Z');
  const batch = createBatch({ jobId: 'job-1', askedBy: 'agent', questions: [q()], askedAt });

  const nextHour = new Date('2026-09-24T01:00:00.000Z');
  assert.equal(isStale(batch, nextHour), false);
  assert.equal(isExpired(batch, nextHour), false);

  const twoDaysLater = new Date('2026-09-26T00:00:00.000Z');
  assert.equal(isStale(batch, twoDaysLater), true);
  assert.equal(isExpired(batch, twoDaysLater), false, 'stale must not imply expired');

  const eightDaysLater = new Date('2026-10-02T00:00:00.000Z');
  assert.equal(isExpired(batch, eightDaysLater), true);
});

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

const submissionBatch = () => createBatch({
  jobId: 'job-1',
  askedBy: 'guardrail',
  questions: [q({ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?' })],
  askedAt: new Date('2026-09-24T00:00:00.000Z'),
});

test('submission: a good answer passes and reports staleness separately', () => {
  const batch = submissionBatch();
  const res = validateSubmission(
    batch,
    { batchId: batch.batchId, answers: { proceed: 'approve' } },
    new Date('2026-09-24T01:00:00.000Z'),
  );
  assert.deepEqual(res, { ok: true, stale: false });
});

test('submission: answering past staleAfter still succeeds - soft means soft', () => {
  const batch = submissionBatch();
  const res = validateSubmission(
    batch,
    { batchId: batch.batchId, answers: { proceed: 'approve' } },
    new Date('2026-09-26T00:00:00.000Z'),
  );
  assert.equal(res.ok, true);
  assert.equal(res.stale, true, 'the caller is told, but not refused');
});

test('submission: answering the wrong batch is a mismatch, not a validation error', () => {
  const batch = submissionBatch();
  const res = validateSubmission(batch, { batchId: 'inp-000000000000', answers: { proceed: 'approve' } });
  assert.equal(res.reason, 'batch_mismatch');
  assert.equal(res.expected, batch.batchId);
});

test('submission: answering past expiresAt is refused with its own code', () => {
  const batch = submissionBatch();
  const res = validateSubmission(
    batch,
    { batchId: batch.batchId, answers: { proceed: 'approve' } },
    new Date('2026-10-02T00:00:00.000Z'),
  );
  assert.equal(res.reason, 'expired');
  assert.equal(res.expiresAt, batch.expiresAt);
});

test('submission: expiry is checked before field validation', () => {
  // An expired batch is gone whatever the answer says; reporting field errors
  // on it would invite the caller to "fix" the answer and retry forever.
  const batch = submissionBatch();
  const res = validateSubmission(
    batch,
    { batchId: batch.batchId, answers: { proceed: 'nonsense' } },
    new Date('2026-10-02T00:00:00.000Z'),
  );
  assert.equal(res.reason, 'expired');
});

test('submission: a bad field is reported per-field for the caller to correct', () => {
  const batch = submissionBatch();
  const res = validateSubmission(
    batch,
    { batchId: batch.batchId, answers: { proceed: 'maybe' } },
    new Date('2026-09-24T01:00:00.000Z'),
  );
  assert.equal(res.reason, 'invalid');
  assert.equal(res.fields.proceed.startsWith('expected_approve_or_deny'), true);
});
