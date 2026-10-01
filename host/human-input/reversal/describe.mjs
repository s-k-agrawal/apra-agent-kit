// host/human-input/reversal/describe.mjs
//
// Telling a person what can and cannot be taken back, in words they can act on.
//
// The plain-language rule applies here more than anywhere else in the kit.
// This text is read at the moment somebody is deciding whether to undo real
// work, and a list of tool names and step indexes is exactly the kind of thing
// people click past. No identifiers, no tool names, no parameter names.

/**
 * How a tool describes what it did, for someone about to decide whether to
 * undo it.
 *
 * `undo.describe` is the tool's own sentence and wins. Failing that, the
 * `description` is reused. The last resort is deliberately vague rather than
 * leaking the tool's name — an accurate identifier is worse than a vague
 * sentence here, because it tells the reader nothing and tells an onlooker
 * something.
 */
export function describeStep(step, tool) {
  const undo = tool?.undo;

  if (typeof undo?.describe === 'function') {
    try {
      const written = undo.describe({ result: step.result, args: step.args });
      if (typeof written === 'string' && written.trim()) return written.trim();
    } catch {
      // A broken describe must not stop a reversal being offered.
    }
  }

  if (typeof tool?.description === 'string' && tool.description.trim()) {
    return tool.description.trim().replace(/\.$/, '');
  }

  return 'something that cannot be described';
}

const list = (items) => {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
};

/**
 * The plain-language summary of a reversal plan.
 *
 * Structured so a caller can render it as prose or as a form, without either
 * having to re-derive the sentences.
 */
export function describePlan(plan, tools = []) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const describe = (s) => describeStep(s, byName.get(s.tool));

  const mandatory = (plan.mandatory ?? []).map(s => ({ stepIndex: s.stepIndex, text: describe(s) }));
  const optional = (plan.optional ?? []).map(s => ({ stepIndex: s.stepIndex, text: describe(s) }));
  const stuck = (plan.not_undoable ?? []).map(s => ({ stepIndex: s.stepIndex, text: describe(s) }));

  const lines = [];

  if (mandatory.length) {
    lines.push(`I will undo ${list(mandatory.map(s => s.text))}.`);
  }
  if (optional.length) {
    lines.push(`I can also undo ${list(optional.map(s => s.text))} if you want me to.`);
  }
  if (stuck.length) {
    // Stated plainly and without apology. A person who is not told about this
    // will assume "undone" meant everything, and find out later that it did not.
    lines.push(`I cannot undo ${list(stuck.map(s => s.text))} — ${stuck.length === 1 ? 'that has' : 'those have'} already gone through.`);
  }
  if (lines.length === 0) {
    lines.push('There is nothing to undo — nothing I did changed anything.');
  }

  return { summary: lines.join(' '), mandatory, optional, notUndoable: stuck };
}

/**
 * The question asked when optional reversals are the person's call.
 *
 * `pick_many` rather than a string of yes/no questions: it is one
 * interruption, and an empty selection is a real answer meaning "leave it".
 */
export function reversalQuestion(plan, tools = [], { fieldId = 'undo' } = {}) {
  const described = describePlan(plan, tools);
  if (described.optional.length === 0) return null;

  return {
    fieldId,
    kind: 'pick_many',
    prompt: `${described.summary} Which of these should I undo?`,
    options: described.optional.map(s => ({ value: String(s.stepIndex), label: s.text })),
    required: true,
  };
}

/**
 * The report after a reversal has run.
 *
 * A failure is stated first and in the open. This is the case where the people
 * who own the code need to know: a half-reversed system is worse than either
 * end state, and swallowing it leaves somebody to discover it later.
 */
export function describeOutcome(outcome, plan, tools = []) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const text = (s) => describeStep(s, byName.get(s.tool));

  const lines = [];

  if (outcome.failed.length) {
    const first = outcome.failed[0];
    lines.push(`I could not undo ${text(first)}. Someone will need to check it by hand.`);
    if (outcome.skipped.length) {
      lines.push(`I stopped there, so ${list(outcome.skipped.map(text))} ${outcome.skipped.length === 1 ? 'is' : 'are'} still in place.`);
    }
  }

  if (outcome.undone.length) {
    lines.push(`I undid ${list(outcome.undone.map(text))}.`);
  }

  const stuck = plan?.not_undoable ?? [];
  if (stuck.length) {
    lines.push(`${list(stuck.map(text))} ${stuck.length === 1 ? 'was' : 'were'} never reversible.`);
  }

  if (lines.length === 0) lines.push('There was nothing to undo.');

  return lines.join(' ');
}
