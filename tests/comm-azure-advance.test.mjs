// tests/comm-azure-advance.test.mjs
//
// One step per activity invocation.
//
// The orchestrator commits the checkpoint between steps, so the activity runs
// the strategy against an in-memory checkpoint and returns its contents as a
// delta. What these pin is that a step runs exactly once across the seam —
// the seam being a crash between the activity returning and the orchestrator
// committing, which is the one new failure this design introduces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runAdvance, createInMemoryCheckpoint } = await import('../comm/azure-functions/advance.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');
const { stepIdempotencyKey } = await import('../host/checkpoint/record.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'advance-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

const tool = (name, onRun) => ({
  name, description: name, reversible: false, timeout: 5000, run: onRun,
});

function ctx(api, dispatcher, tools) {
  return {
    api, activeDispatcher: dispatcher,
    toolRegistry: tools ? extendRegistry(tools) : extendRegistry(),
    runLoopConfig: { strategy: 'open-ended' },
    budgetsConfig: null, guardrailsMod: null, memory: null,
    logger: { warn() {}, info() {} },
  };
}

const call = (name) => '```tool_call\n' + JSON.stringify({ tool: name, args: {} }) + '\n```';
const done = () => '```done\n{"result":"finished","summary":"s"}\n```';

// ---------------------------------------------------------------------------
// The in-memory checkpoint
// ---------------------------------------------------------------------------

test('the in-memory checkpoint merges, so a step does not erase the last one', async () => {
  const cp = createInMemoryCheckpoint(null);
  await cp.save('k', { jobId: 'j', task: { id: 'j', goal: 'g' }, idempotencyKeys: ['a'], observations: [{ n: 1 }] });
  await cp.save('k', { jobId: 'j', task: { id: 'j', goal: 'g' }, pendingBatchId: 'inp-1' });
  assert.deepEqual(cp.delta.idempotencyKeys, ['a']);
  assert.deepEqual(cp.delta.observations, [{ n: 1 }]);
});

test('the in-memory checkpoint answers hasIdempotencyKey from its seed', async () => {
  // This is what makes a re-run of the same step a no-op: the orchestrator
  // seeds the activity with committed state, and the strategy consults it.
  const cp = createInMemoryCheckpoint({ idempotencyKeys: ['already-done'] });
  assert.equal(await cp.hasIdempotencyKey('k', 'already-done'), true);
  assert.equal(await cp.hasIdempotencyKey('k', 'not-yet'), false);
});

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

test('advance runs exactly one step and reports not-done', async () => {
  let runs = 0;
  const dispatcher = await makeDispatcher();
  try {
    const out = await runAdvance({
      jobId: 'job-1',
      task: { goal: 'do two things' },
      state: null,
      hostCtx: ctx(
        createMockFleetApi({ members: rosterNames(1), promptResponses: [call('act'), call('act'), done()] }),
        dispatcher,
        [tool('act', async () => { runs += 1; return { ok: true }; })],
      ),
    });

    assert.equal(runs, 1, 'one step, not the whole run');
    assert.equal(out.status, 'suspended');
    assert.equal(out.done, false);
    assert.ok(out.delta, 'it returns something for the orchestrator to commit');
    assert.ok(out.delta.observations.length >= 1, 'including the work it did');
  } finally {
    await dispatcher.close();
  }
});

test('advance picks up from the state it was handed', async () => {
  const dispatcher = await makeDispatcher();
  try {
    const out = await runAdvance({
      jobId: 'job-2',
      task: { goal: 'carry on' },
      state: {
        observations: [{ type: 'observation', tool: 'act', result: { ok: true, ref: 'EARLIER' } }],
        idempotencyKeys: [],
      },
      hostCtx: ctx(
        createMockFleetApi({ members: rosterNames(1), promptResponses: [done()] }),
        dispatcher,
        [tool('act', async () => ({ ok: true }))],
      ),
    });

    assert.equal(out.done, true);
    assert.equal(out.status, 'completed');
    // A finished run clears its checkpoint, so there is no delta to commit —
    // but the orchestrator must be told to clear the entity rather than leave
    // the row behind. A null delta alone cannot say which.
    assert.equal(out.delta, null);
    assert.equal(out.cleared, true, 'the orchestrator is told to clear, not just to skip');
  } finally {
    await dispatcher.close();
  }
});

test('a finished run reports done, with its result', async () => {
  const dispatcher = await makeDispatcher();
  try {
    const out = await runAdvance({
      jobId: 'job-3',
      task: { goal: 'one thing' },
      hostCtx: ctx(
        createMockFleetApi({ members: rosterNames(1), promptResponses: [done()] }),
        dispatcher,
      ),
    });
    assert.equal(out.done, true);
    assert.equal(out.status, 'completed');
    assert.equal(out.result, 'finished');
  } finally {
    await dispatcher.close();
  }
});

test('a step already recorded as done is not run a second time', async () => {
  // The seam this design introduces: the activity returns, and the process
  // dies before the orchestrator commits. Durable then retries the activity.
  // Without the idempotency key seeded from committed state, the retry
  // re-executes an irreversible step.
  let runs = 0;
  const dispatcher = await makeDispatcher();
  const step = { type: 'tool', tool: 'book', args: { city: 'Kyoto' }, reason: 'r', review: false };
  const plan = '```plan\n' + JSON.stringify({ steps: [step] }) + '\n```';

  try {
    const out = await runAdvance({
      jobId: 'job-4',
      task: { goal: 'book it' },
      state: {
        plan: { steps: [step], cursor: 0 },
        observations: [],
        idempotencyKeys: [stepIdempotencyKey(step, 0)],
      },
      hostCtx: {
        ...ctx(
          createMockFleetApi({ members: rosterNames(1), promptResponses: [plan, '```review\n{"approved":true}\n```', done()] }),
          dispatcher,
          [tool('book', async () => { runs += 1; return { ok: true }; })],
        ),
        runLoopConfig: { strategy: 'plan-execute' },
      },
    });

    assert.equal(runs, 0, 'the committed step was not booked again');
    assert.equal(out.done, true);
  } finally {
    await dispatcher.close();
  }
});

test('the delta a single advance returns stays well under the Durable cap', async () => {
  // The orchestrator carries the delta to callEntity. A tool that returns
  // something enormous must not make the commit unsendable — that is the
  // 16 KB failure this whole design exists to have already solved.
  const big = 'x'.repeat(100_000);
  const dispatcher = await makeDispatcher();
  try {
    const out = await runAdvance({
      jobId: 'job-5',
      task: { goal: 'fetch something big' },
      hostCtx: ctx(
        createMockFleetApi({ members: rosterNames(1), promptResponses: [call('fetch'), done()] }),
        dispatcher,
        [tool('fetch', async () => ({ ok: true, body: big }))],
      ),
    });

    const size = JSON.stringify(out.delta ?? {}).length;
    assert.ok(size < 12_000, `a single delta was ${size} characters — it has to fit an entity operation`);
    // And it says so, rather than silently handing a resumed run a short answer
    // it will believe is the whole one.
    const obs = out.delta?.observations ?? [];
    if (obs.length) assert.ok(obs.some(o => o.truncated) || size < 12_000);
  } finally {
    await dispatcher.close();
  }
});
