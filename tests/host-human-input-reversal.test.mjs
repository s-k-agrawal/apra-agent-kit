// tests/host-human-input-reversal.test.mjs
//
// Taking back what a run already did, when a person says "no, not that".
//
// The rule under test throughout: a tool that declares no `undo` cannot be
// undone. Silence means no. Guessing a reverse action is how you delete the
// wrong row, and every tool written before this feature existed is silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { GROUPS, classifyStep, planReversal, selectSteps } = await import('../host/human-input/reversal/plan.mjs');
const { describeStep, describePlan, reversalQuestion, describeOutcome } = await import('../host/human-input/reversal/describe.mjs');
const { executeReversal, shouldAskAboutOptional, DEFAULT_RETRIES } = await import('../host/human-input/reversal/execute.mjs');
const rec = await import('../host/jobs/record.mjs');

const readTool = { name: 'weather', reversible: true, description: 'look up the weather' };

const mandatoryTool = {
  name: 'charge-card',
  reversible: false,
  description: 'charge the card',
  undo: {
    mandatory: true,
    run: async () => 'refunded',
    describe: () => 'the payment I took',
  },
};

const optionalTool = {
  name: 'save-trip-plan',
  reversible: false,
  description: 'save the trip plan',
  undo: {
    mandatory: false,
    run: async () => 'deleted',
    describe: ({ result }) => `the trip plan I saved${result?.name ? ` for ${result.name}` : ''}`,
  },
};

const silentTool = {
  name: 'send_itinerary_email_v2',
  reversible: false,
  description: 'email the itinerary to the traveller',
};

const TOOLS = [readTool, mandatoryTool, optionalTool, silentTool];

const completed = (stepIndex, tool, result = {}, args = {}) => ({
  ...rec.stepCompletedEntry('job-1', { stepIndex, result, reversible: false }),
  tool,
  args,
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('classify: the four groups are the ones the spec names', () => {
  assert.deepEqual([...GROUPS], ['read_only', 'mandatory', 'optional', 'not_undoable']);
});

test('classify: a tool with no undo cannot be undone - silence means no', () => {
  assert.equal(classifyStep(completed(0, 'send_itinerary_email_v2'), silentTool), 'not_undoable');
});

test('classify: an unknown tool is read_only, not guessed at', () => {
  // A registry can change between the run and the reversal. Inventing a
  // reverse action for a tool we can no longer see is how you delete the
  // wrong row.
  assert.equal(classifyStep(completed(0, 'gone'), null), 'read_only');
});

test('classify: read-only work leaves nothing to take back', () => {
  assert.equal(classifyStep(completed(0, 'weather'), readTool), 'read_only');
  // A tool that says nothing about reversibility is treated as reversible -
  // the registry default the clone contract already pins.
  assert.equal(classifyStep(completed(0, 'x'), { name: 'x' }), 'read_only');
});

test('classify: mandatory and optional are told apart by the flag alone', () => {
  assert.equal(classifyStep(completed(0, 'charge-card'), mandatoryTool), 'mandatory');
  assert.equal(classifyStep(completed(0, 'save-trip-plan'), optionalTool), 'optional');
});

test('classify: an undo without a run function is not an undo', () => {
  const broken = { name: 'b', reversible: false, undo: { mandatory: true, describe: () => 'x' } };
  assert.equal(classifyStep(completed(0, 'b'), broken), 'not_undoable');
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function aRun() {
  return [
    rec.runStartedEntry('job-1', { task: {}, traceId: 't' }),
    completed(0, 'weather', { temp: 15 }),
    completed(1, 'charge-card', { chargeId: 'ch_1' }, { amount: 412 }),
    completed(2, 'save-trip-plan', { name: 'Paris trip' }),
    completed(3, 'send_itinerary_email_v2', { messageId: 'm_1' }),
  ];
}

test('plan: every completed step lands in exactly one group', () => {
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(plan.counts, { read_only: 1, mandatory: 1, optional: 1, not_undoable: 1 });
  assert.equal(plan.mandatory[0].stepIndex, 1);
  assert.equal(plan.optional[0].stepIndex, 2);
  assert.equal(plan.not_undoable[0].stepIndex, 3);
});

test('plan: steps are listed newest first, matching the order they will be undone', () => {
  const history = [
    completed(0, 'save-trip-plan'),
    completed(1, 'save-trip-plan'),
    completed(2, 'save-trip-plan'),
  ];
  const plan = planReversal(history, TOOLS);
  assert.deepEqual(plan.optional.map(s => s.stepIndex), [2, 1, 0]);
});

test('plan: reversible is mandatory plus optional, and nothing else', () => {
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(plan.reversible.map(s => s.stepIndex).sort(), [1, 2]);
});

test('plan: a step already undone is not offered again', () => {
  const history = [
    ...aRun(),
    rec.reversalStepEntry('job-1', { stepIndex: 2, outcome: 'undone' }),
  ];
  const plan = planReversal(history, TOOLS);
  assert.equal(plan.optional.length, 0);
});

test('plan: a step whose reversal failed is still offered - it is still in place', () => {
  const history = [
    ...aRun(),
    rec.reversalStepEntry('job-1', { stepIndex: 2, outcome: 'failed', error: { code: 'upstream_down' } }),
  ];
  const plan = planReversal(history, TOOLS);
  assert.equal(plan.optional.length, 1, 'a failed undo left the thing in place; do not hide it');
});

test('plan: `since` narrows a reversal to the work after a given point', () => {
  const plan = planReversal(aRun(), TOOLS, { since: 2 });
  assert.equal(plan.counts.mandatory, 0, 'step 1 is before the cut');
  assert.equal(plan.counts.optional, 1);
});

test('plan: the step carries what its undo will need', () => {
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(plan.mandatory[0].result, { chargeId: 'ch_1' });
  assert.deepEqual(plan.mandatory[0].args, { amount: 412 });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('select: mandatory steps are included whatever the selection says', () => {
  // They are declared must-reverse by the developer. A UI that let somebody
  // untick one would be offering a choice that does not exist.
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(selectSteps(plan, []).map(s => s.stepIndex), [1]);
  assert.deepEqual(selectSteps(plan, [2]).map(s => s.stepIndex), [2, 1]);
});

test('select: no selection at all still reverses the mandatory steps', () => {
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(selectSteps(plan, null).map(s => s.stepIndex), [1]);
});

test('select: an unknown index is ignored rather than invented', () => {
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(selectSteps(plan, [2, 99]).map(s => s.stepIndex), [2, 1]);
});

test('select: the result is in reverse order, ready to execute', () => {
  const history = [completed(0, 'save-trip-plan'), completed(1, 'save-trip-plan'), completed(2, 'charge-card')];
  const plan = planReversal(history, TOOLS);
  assert.deepEqual(selectSteps(plan, [0, 1]).map(s => s.stepIndex), [2, 1, 0]);
});

// ---------------------------------------------------------------------------
// Describing - the plain-language rule
// ---------------------------------------------------------------------------

test('describe: a tool says how to describe what it did', () => {
  const step = { stepIndex: 2, tool: 'save-trip-plan', result: { name: 'Paris trip' } };
  assert.equal(describeStep(step, optionalTool), 'the trip plan I saved for Paris trip');
});

test('describe: with no describe, the description is reused', () => {
  const step = { stepIndex: 3, tool: 'send_itinerary_email_v2', result: {} };
  assert.equal(describeStep(step, silentTool), 'email the itinerary to the traveller');
});

test('describe: with neither, it is vague rather than naming the tool', () => {
  // An accurate identifier is worse than a vague sentence here: it tells the
  // reader nothing and tells an onlooker something.
  const bare = { name: 'internal_purge_v3', reversible: false };
  const text = describeStep({ stepIndex: 0, tool: 'internal_purge_v3' }, bare);
  assert.equal(text.includes('internal_purge_v3'), false);
});

test('describe: a broken describe does not stop a reversal being offered', () => {
  const broken = { name: 'b', description: 'do a thing', undo: { run: async () => {}, describe: () => { throw new Error('boom'); } } };
  assert.equal(describeStep({ stepIndex: 0, tool: 'b' }, broken), 'do a thing');
});

test('describe: the summary contains no identifier, tool name or parameter name', () => {
  const plan = planReversal(aRun(), TOOLS);
  const { summary } = describePlan(plan, TOOLS);

  for (const leak of ['save-trip-plan', 'charge-card', 'send_itinerary_email_v2', 'stepIndex', 'chargeId', 'messageId', 'amount']) {
    assert.equal(summary.includes(leak), false, `leaked: ${leak}`);
  }
  assert.match(summary, /I will undo the payment I took/);
  assert.match(summary, /I can also undo the trip plan I saved/);
  assert.match(summary, /I cannot undo/);
});

test('describe: what cannot be undone is stated plainly, not buried', () => {
  // Somebody not told about this assumes "undone" meant everything, and finds
  // out later that it did not.
  const plan = planReversal([completed(0, 'send_itinerary_email_v2')], TOOLS);
  const { summary, notUndoable } = describePlan(plan, TOOLS);
  assert.equal(notUndoable.length, 1);
  assert.match(summary, /I cannot undo email the itinerary to the traveller/);
  assert.match(summary, /already gone through/);
});

test('describe: nothing to undo says so', () => {
  const plan = planReversal([completed(0, 'weather')], TOOLS);
  assert.match(describePlan(plan, TOOLS).summary, /nothing to undo/);
});

test('describe: the question is one pick_many, not a string of yes/no questions', () => {
  // One interruption. An empty selection is a real answer meaning "leave it".
  const plan = planReversal(aRun(), TOOLS);
  const q = reversalQuestion(plan, TOOLS);
  assert.equal(q.kind, 'pick_many');
  assert.equal(q.options.length, 1);
  assert.equal(q.options[0].label, 'the trip plan I saved for Paris trip');
  assert.equal(q.options[0].value, '2', 'the value may be opaque; the label may not');
});

test('describe: no optional steps means no question to ask', () => {
  const plan = planReversal([completed(0, 'charge-card')], TOOLS);
  assert.equal(reversalQuestion(plan, TOOLS), null);
});

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

function spyTool(name, { fails = 0, mandatory = false } = {}) {
  let attempts = 0;
  return {
    calls: () => attempts,
    tool: {
      name,
      reversible: false,
      description: `do ${name}`,
      undo: {
        mandatory,
        describe: () => `the ${name}`,
        run: async () => {
          attempts += 1;
          if (attempts <= fails) throw new Error(`${name} undo failed`);
          return 'undone';
        },
      },
    },
  };
}

test('execute: steps are undone last first', async () => {
  const order = [];
  const tool = {
    name: 't', reversible: false,
    undo: { run: async ({ result }) => { order.push(result.i); } },
  };
  const steps = [
    { stepIndex: 2, tool: 't', result: { i: 2 } },
    { stepIndex: 1, tool: 't', result: { i: 1 } },
    { stepIndex: 0, tool: 't', result: { i: 0 } },
  ];

  const out = await executeReversal(steps, { tools: [tool], logger: { warn() {}, error() {} } });
  assert.deepEqual(order, [2, 1, 0], 'later steps often depend on earlier ones');
  assert.equal(out.ok, true);
  assert.equal(out.counts.undone, 3);
});

test('execute: a failure is retried, then succeeds', async () => {
  const spy = spyTool('flaky', { fails: 2 });
  const out = await executeReversal(
    [{ stepIndex: 0, tool: 'flaky', result: {} }],
    { tools: [spy.tool], backoffMs: () => 0, logger: { warn() {}, error() {} } },
  );
  assert.equal(out.ok, true);
  assert.equal(spy.calls(), 3);
});

test('execute: the default is three retries, so four attempts in all', async () => {
  assert.equal(DEFAULT_RETRIES, 3);
  const spy = spyTool('doomed', { fails: 99 });
  await executeReversal(
    [{ stepIndex: 0, tool: 'doomed', result: {} }],
    { tools: [spy.tool], backoffMs: () => 0, logger: { warn() {}, error() {} } },
  );
  assert.equal(spy.calls(), 4);
});

test('execute: after the retries are spent it stops, and says what it left alone', async () => {
  // A half-reversed system is worse than either end state. Pressing on makes
  // it harder to work out what state things are actually in.
  const doomed = spyTool('doomed', { fails: 99 });
  const fine = spyTool('fine');

  const out = await executeReversal([
    { stepIndex: 2, tool: 'doomed', result: {} },
    { stepIndex: 1, tool: 'fine', result: {} },
    { stepIndex: 0, tool: 'fine', result: {} },
  ], { tools: [doomed.tool, fine.tool], backoffMs: () => 0, logger: { warn() {}, error() {} } });

  assert.equal(out.ok, false);
  assert.deepEqual(out.counts, { undone: 0, failed: 1, skipped: 2 });
  assert.equal(fine.calls(), 0, 'nothing after the failure was attempted');
  // "skipped" is the difference between "we did not try" and "we tried and could not".
  assert.deepEqual(out.skipped.map(s => s.stepIndex), [1, 0]);
});

test('execute: a failure raises an operator flag, not just a log line', async () => {
  // Nobody is reading logs at the moment this happens, and the person in the
  // chat cannot fix it.
  const flags = [];
  const errors = [];
  const doomed = spyTool('doomed', { fails: 99 });

  await executeReversal([
    { stepIndex: 1, tool: 'doomed', result: {} },
    { stepIndex: 0, tool: 'doomed', result: {} },
  ], {
    tools: [doomed.tool], backoffMs: () => 0,
    onFlag: (f) => { flags.push(f); },
    logger: { warn() {}, error: (m) => errors.push(m) },
  });

  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'reversal_failed');
  assert.equal(flags[0].stepIndex, 1);
  assert.equal(flags[0].remaining, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /manual intervention required/);
});

test('execute: every attempt is recorded in history', async () => {
  const entries = [];
  const fine = spyTool('fine');
  const doomed = spyTool('doomed', { fails: 99 });

  await executeReversal([
    { stepIndex: 1, tool: 'fine', result: {} },
    { stepIndex: 0, tool: 'doomed', result: {} },
  ], {
    tools: [fine.tool, doomed.tool], backoffMs: () => 0,
    onEntry: (e) => { entries.push(e); },
    logger: { warn() {}, error() {} },
  });

  assert.deepEqual(entries.map(e => [e.stepIndex, e.outcome]), [[1, 'undone'], [0, 'failed']]);
  assert.equal(entries[1].error.code, 'undo_failed');
});

test('execute: a tool that lost its undo between planning and running fails cleanly', async () => {
  const out = await executeReversal(
    [{ stepIndex: 0, tool: 'vanished', result: {} }],
    { tools: [], logger: { warn() {}, error() {} } },
  );
  assert.equal(out.ok, false);
  assert.equal(out.failed[0].error.code, 'no_undo');
});

test('execute: no budget is consulted - cleanup is never refused for cost', async () => {
  // Refusing to clean up because the meter ran out is the worst available
  // outcome. The signature simply has nowhere to pass one.
  const fine = spyTool('fine');
  const out = await executeReversal(
    [{ stepIndex: 0, tool: 'fine', result: {} }],
    { tools: [fine.tool], budgets: { check: () => ({ ok: false, reason: 'max_cost' }) }, logger: { warn() {}, error() {} } },
  );
  assert.equal(out.ok, true, 'an exhausted budget must not stop a reversal');
});

test('execute: nothing to reverse is a clean no-op', async () => {
  const out = await executeReversal([], { tools: TOOLS });
  assert.deepEqual(out.counts, { undone: 0, failed: 0, skipped: 0 });
  assert.equal(out.ok, true);
});

// ---------------------------------------------------------------------------
// Who decides
// ---------------------------------------------------------------------------

test('decide: the default is to ask', async () => {
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(shouldAskAboutOptional(plan), { ask: true, reason: 'configured_to_ask' });
});

test('decide: with nothing optional there is nothing to ask about', () => {
  const plan = planReversal([completed(0, 'charge-card')], TOOLS);
  assert.equal(shouldAskAboutOptional(plan, { optionalReversal: 'ask' }).ask, false);
});

test('decide: agent mode lets the model choose', () => {
  const plan = planReversal(aRun(), TOOLS);
  assert.deepEqual(shouldAskAboutOptional(plan, { optionalReversal: 'agent' }), { ask: false, reason: 'agent_decides' });
});

test('decide: agent mode asks anyway when its choice would reverse everything', () => {
  // "Undo all of it" is the decision most likely to be wrong, least likely to
  // be recoverable, and exactly what an under-informed model reaches for.
  const history = [completed(0, 'save-trip-plan'), completed(1, 'save-trip-plan')];
  const plan = planReversal(history, TOOLS);
  const out = shouldAskAboutOptional(plan, { optionalReversal: 'agent', agentChoice: [0, 1] });
  assert.equal(out.ask, true);
  assert.equal(out.reason, 'would_reverse_everything');
});

test('decide: agent mode proceeds on a partial choice', () => {
  const history = [completed(0, 'save-trip-plan'), completed(1, 'save-trip-plan')];
  const plan = planReversal(history, TOOLS);
  const out = shouldAskAboutOptional(plan, { optionalReversal: 'agent', agentChoice: [1] });
  assert.equal(out.ask, false);
  assert.equal(out.reason, 'agent_chose');
});

test('decide: the agent may only choose among steps already declared optional', () => {
  const plan = planReversal(aRun(), TOOLS);
  const out = shouldAskAboutOptional(plan, { optionalReversal: 'agent', agentChoice: [3] });
  assert.equal(out.ask, true);
  assert.equal(out.reason, 'choice_out_of_scope');
  assert.deepEqual(out.outOfScope, [3]);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('report: a failure is stated first and in the open', async () => {
  const plan = planReversal(aRun(), TOOLS);
  const outcome = {
    undone: [],
    failed: [{ stepIndex: 1, tool: 'charge-card' }],
    skipped: [{ stepIndex: 0, tool: 'save-trip-plan' }],
  };
  const text = describeOutcome(outcome, plan, TOOLS);
  assert.match(text, /^I could not undo the payment I took/);
  assert.match(text, /check it by hand/);
  assert.match(text, /still in place/);
  assert.equal(text.includes('charge-card'), false);
});

test('report: a clean reversal says what it undid and what it never could', () => {
  const plan = planReversal(aRun(), TOOLS);
  const text = describeOutcome(
    { undone: [{ stepIndex: 1, tool: 'charge-card' }], failed: [], skipped: [] },
    plan, TOOLS,
  );
  assert.match(text, /I undid the payment I took/);
  assert.match(text, /never reversible/);
});
