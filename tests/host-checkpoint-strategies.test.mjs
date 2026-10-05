// tests/host-checkpoint-strategies.test.mjs
//
// Both strategies write one checkpoint.
//
// plan-execute already checkpointed, through memory's run-state. open-ended
// never did — a crash mid-run lost everything it had done. Same record now,
// same writer, written from both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createOpenEndedStrategy } = await import('../host/strategies/open-ended.mjs');

/** Records what was saved, so a test can read it back without a store. */
function recordingCheckpoint({ saveReturns = true } = {}) {
  const saves = [];
  return {
    saves,
    save: async (key, fields) => { saves.push({ key, fields }); return saveReturns; },
    load: async () => ({ ok: false, reason: 'absent' }),
    clear: async () => {},
    hasIdempotencyKey: async () => false,
    addIdempotencyKey: async () => {},
  };
}

const call = (tool) => '```tool_call\n' + JSON.stringify({ tool, args: {} }) + '\n```';
const done = () => '```done\n{"result":"ok","summary":"s"}\n```';

// Call the tool once, then finish. The discriminator is an observation in the
// history, which only exists after the tool has actually run — `buildActPrompt`
// mentions "result" in its own instructions, so that word is no use here.
const oneToolThenDone = () => createMockFleetApi({
  members: rosterNames(1),
  promptResponses: ({ prompt }) =>
    (String(prompt ?? '').includes('"type": "observation"') ? done() : call('t')),
});

const aTool = () => [{ name: 't', reversible: true, timeout: 5000, run: async () => 'ok' }];

async function drain(strat) {
  const events = [];
  for await (const e of strat.iterate()) events.push(e);
  return events;
}

// ---------------------------------------------------------------------------
// open-ended gains checkpointing
// ---------------------------------------------------------------------------

test('open-ended checkpoints after an observation', async () => {
  // It never did. Only plan-execute had run-state, so a crash mid-run through
  // open-ended lost every step it had taken.
  const checkpoint = recordingCheckpoint();
  const strat = createOpenEndedStrategy({
    task: { id: 'job-1', goal: 'g' },
    tools: aTool(),
    checkpoint,
    agentName: 'kit',
    agentDescription: 'a test agent',
    strategy: 'open-ended',
    fleetApi: oneToolThenDone(),
  });

  await drain(strat);

  assert.ok(checkpoint.saves.length >= 1, 'at least one checkpoint was written');
  const first = checkpoint.saves[0];
  assert.equal(first.key, 'cp-job-1', 'keyed on the task id');
  assert.equal(first.fields.strategy, 'open-ended');
  assert.equal(first.fields.agentName, 'kit');
  assert.equal(first.fields.agentDescription, 'a test agent');
  assert.equal(first.fields.observations.length, 1, 'the observation is in it');
});

test('open-ended survives a checkpoint store that is down', async () => {
  // Losing a checkpoint degrades crash recovery. It must not take down a run
  // that is otherwise fine.
  const checkpoint = recordingCheckpoint({ saveReturns: false });
  const strat = createOpenEndedStrategy({
    task: { id: 'job-1', goal: 'g' },
    tools: aTool(),
    checkpoint,
    fleetApi: oneToolThenDone(),
  });

  const events = await drain(strat);
  assert.ok(events.some(e => e.type === 'done'), 'the run completed despite an unwritable checkpoint');
});

test('open-ended with no checkpoint behaves exactly as before', async () => {
  // The option is additive. A caller that passes nothing gets today's code.
  const strat = createOpenEndedStrategy({
    task: { id: 'job-1', goal: 'g' },
    tools: aTool(),
    fleetApi: oneToolThenDone(),
  });

  const events = await drain(strat);
  assert.ok(events.some(e => e.type === 'done'));
});

test('open-ended carries the recalled facts and conversation it was given', async () => {
  // So a resume reproduces the prompt this run actually had.
  const checkpoint = recordingCheckpoint();
  const strat = createOpenEndedStrategy({
    task: { id: 'job-1', goal: 'g' },
    tools: aTool(),
    checkpoint,
    memories: [{ id: 'mem-1', text: 'prefers trains' }],
    conversation: [{ role: 'user', content: 'earlier turn' }],
    fleetApi: oneToolThenDone(),
  });

  await drain(strat);

  const saved = checkpoint.saves[0].fields;
  assert.deepEqual(saved.recalledFacts, [{ id: 'mem-1', text: 'prefers trains' }]);
  assert.deepEqual(saved.conversation, [{ role: 'user', content: 'earlier turn' }]);
});

test('open-ended does not checkpoint a task with no id', async () => {
  // checkpointKey refuses a task without an id, because two runs of the same
  // goal would share one row. The strategy must not turn that into a crash.
  const checkpoint = recordingCheckpoint();
  const strat = createOpenEndedStrategy({
    task: { goal: 'g' },          // no id
    tools: aTool(),
    checkpoint,
    fleetApi: oneToolThenDone(),
  });

  const events = await drain(strat);
  assert.ok(events.some(e => e.type === 'done'), 'the run still completes');
  assert.deepEqual(checkpoint.saves, [], 'and nothing was written to a shared row');
});

// ---------------------------------------------------------------------------
// plan-execute swaps run-state for the checkpoint
// ---------------------------------------------------------------------------

const { createPlanExecuteStrategy } = await import('../host/strategies/plan-execute.mjs');

const planOf = (steps) => '```plan\n' + JSON.stringify({ steps }) + '\n```';
const approve = () => '```review\n{"approved": true}\n```';

/** Plan one tool step, approve it, then report done. */
// Counts the plans it hands out, so a test can assert "no planning round"
// without guessing which prompt was which — several prompts share headings.
function planExecuteFleet() {
  const counts = { plansIssued: 0 };
  const api = createMockFleetApi({
    members: rosterNames(2),
    promptResponses: ({ prompt }) => {
      const t = String(prompt ?? '');
      if (t.includes('You are the reviewer')) return approve();
      if (t.includes('"type": "observation"')) return done();
      counts.plansIssued += 1;
      return planOf([{ type: 'tool', tool: 't', args: {}, reason: 'do it', review: false }]);
    },
  });
  api.counts = counts;
  return api;
}

test('plan-execute writes the checkpoint, not run-state', async () => {
  const checkpoint = recordingCheckpoint();
  const strat = createPlanExecuteStrategy({
    task: { id: 'job-2', goal: 'g' },
    tools: aTool(),
    checkpoint,
    agentName: 'kit',
    agentDescription: 'a test agent',
    fleetApi: planExecuteFleet(),
  });

  await drain(strat);

  assert.ok(checkpoint.saves.length >= 1, 'a checkpoint was written');
  const saved = checkpoint.saves.at(-1).fields;
  assert.equal(checkpoint.saves[0].key, 'cp-job-2', 'keyed on the task id, not the goal');
  assert.equal(saved.strategy, 'plan-execute');
  assert.equal(saved.agentName, 'kit');
  // The cursor is plan.cursor now, not stepIndex — one name for one fact,
  // shared with the pause path.
  assert.ok(Number.isInteger(saved.plan.cursor), 'the cursor is on the plan');
  assert.ok(Array.isArray(saved.idempotencyKeys) && saved.idempotencyKeys.length >= 1);
});

test('plan-execute resumes from a checkpoint the way run-state did', async () => {
  const checkpoint = recordingCheckpoint();
  checkpoint.load = async () => ({
    ok: true,
    checkpoint: {
      plan: { steps: [{ type: 'tool', tool: 't', args: {}, review: false }], cursor: 1 },
      observations: [{ type: 'observation', stepType: 'tool', tool: 't', result: { ok: true } }],
      idempotencyKeys: ['t-{}-0'],
    },
  });

  const fleetApi = planExecuteFleet();
  const strat = createPlanExecuteStrategy({
    task: { id: 'job-3', goal: 'g' },
    tools: aTool(),
    checkpoint,
    fleetApi,
  });

  const events = await drain(strat);

  // The restored plan is used rather than made again.
  assert.equal(fleetApi.counts.plansIssued, 0, 'no planning round — the checkpoint plan was used');
  assert.ok(events.some(e => e.type === 'done'), 'and the run finishes');

  // Note: a checkpoint-restored plan is NOT announced as a `plan` event —
  // only a resumeFrom-restored one is. That is upstream's existing behaviour
  // and it means a crash-recovery resume renders no plan card in the chat UI.
  // Out of scope here; recorded so it is a known gap rather than a surprise.
});

test('plan-execute with no checkpoint behaves exactly as before', async () => {
  const strat = createPlanExecuteStrategy({
    task: { id: 'job-4', goal: 'g' },
    tools: aTool(),
    fleetApi: planExecuteFleet(),
  });
  const events = await drain(strat);
  assert.ok(events.some(e => e.type === 'done'));
});

test('plan-execute does not checkpoint a task with no id', async () => {
  const checkpoint = recordingCheckpoint();
  const strat = createPlanExecuteStrategy({
    task: { goal: 'g' },          // no id
    tools: aTool(),
    checkpoint,
    fleetApi: planExecuteFleet(),
  });
  await drain(strat);
  assert.deepEqual(checkpoint.saves, [], 'nothing was written to a shared row');
});

// ---------------------------------------------------------------------------
// A resume must not count the same work twice
//
// `resumeContextFor` builds `resumeFrom` from the checkpoint row, and
// plan-execute then loads that same row itself. Both paths feed the same
// observation list, so a resume appended everything the run had already done a
// second time — and the next save persisted the doubled list, so the row grew
// geometrically with the number of pauses.
// ---------------------------------------------------------------------------

test('a resume does not replay the checkpoint observations twice', async () => {
  const obs = { type: 'observation', stepType: 'tool', tool: 'book', result: { ok: true, ref: 'FL-1' } };
  const cp = {
    plan: { steps: [{ type: 'tool', tool: 'book', args: { x: 1 }, reason: 'r', review: false }], cursor: 1 },
    observations: [obs],
    idempotencyKeys: ['book-{"x":1}-0'],
    strategy: 'plan-execute',
  };
  const checkpoint = {
    save: async () => true,
    load: async () => ({ ok: true, checkpoint: cp }),
    clear: async () => {},
    hasIdempotencyKey: async () => true,
    addIdempotencyKey: async () => {},
  };

  const strategy = createPlanExecuteStrategy({
    task: { id: 'job-dup', goal: 'book a flight' },
    tools: [{ name: 'book', description: 'book', reversible: false, timeout: 5000, run: async () => ({ ok: true }) }],
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [done()] }),
    checkpoint,
    // Exactly what the jobs backend hands over: built from the same row.
    resumeFrom: { observations: [obs], plan: cp.plan, budget: null, interruptions: 0, identity: null },
  });
  for await (const _e of strategy.iterate()) { /* drain */ }

  assert.equal(strategy.history().length, 1, 'the observation is present once, not twice');
});

test('a resume with no resumeFrom still restores the checkpoint observations', async () => {
  // The crash-recovery path, where nothing seeds resumeFrom. Skipping the
  // checkpoint load outright would lose the run's whole history.
  const obs = { type: 'observation', stepType: 'tool', tool: 'book', result: { ok: true } };
  const cp = {
    plan: { steps: [{ type: 'tool', tool: 'book', args: { x: 1 }, reason: 'r', review: false }], cursor: 1 },
    observations: [obs], idempotencyKeys: ['book-{"x":1}-0'], strategy: 'plan-execute',
  };
  const strategy = createPlanExecuteStrategy({
    task: { id: 'job-crash', goal: 'book a flight' },
    tools: [{ name: 'book', description: 'book', reversible: false, timeout: 5000, run: async () => ({ ok: true }) }],
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [done()] }),
    checkpoint: { save: async () => true, load: async () => ({ ok: true, checkpoint: cp }),
      clear: async () => {}, hasIdempotencyKey: async () => true, addIdempotencyKey: async () => {} },
    resumeFrom: null,
  });
  for await (const _e of strategy.iterate()) { /* drain */ }
  assert.equal(strategy.history().length, 1, 'restored from the checkpoint');
});

test('a resume keeps the idempotency keys, so completed work is not redone', async () => {
  // The keys live only on the checkpoint — resumeFrom does not carry them — so
  // whatever fixes the doubling must not skip the load that supplies them.
  let ran = 0;
  const cp = {
    plan: { steps: [{ type: 'tool', tool: 'book', args: { x: 1 }, reason: 'r', review: false }], cursor: 0 },
    observations: [{ type: 'observation', stepType: 'tool', tool: 'book', result: { ok: true } }],
    idempotencyKeys: ['book-{"x":1}-0'],
    strategy: 'plan-execute',
  };
  const strategy = createPlanExecuteStrategy({
    task: { id: 'job-idem', goal: 'book a flight' },
    tools: [{ name: 'book', description: 'book', reversible: false, timeout: 5000,
      run: async () => { ran += 1; return { ok: true }; } }],
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [done()] }),
    checkpoint: { save: async () => true, load: async () => ({ ok: true, checkpoint: cp }),
      clear: async () => {}, hasIdempotencyKey: async () => true, addIdempotencyKey: async () => {} },
    resumeFrom: { observations: cp.observations, plan: cp.plan, budget: null, interruptions: 0, identity: null },
  });
  for await (const _e of strategy.iterate()) { /* drain */ }
  assert.equal(ran, 0, 'the already-booked step was not booked again');
});

// ---------------------------------------------------------------------------
// One step at a time
//
// On Azure the orchestrator has to commit the checkpoint between steps, and
// `callEntity` is reachable only from the orchestrator generator. So the
// activity can no longer run a whole task: it advances the run by one step and
// returns, and the orchestrator commits before calling it again.
//
// `maxSteps` is unset on the VM path, where a run still executes end to end in
// one go. See docs/specs/2026-09-30-azure-durable-entity-storage-spec.md §9.1.
// ---------------------------------------------------------------------------

test('plan-execute with maxSteps 1 runs one step and suspends', async () => {
  const ran = [];
  const tools = [
    { name: 'book', description: 'book', reversible: false, timeout: 5000, run: async () => { ran.push('book'); return { ok: true }; } },
    { name: 'email', description: 'email', reversible: true, timeout: 5000, run: async () => { ran.push('email'); return { ok: true }; } },
  ];
  const plan = '```plan\n' + JSON.stringify({
    steps: [
      { type: 'tool', tool: 'book', args: {}, reason: 'r', review: false },
      { type: 'tool', tool: 'email', args: {}, reason: 'r', review: false },
    ],
  }) + '\n```';

  const strategy = createPlanExecuteStrategy({
    task: { id: 'job-one', goal: 'book and email' },
    tools,
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, '```review\n{"approved":true}\n```', done()] }),
    checkpoint: recordingCheckpoint(),
    maxSteps: 1,
  });

  const events = [];
  for await (const e of strategy.iterate()) events.push(e);

  assert.deepEqual(ran, ['book'], 'exactly one step ran');
  assert.equal(events.at(-1).type, 'suspended', 'and it says so rather than finishing');
  assert.equal(events.some(e => e.type === 'done'), false, 'a suspended run is not a done run');
});

test('a suspended run reports where to pick up', async () => {
  // The orchestrator needs the cursor to know the run is not finished; without
  // it a suspend is indistinguishable from a crash.
  const plan = '```plan\n' + JSON.stringify({
    steps: [
      { type: 'tool', tool: 'book', args: {}, reason: 'r', review: false },
      { type: 'tool', tool: 'book', args: { n: 2 }, reason: 'r', review: false },
    ],
  }) + '\n```';
  const strategy = createPlanExecuteStrategy({
    task: { id: 'job-cursor', goal: 'book twice' },
    tools: [{ name: 'book', description: 'book', reversible: false, timeout: 5000, run: async () => ({ ok: true }) }],
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, '```review\n{"approved":true}\n```', done()] }),
    checkpoint: recordingCheckpoint(),
    maxSteps: 1,
  });
  const events = [];
  for await (const e of strategy.iterate()) events.push(e);
  const suspended = events.at(-1);
  assert.equal(suspended.type, 'suspended');
  assert.equal(suspended.cursor, 1, 'the next step to run');
});

test('without maxSteps a run still executes end to end', async () => {
  // The VM path must be untouched by any of this.
  const ran = [];
  const plan = '```plan\n' + JSON.stringify({
    steps: [
      { type: 'tool', tool: 'book', args: {}, reason: 'r', review: false },
      { type: 'tool', tool: 'book', args: { n: 2 }, reason: 'r', review: false },
    ],
  }) + '\n```';
  const strategy = createPlanExecuteStrategy({
    task: { id: 'job-full', goal: 'book twice' },
    tools: [{ name: 'book', description: 'book', reversible: false, timeout: 5000, run: async () => { ran.push('x'); return { ok: true }; } }],
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, '```review\n{"approved":true}\n```', done()] }),
    checkpoint: recordingCheckpoint(),
  });
  const events = [];
  for await (const e of strategy.iterate()) events.push(e);
  assert.equal(ran.length, 2, 'both steps ran');
  assert.equal(events.some(e => e.type === 'suspended'), false);
  assert.equal(events.at(-1).type, 'done');
});

test('open-ended with maxSteps 1 runs one tool and suspends', async () => {
  // Open-ended has no plan, so its "one step" is one LLM turn plus whatever
  // tool that turn chose. Same contract: advance once, hand back control.
  const ran = [];
  const strategy = createOpenEndedStrategy({
    task: { id: 'job-oe', goal: 'do two things' },
    tools: [{ name: 'weather', description: 'w', reversible: true, timeout: 5000, run: async () => { ran.push('x'); return { ok: true }; } }],
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [call('weather'), call('weather'), done()] }),
    checkpoint: recordingCheckpoint(),
    maxSteps: 1,
  });
  const events = [];
  for await (const e of strategy.iterate()) events.push(e);

  assert.equal(ran.length, 1, 'one tool call, not two');
  assert.equal(events.at(-1).type, 'suspended');
  assert.equal(events.some(e => e.type === 'done'), false);
});

test('open-ended without maxSteps still runs to done', async () => {
  const ran = [];
  const strategy = createOpenEndedStrategy({
    task: { id: 'job-oe2', goal: 'do two things' },
    tools: [{ name: 'weather', description: 'w', reversible: true, timeout: 5000, run: async () => { ran.push('x'); return { ok: true }; } }],
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [call('weather'), call('weather'), done()] }),
    checkpoint: recordingCheckpoint(),
  });
  const events = [];
  for await (const e of strategy.iterate()) events.push(e);
  assert.equal(ran.length, 2);
  assert.equal(events.at(-1).type, 'done');
});
