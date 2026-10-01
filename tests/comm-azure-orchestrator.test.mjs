// tests/comm-azure-orchestrator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');

function fakeContext({ instanceId = 'job-1', input }) {
  const statuses = [];
  const mk = (kind, name, inp) => ({ kind, name, input: inp, done: false, result: undefined });
  const df = {
    instanceId,
    getInput: () => input,
    setCustomStatus: (s) => statuses.push(structuredClone(s)),
    callActivity: (name, inp) => mk('activity', name, inp),
    // The orchestrator commits each step's delta before the next one runs.
    callEntity: (id, op, inp) => mk('entity', `${id.name}:${op}`, inp),
    EntityId: function EntityId(name, key) { return { name, key }; },
    currentUtcDateTime: new Date('2026-09-17T10:00:00.000Z'),
  };
  return { df, statuses };
}

const input = {
  task: { id: 'job-1', goal: 'g' }, record: { id: 'job-1' }, callbackUrl: null, metadata: {},
  queuedEvent: { type: 'queued', jobId: 'job-1', at: 't0', position: 1 },
};

test('orchestrator emits queued+started, yields one activity, and settles from the output', () => {
  const ctx = fakeContext({ input });
  const gen = buildOrchestrator()(ctx);
  const step1 = gen.next();

  assert.equal(step1.done, false);
  assert.equal(step1.value.kind, 'activity');
  // One step per activity now — the orchestrator is the run loop.
  assert.equal(step1.value.name, 'advanceTaskActivity');
  assert.equal(step1.value.input.jobId, 'job-1');
  assert.equal(step1.value.input.checkpointKey, 'cp-job-1');

  const published = ctx.statuses.at(-1);
  assert.equal(published.status, 'processing');
  assert.ok(published.startedAt);
  assert.deepEqual(published.events.map(e => e.type), ['queued', 'started']);
  assert.equal(published.events[0].seq, 1);
  assert.equal(published.events[1].seq, 2);

  // The activity reports one step's outcome; `done` ends the loop and
  // `cleared` tells the orchestrator to drop the checkpoint entity.
  const advanced = { status: 'completed', done: true, cleared: true, delta: null, result: 'ok', error: null };
  const step2 = gen.next(advanced);
  assert.equal(step2.done, false, 'the entity is cleared before the run settles');
  assert.equal(step2.value.name, 'checkpoint:clear');

  const step3 = gen.next();
  assert.equal(step3.done, true);
  // A clean output: the loop's own bookkeeping does not travel in it.
  assert.deepEqual(step3.value, { status: 'completed', result: 'ok', error: null });

  const final = ctx.statuses.at(-1);
  assert.equal(final.status, 'completed');
  assert.equal(final.events.at(-1).type, 'settled');
  assert.equal(final.events.at(-1).result, 'ok');
  assert.ok(final.finishedAt);
});

test('failed activity output is recorded correctly', () => {
  const ctx = fakeContext({ input });
  const gen = buildOrchestrator()(ctx);
  gen.next();

  const advanced = { status: 'failed', done: true, cleared: true, delta: null, result: null, error: { code: 'run_failed', message: 'x' } };
  gen.next(advanced);
  const step = gen.next();
  assert.equal(step.done, true);
  assert.deepEqual(ctx.statuses.at(-1).events.map(e => e.type), ['queued', 'started', 'settled']);
  assert.equal(ctx.statuses.at(-1).status, 'failed');
});

test('one activity per step, and no more (no replay fan-out)', () => {
  // The original form of this guard asserted a single yield, which is no
  // longer the architecture: the orchestrator drives the run and yields per
  // step. The property it was protecting is unchanged and is what matters —
  // a replay must not schedule activities the first pass did not.
  //
  // The 125-activity incident came from a loop whose iteration count depended
  // on external event arrival. There are no external events here now.
  const run = () => {
    const ctx = fakeContext({ input });
    const gen = buildOrchestrator()(ctx);
    const seen = [];
    let step = gen.next();
    const script = [
      { status: 'suspended', done: false, delta: { observations: [] } },
      { status: 'completed', done: true, delta: null, cleared: true, result: null },
    ];
    let i = 0;
    while (!step.done) {
      seen.push(`${step.value.kind}:${step.value.name}`);
      step = gen.next(step.value.kind === 'activity' ? script[i++] : undefined);
    }
    return seen;
  };

  const first = run();
  assert.deepEqual(first.filter(x => x.startsWith('activity')).length, 2, 'two steps, two activities');
  assert.deepEqual(run(), first, 'and a replay creates exactly the same tasks');
});
