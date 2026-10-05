// host/human-input/reversal/execute.mjs
//
// Taking back what a run already did.
//
// Three decisions here are worth knowing about before reading the code:
//
// 1. **Reverse order.** Last done, first undone. Later steps often depend on
//    earlier ones, so undoing forwards can fail on a dependency that is about
//    to be removed anyway.
//
// 2. **Stop on failure.** After the retries are spent, the reversal stops and
//    reports rather than pressing on. A half-reversed system is worse than
//    either end state, and continuing past a failure makes it harder to work
//    out what state things are actually in.
//
// 3. **Exempt from the task budget.** Refusing to clean up because the meter
//    ran out is the worst available outcome. No budget is consulted here, by
//    design, not by omission.
//
// Selecting the steps *is* the approval. Reversals are not separately gated —
// asking twice for the same decision trains people to stop reading.

export const DEFAULT_RETRIES = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {Array} steps    the selected steps, already in reverse order
 * @param {object} deps
 * @param {Array}   deps.tools
 * @param {Function} [deps.onEntry]  append a history entry (reversal_step)
 * @param {Function} [deps.onFlag]   raise an operator-facing flag
 * @param {number}  [deps.retries]
 * @param {Function} [deps.backoffMs]
 */
export async function executeReversal(steps = [], {
  tools = [],
  fleetApi = null,
  onEntry = null,
  onFlag = null,
  retries = DEFAULT_RETRIES,
  backoffMs = (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  logger = console,
  signal = null,
} = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));

  const undone = [];
  const failed = [];
  const skipped = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Once one reversal has failed, everything after it is left alone and
    // reported as such. Reporting them as "skipped" rather than "failed" is
    // the difference between "we did not try" and "we tried and could not".
    if (failed.length > 0) {
      skipped.push(step);
      continue;
    }

    const tool = byName.get(step.tool);
    const undo = tool?.undo;

    if (typeof undo?.run !== 'function') {
      // Should not happen — `planReversal` puts these in `not_undoable` — but
      // a registry can change between planning and executing.
      failed.push({ ...step, error: { code: 'no_undo', message: 'the tool no longer declares how to undo this' } });
      continue;
    }

    let lastError = null;
    let ok = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) {
        lastError = { code: 'aborted', message: 'cancelled while reversing' };
        break;
      }
      try {
        await undo.run({ result: step.result, args: step.args, fleetApi, signal });
        ok = true;
        break;
      } catch (err) {
        lastError = { code: 'undo_failed', message: String(err?.message ?? err) };
        if (attempt < retries) await sleep(backoffMs(attempt));
      }
    }

    const entry = ok
      ? { stepIndex: step.stepIndex, outcome: 'undone', error: null }
      : { stepIndex: step.stepIndex, outcome: 'failed', error: lastError };

    if (onEntry) {
      try { await onEntry(entry); }
      catch (err) { logger.warn(`[reversal] could not record ${step.stepIndex}: ${err?.message ?? err}`); }
    }

    if (ok) {
      undone.push(step);
    } else {
      failed.push({ ...step, error: lastError });

      // The operator flag is the point of this branch. Logs alone are not
      // enough: nobody is reading them at the moment this happens, and the
      // person in the chat cannot fix it.
      const flag = {
        kind: 'reversal_failed',
        stepIndex: step.stepIndex,
        tool: step.tool,
        error: lastError,
        remaining: steps.length - i - 1,
      };
      logger.error?.(`[reversal] FAILED on step ${step.stepIndex} (${step.tool}): ${lastError?.message}. ${flag.remaining} step(s) left in place — manual intervention required.`);
      if (onFlag) {
        try { await onFlag(flag); }
        catch (err) { logger.warn(`[reversal] could not raise the operator flag: ${err?.message ?? err}`); }
      }
    }
  }

  return {
    undone,
    failed,
    skipped,
    ok: failed.length === 0,
    counts: { undone: undone.length, failed: failed.length, skipped: skipped.length },
  };
}

/**
 * Who decides which optional steps are reversed.
 *
 * `ask` (the default) puts it to the person. `agent` lets the model decide,
 * bounded by four rules — the fourth is the one that matters:
 *
 *   1. it always reports what it did and why;
 *   2. the reasoning is appended to history;
 *   3. it may only choose among steps already declared optional-reversible;
 *   4. **if its decision would reverse everything, it asks anyway.**
 *
 * Rule 4 exists because "undo all of it" is the decision most likely to be
 * wrong and least likely to be recoverable, and it is exactly the decision a
 * model under-informed about the user's intent will reach for.
 */
export function shouldAskAboutOptional(plan, { optionalReversal = 'ask', agentChoice = null } = {}) {
  const optional = plan.optional ?? [];
  if (optional.length === 0) return { ask: false, reason: 'nothing_optional' };
  if (optionalReversal !== 'agent') return { ask: true, reason: 'configured_to_ask' };

  // The agent has not decided yet — it is allowed to.
  if (agentChoice === null) return { ask: false, reason: 'agent_decides' };

  const chosen = new Set(agentChoice);
  const outOfScope = agentChoice.filter(i => !optional.some(s => s.stepIndex === i));
  if (outOfScope.length > 0) {
    return { ask: true, reason: 'choice_out_of_scope', outOfScope };
  }

  if (optional.every(s => chosen.has(s.stepIndex))) {
    return { ask: true, reason: 'would_reverse_everything' };
  }

  return { ask: false, reason: 'agent_chose' };
}
