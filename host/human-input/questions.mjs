// host/human-input/questions.mjs
//
// The five kinds of question a run can ask a person, and the rules for what
// counts as a valid answer to each.
//
// Deliberately knows nothing about jobs, storage, HTTP or the run loop. It
// answers one question: given this field and this value, is the value legal?

export const KINDS = /** @type {const} */ ([
  'approval',          // two fixed outcomes — permission, not a two-item list
  'pick_one',          // exactly one option
  'pick_many',         // zero or more options
  'text',              // free text
  'pick_one_or_text',  // an option, or the person's own words
]);

const KIND_SET = new Set(KINDS);

export const APPROVAL_VALUES = /** @type {const} */ (['approve', 'deny']);

// Approval is not modelled as a two-item pick_one. It carries a distinct
// meaning — permission — and the guardrail has to be able to recognise it as
// such rather than infer it from the option labels.
export function isApproval(question) {
  return question?.kind === 'approval';
}

function fail(reason, detail) {
  return detail ? { ok: false, reason, detail } : { ok: false, reason };
}

const OK = { ok: true };

/**
 * Shape-check a question definition. Catches authoring mistakes at the point
 * a batch is raised rather than when somebody tries to answer it.
 */
export function validateQuestion(question) {
  if (!question || typeof question !== 'object') return fail('not_an_object');

  const { fieldId, kind, prompt, options, allowOther } = question;

  if (typeof fieldId !== 'string' || fieldId.length === 0) return fail('field_id_required');
  if (!KIND_SET.has(kind)) return fail('unknown_kind', kind);
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return fail('prompt_required');

  const needsOptions = kind === 'pick_one' || kind === 'pick_many' || kind === 'pick_one_or_text';

  if (needsOptions) {
    if (!Array.isArray(options) || options.length === 0) return fail('options_required', fieldId);
    const seen = new Set();
    for (const o of options) {
      if (!o || typeof o.value !== 'string' || typeof o.label !== 'string') {
        return fail('option_shape', fieldId);
      }
      if (seen.has(o.value)) return fail('duplicate_option_value', o.value);
      seen.add(o.value);
    }
  } else if (options !== undefined && options !== null) {
    return fail('options_not_allowed', kind);
  }

  // `allowOther` only means something where there are options to be "other" than.
  if (allowOther && kind !== 'pick_one_or_text') return fail('allow_other_not_allowed', kind);

  return OK;
}

function optionValues(question) {
  return new Set((question.options ?? []).map(o => o.value));
}

function isOtherAnswer(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.other === 'string';
}

/**
 * Is `value` a legal answer to `question`?
 *
 * Absence is the caller's concern, not ours — `validateAnswers` decides whether
 * a missing required field is an error. This only judges values that are present.
 */
export function validateAnswer(question, value) {
  switch (question.kind) {
    case 'approval':
      return APPROVAL_VALUES.includes(value) ? OK : fail('expected_approve_or_deny', value);

    case 'pick_one':
      if (typeof value !== 'string') return fail('expected_single_option');
      return optionValues(question).has(value) ? OK : fail('unknown_option', value);

    case 'pick_many': {
      if (!Array.isArray(value)) return fail('expected_array');
      const legal = optionValues(question);
      const seen = new Set();
      for (const v of value) {
        if (typeof v !== 'string') return fail('expected_array_of_strings');
        if (!legal.has(v)) return fail('unknown_option', v);
        if (seen.has(v)) return fail('duplicate_selection', v);
        seen.add(v);
      }
      // An empty array is a real answer — "none of these" — and is distinct
      // from the field being absent. `validateAnswers` handles absence.
      return OK;
    }

    case 'text':
      if (typeof value !== 'string') return fail('expected_text');
      return value.trim().length > 0 ? OK : fail('empty_text');

    case 'pick_one_or_text': {
      if (isOtherAnswer(value)) {
        if (!question.allowOther) return fail('other_not_allowed', question.fieldId);
        return value.other.trim().length > 0 ? OK : fail('empty_other');
      }
      if (typeof value !== 'string') return fail('expected_option_or_other');
      return optionValues(question).has(value) ? OK : fail('unknown_option', value);
    }

    default:
      return fail('unknown_kind', question.kind);
  }
}

/**
 * Validate a whole answer set against a list of questions.
 *
 * Atomic on purpose: a partial or malformed submission is rejected whole and
 * resumes nothing. Half-answering a form and having the run continue on the
 * fields that happened to parse would be worse than a clean rejection.
 *
 * @returns {{ok: true} | {ok: false, fields: Record<string, string>}}
 */
export function validateAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: false, fields: { _: 'answers_must_be_an_object' } };
  }

  const fields = {};
  const known = new Set();

  for (const q of questions) {
    known.add(q.fieldId);
    const present = Object.hasOwn(answers, q.fieldId);

    if (!present) {
      if (q.required !== false) fields[q.fieldId] = 'required';
      continue;
    }

    const verdict = validateAnswer(q, answers[q.fieldId]);
    if (!verdict.ok) {
      fields[q.fieldId] = verdict.detail ? `${verdict.reason}: ${verdict.detail}` : verdict.reason;
    }
  }

  // Unknown keys are rejected rather than ignored. Silently dropping a field
  // the caller believed they were answering is how a UI and a service drift
  // apart without anyone noticing.
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) fields[key] = 'unknown_field';
  }

  return Object.keys(fields).length === 0 ? OK : { ok: false, fields };
}
