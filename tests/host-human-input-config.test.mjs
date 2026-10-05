// tests/host-human-input-config.test.mjs
//
// Configuration, and the promise that matters most: with the feature off, a
// clone behaves byte-for-byte the way it did before this work existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveHumanInputConfig, HUMAN_INPUT_DEFAULTS } = await import('../host/config.mjs');
const humanInput = await import('../host/human-input/index.mjs');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('config: off by default', () => {
  // A kit that started stopping runs to ask questions the moment it was cloned
  // would be a surprise, and a bad one.
  assert.equal(HUMAN_INPUT_DEFAULTS.enabled, false);
  assert.equal(resolveHumanInputConfig(undefined).enabled, false);
  assert.equal(resolveHumanInputConfig(null).enabled, false);
  assert.equal(resolveHumanInputConfig({}).enabled, false);
});

test('config: the defaults are the ones the spec names', () => {
  const c = resolveHumanInputConfig(null);
  assert.equal(c.maxInterruptions, 10);
  assert.equal(c.staleAfterMs, 86_400_000, '24h');
  assert.equal(c.expiresAfterMs, 604_800_000, '7d');
  assert.equal(c.sweepIntervalMs, 300_000, '5 minutes');
});

test('config: the result is frozen so nothing edits it at run time', () => {
  const c = resolveHumanInputConfig({ enabled: true });
  assert.throws(() => { c.maxInterruptions = 99; }, TypeError);
});

test('config: explicit values win over defaults', () => {
  const c = resolveHumanInputConfig({ enabled: true, maxInterruptions: 3, staleAfterMs: 1000, expiresAfterMs: 2000 });
  assert.equal(c.enabled, true);
  assert.equal(c.maxInterruptions, 3);
  assert.equal(c.expiresAfterMs, 2000);
  assert.equal(c.sweepIntervalMs, HUMAN_INPUT_DEFAULTS.sweepIntervalMs, 'unset keys keep their default');
});

test('config: the environment can switch it on and off', () => {
  assert.equal(resolveHumanInputConfig({ enabled: false }, { env: { HUMAN_INPUT_ENABLED: 'true' } }).enabled, true);
  assert.equal(resolveHumanInputConfig({ enabled: true }, { env: { HUMAN_INPUT_ENABLED: 'false' } }).enabled, false);
  assert.equal(resolveHumanInputConfig({ enabled: true }, { env: { HUMAN_INPUT_ENABLED: '0' } }).enabled, false);
});

// ---------------------------------------------------------------------------
// Refusing nonsense rather than running on it
// ---------------------------------------------------------------------------

test('config: a hard deadline inside the soft one is refused', () => {
  // Every question would be expired before it was ever merely stale, and the
  // warning would never fire.
  assert.throws(
    () => resolveHumanInputConfig({ enabled: true, staleAfterMs: 10_000, expiresAfterMs: 5_000 }),
    /expiresAfterMs .* must be greater than staleAfterMs/,
  );
  assert.throws(
    () => resolveHumanInputConfig({ enabled: true, staleAfterMs: 5_000, expiresAfterMs: 5_000 }),
    /must be greater than/,
  );
});

test('config: maxInterruptions zero is refused - it is a typo for "off"', () => {
  assert.throws(() => resolveHumanInputConfig({ maxInterruptions: 0 }), /positive integer/);
  assert.throws(() => resolveHumanInputConfig({ maxInterruptions: -1 }), /positive integer/);
  assert.throws(() => resolveHumanInputConfig({ maxInterruptions: 2.5 }), /positive integer/);
});

test('config: non-positive durations are refused', () => {
  for (const key of ['staleAfterMs', 'expiresAfterMs', 'sweepIntervalMs']) {
    assert.throws(() => resolveHumanInputConfig({ [key]: 0 }), new RegExp(key), `${key} = 0`);
    assert.throws(() => resolveHumanInputConfig({ [key]: 'soon' }), new RegExp(key), `${key} = string`);
  }
});

// ---------------------------------------------------------------------------
// The module surface
// ---------------------------------------------------------------------------

test('module: the barrel exports what the rest of the host imports', () => {
  for (const name of [
    'KINDS', 'validateAnswers',
    'createBatch', 'validateSubmission', 'isStale', 'isExpired',
    'createAskUser', 'PauseRequested', 'isPauseRequested', 'isHumanInputSignal',
    'createCheckpointRecord', 'validateCheckpoint', 'rebuildFromHistory', 'resumeState',
    'planResume', 'REFUSALS',
    'createQuestionSweep',
  ]) {
    assert.ok(humanInput[name], `missing export: ${name}`);
  }
});

test('module: every refusal code has an HTTP status', () => {
  for (const [code, status] of Object.entries(humanInput.REFUSALS)) {
    assert.equal(typeof status, 'number', code);
    assert.ok(status >= 400 && status < 500, `${code} should be a client error, got ${status}`);
  }
});

// ---------------------------------------------------------------------------
// Off means off
// ---------------------------------------------------------------------------

test('off: a record with the feature unused has both fields null', async () => {
  const { createRecord } = await import('../host/jobs/record.mjs');
  const r = createRecord({ goal: 'go' });
  assert.equal(r.pendingInput, null);
  assert.equal(r.pendingBatchId, null);
});

test('off: the run loop with no askUser returns no pause fields', async () => {
  const { runTask } = await import('../host/run-loop.mjs');
  const { createMockFleetApi } = await import('./helpers/mock-fleet.mjs');

  const out = await runTask({ goal: 'g' }, {
    strategy: 'open-ended',
    tools: [],
    fleetApi: createMockFleetApi({
      members: ['doer'],
      promptResponses: ['```done\n{"result":"ok","summary":"s"}\n```'],
    }),
  });

  assert.equal(out.status, 'completed');
  assert.equal('batchId' in out, false);
  assert.equal('progress' in out, false);
  assert.deepEqual(Object.keys(out).sort(), ['budget', 'history', 'result', 'status', 'traceId']);
});

test('off: a budget with nothing paused behaves as it always did', async () => {
  const { createBudgets } = await import('../host/budgets.mjs');
  const b = createBudgets({ maxIterations: 2 });
  assert.deepEqual(
    Object.keys(b.snapshot()).sort(),
    ['elapsedMs', 'estimatedCostUsd', 'iterations', 'totalInputTokens', 'totalOutputTokens', 'totalTokens'],
  );
  b.record({ inputTokens: 1 });
  assert.equal(b.check().ok, true);
  b.record({ inputTokens: 1 });
  assert.equal(b.check().reason, 'max_iterations');
});
