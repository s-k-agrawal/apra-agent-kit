// host/human-input/reversal/plan.mjs
//
// When a person says "no, not that", the work already done has to be sorted
// into what can be taken back and what cannot.
//
// The rule that matters: **a tool that declares no `undo` cannot be undone.**
// Silence means no. Guessing a reverse action from a tool's name or its
// arguments is how you delete the wrong row, and every tool written before
// this feature existed is silent.

export const GROUPS = /** @type {const} */ (['read_only', 'mandatory', 'optional', 'not_undoable']);

/**
 * Which group does one completed step fall into?
 *
 * Takes the tool definition as it is *now*, not as it was when the step ran.
 * A tool that has since gained an `undo` can reverse an older step; one that
 * has lost it cannot, and saying so is better than calling a function that is
 * no longer there.
 */
export function classifyStep(entry, tool) {
  // Read-only work leaves nothing to take back. `reversible` defaults to true,
  // so a tool that says nothing is assumed safe to have run — which is the
  // existing registry default and is checked by the clone contract.
  if (!tool || tool.reversible !== false) return 'read_only';

  const undo = tool.undo;
  if (!undo || typeof undo.run !== 'function') return 'not_undoable';

  return undo.mandatory === true ? 'mandatory' : 'optional';
}

const toolNameOf = (entry) => entry.tool ?? entry.step?.tool ?? null;

/**
 * Sort every completed step in a run into the four groups, newest first.
 *
 * Newest first because that is the order a reversal runs in: the last thing
 * done is the first thing taken back. Presenting them in that order too means
 * the list a person reads matches what will actually happen.
 *
 * @param {Array} history      the run's history entries
 * @param {Array} tools        the tool registry
 * @param {object} [opts]
 * @param {number} [opts.since] only consider steps at or after this index
 */
export function planReversal(history = [], tools = [], { since = 0 } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));

  const undone = new Set();
  const completed = [];

  for (const e of history) {
    if (e.type === 'step_completed') completed.push(e);
    // A step already taken back is not taken back twice.
    if (e.type === 'reversal_step' && e.outcome === 'undone') undone.add(e.stepIndex);
  }

  const groups = { read_only: [], mandatory: [], optional: [], not_undoable: [] };

  for (const entry of completed) {
    if ((entry.stepIndex ?? 0) < since) continue;
    if (undone.has(entry.stepIndex)) continue;

    const tool = byName.get(toolNameOf(entry)) ?? null;
    const group = classifyStep(entry, tool);

    groups[group].push({
      stepIndex: entry.stepIndex,
      tool: toolNameOf(entry),
      args: entry.args ?? entry.undo?.args ?? null,
      result: entry.result ?? null,
      group,
    });
  }

  for (const key of GROUPS) groups[key].sort((a, b) => b.stepIndex - a.stepIndex);

  return {
    ...groups,
    // What a reversal would actually do if the person accepted everything on
    // offer. `mandatory` is not a choice — it happens either way.
    get reversible() {
      return [...groups.mandatory, ...groups.optional];
    },
    counts: {
      read_only: groups.read_only.length,
      mandatory: groups.mandatory.length,
      optional: groups.optional.length,
      not_undoable: groups.not_undoable.length,
    },
  };
}

/**
 * Narrow a plan to the steps a person (or the agent) chose, plus everything
 * mandatory.
 *
 * Mandatory steps are added back in whatever the selection says. They are
 * declared by the developer as must-reverse, and a selection UI that let
 * somebody untick one would be offering a choice that does not exist.
 */
export function selectSteps(plan, selectedIndexes = null) {
  const mandatory = plan.mandatory ?? [];
  if (selectedIndexes === null) return [...mandatory].sort((a, b) => b.stepIndex - a.stepIndex);

  const wanted = new Set(selectedIndexes);
  const optional = (plan.optional ?? []).filter(s => wanted.has(s.stepIndex));

  return [...mandatory, ...optional].sort((a, b) => b.stepIndex - a.stepIndex);
}
