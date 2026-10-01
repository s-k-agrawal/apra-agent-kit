// tests/host-budgets-pause.test.mjs
//
// A run that waits on a person is not a run that is working. These tests fix
// that distinction: paused time never counts against `timeoutMs`, and a budget
// restored after a pause continues rather than restarts.
//
// Existing budget behaviour is covered by tests/host-budgets.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createBudgets } = await import('../host/budgets.mjs');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('pause: elapsed stops advancing while paused', async () => {
  const b = createBudgets({});
  await sleep(30);
  b.pause();
  const atPause = b.snapshot().elapsedMs;

  await sleep(60);
  assert.equal(b.snapshot().elapsedMs, atPause, 'a paused clock reads the same however long you wait');
});

test('pause: elapsed continues from where it stopped, not from zero', async () => {
  const b = createBudgets({});
  await sleep(30);
  b.pause();
  const atPause = b.snapshot().elapsedMs;

  await sleep(40);
  b.resume();
  await sleep(30);

  const after = b.snapshot().elapsedMs;
  assert.ok(after >= atPause, 'resuming must not lose the time already spent working');
  assert.ok(after < atPause + 40, `the paused 40ms must not be charged (was ${after}, paused at ${atPause})`);
});

test('pause: timeoutMs does not trip while waiting on a person', async () => {
  // Without this, any question asked near the end of a budget guarantees a
  // timeout on resume - the run is punished for having asked.
  const b = createBudgets({ timeoutMs: 100 });
  await sleep(40);
  b.pause();

  await sleep(150);
  assert.equal(b.check().ok, true, 'still inside the budget - none of that was work');

  b.resume();
  await sleep(80);
  const res = b.check();
  assert.equal(res.ok, false, 'once working again, the clock runs out as normal');
  assert.equal(res.reason, 'timeout');
});

test('pause: paused() reports the state', async () => {
  const b = createBudgets({});
  assert.equal(b.paused(), false);
  b.pause();
  assert.equal(b.paused(), true);
  b.resume();
  assert.equal(b.paused(), false);
});

test('pause: pausing twice does not reset the clock', async () => {
  // A double pause is the realistic bug - two layers both deciding to be safe.
  const b = createBudgets({});
  await sleep(30);
  b.pause();
  const first = b.snapshot().elapsedMs;

  await sleep(30);
  b.pause();
  assert.equal(b.snapshot().elapsedMs, first, 'the second pause banks nothing');
});

test('pause: resuming a running budget is a no-op', async () => {
  const b = createBudgets({});
  await sleep(30);
  const before = b.snapshot().elapsedMs;
  b.resume();
  assert.ok(b.snapshot().elapsedMs >= before, 'a stray resume must not discard elapsed time');
});

test('pause: other limits are unaffected by pausing', () => {
  // Only time is paused. Tokens already spent stay spent.
  const b = createBudgets({ maxIterations: 2 });
  b.record({ inputTokens: 10 });
  b.pause();
  b.record({ inputTokens: 10 });
  assert.equal(b.check().ok, false);
  assert.equal(b.check().reason, 'max_iterations');
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

test('restore: a cold resume continues the budget rather than restarting it', () => {
  // The resumed run is a fresh process. Without this, a run could pause and
  // resume indefinitely and never exhaust anything.
  const before = { iterations: 4, totalInputTokens: 900, totalOutputTokens: 300, elapsedMs: 5000 };
  const b = createBudgets({ maxIterations: 5 }, before);

  const snap = b.snapshot();
  assert.equal(snap.iterations, 4);
  assert.equal(snap.totalInputTokens, 900);
  assert.equal(snap.totalOutputTokens, 300);
  assert.ok(snap.elapsedMs >= 5000, 'restored elapsed time is the floor, not the ceiling');

  assert.equal(b.check().ok, true, 'four of five iterations used');
  b.record({});
  assert.equal(b.check().reason, 'max_iterations');
});

test('restore: a restored budget that was already over its timeout trips at once', () => {
  const b = createBudgets({ timeoutMs: 1000 }, { elapsedMs: 4000 });
  const res = b.check();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'timeout');
  assert.ok(res.actual >= 4000);
});

test('restore: restoring from nothing behaves exactly as before', async () => {
  const b = createBudgets({ maxTokens: 100 }, null);
  assert.equal(b.snapshot().iterations, 0);
  assert.equal(b.snapshot().totalTokens, 0);
  assert.equal(b.check().ok, true);
});

test('restore: a snapshot round-trips through pause, restore and resume', async () => {
  const first = createBudgets({ timeoutMs: 10_000 });
  first.record({ inputTokens: 100, outputTokens: 50 });
  await sleep(30);
  first.pause();
  const carried = first.snapshot();

  // ... days pass, a different process picks the job back up ...
  const second = createBudgets({ timeoutMs: 10_000 }, carried);
  const resumed = second.snapshot();

  assert.equal(resumed.iterations, carried.iterations);
  assert.equal(resumed.totalTokens, carried.totalTokens);
  assert.ok(resumed.elapsedMs >= carried.elapsedMs);
  assert.ok(resumed.elapsedMs < carried.elapsedMs + 1000, 'the days in between are not charged');
});
