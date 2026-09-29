// tests/host-chat-transcript.test.mjs
// Drives the reducer with the exact payloads the SSE stream carries: record.mjs
// event builders wrapped around tasks.mjs richEvent output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richEvent } from '../host/tasks.mjs';
import { queuedEvent, startedEvent, progressEvent, settledEvent } from '../host/jobs/record.mjs';

const { initialTurn, accepted, submitFailed, cancelling, reduce, isLive } = await import('../host/chat/transcript.mjs');

const JOB = 'job-1';
const prog = (raw, iteration = 1) => progressEvent(JOB, iteration, richEvent(raw));
const play = (turn, events) => events.reduce(reduce, turn);
const started = () => play(accepted(initialTurn('weather?'), { jobId: JOB, position: 1 }), [queuedEvent(JOB, 1), startedEvent(JOB)]);

const PLAN = { type: 'plan', _replan: false, plan: { steps: [
  { type: 'tool', tool: 'weather', args: { city: 'London' } },
  { type: 'reason', prompt: 'Compose briefing' },
] } };

test('initialTurn, accepted, queued, started', () => {
  const t0 = initialTurn('weather?');
  assert.deepEqual(t0, { goal: 'weather?', jobId: null, status: 'submitting', position: null, iteration: 0, plan: null, replans: 0, reviews: [], answer: null, error: null, routedTo: null, pendingInput: null, inputError: null, submittingInput: false });
  assert.equal(isLive(t0), true);
  const t1 = accepted(t0, { jobId: JOB, position: 2 });
  assert.equal(t1.status, 'queued'); assert.equal(t1.jobId, JOB); assert.equal(t1.position, 2);
  const t2 = reduce(t1, queuedEvent(JOB, 3));
  assert.equal(t2.position, 3);
  const t3 = reduce(t2, startedEvent(JOB));
  assert.equal(t3.status, 'running');
});

test('plan → steps tick → review → settled completed', () => {
  let t = reduce(started(), prog(PLAN, 1));
  assert.equal(t.iteration, 1);
  assert.deepEqual(t.plan.steps, [
    { index: 0, type: 'tool', tool: 'weather', description: 'weather', status: 'pending' },
    { index: 1, type: 'reason', description: 'Compose briefing', status: 'pending' },
  ]);
  t = reduce(t, prog({ type: 'review', approved: true, feedback: null }, 2));
  assert.deepEqual(t.reviews, [{ reviewType: 'plan', approved: true, feedback: null }]);
  t = reduce(t, prog({ type: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' }, args: { city: 'London' } }, 3));
  assert.equal(t.plan.steps[0].status, 'running');
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'weather', stepIndex: 0, ok: true, result: '15°C cloudy' }, 4));
  assert.equal(t.plan.steps[0].status, 'completed');
  assert.equal(t.plan.steps[0].result, '15°C cloudy');
  t = reduce(t, prog({ type: 'step_started', stepIndex: 1, step: { type: 'reason' } }, 5));
  t = reduce(t, prog({ type: 'observation', stepType: 'reason', stepIndex: 1, ok: true, text: 'briefing' }, 6));
  assert.equal(t.plan.steps[1].status, 'completed');
  assert.equal(t.plan.steps[1].result, 'briefing');
  t = reduce(t, settledEvent(JOB, { status: 'completed', result: 'London is 15°C' }));
  assert.equal(t.status, 'completed'); assert.equal(t.answer, 'London is 15°C'); assert.equal(t.error, null);
  assert.equal(isLive(t), false);
});

test('step failure with retry, then success', () => {
  let t = reduce(started(), prog(PLAN, 1));
  t = reduce(t, prog({ type: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' } }, 2));
  t = reduce(t, prog({ type: 'step_failed', stepIndex: 0, step: { type: 'tool', tool: 'weather' }, error: 'timeout', willRetry: true }, 3));
  assert.equal(t.plan.steps[0].status, 'retrying'); assert.equal(t.plan.steps[0].error, 'timeout');
  t = reduce(t, prog({ type: 'step_started', stepIndex: 0, step: { type: 'tool', tool: 'weather' } }, 4));
  assert.equal(t.plan.steps[0].status, 'running');
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'weather', stepIndex: 0, ok: true, result: 'ok' }, 5));
  assert.equal(t.plan.steps[0].status, 'completed'); assert.equal(t.plan.steps[0].error, null);
  t = reduce(t, prog({ type: 'step_failed', stepIndex: 1, step: { type: 'reason' }, error: 'boom', willRetry: false }, 6));
  assert.equal(t.plan.steps[1].status, 'failed');
});

test('replan replaces the checklist and counts', () => {
  let t = reduce(started(), prog(PLAN, 1));
  t = reduce(t, prog({ type: 'review', approved: false, feedback: 'add timezone' }, 2));
  t = reduce(t, prog({ type: 'plan', _replan: true, plan: { steps: [{ type: 'tool', tool: 'timezone' }] } }, 3));
  assert.equal(t.replans, 1);
  assert.deepEqual(t.plan.steps.map(s => s.tool), ['timezone']);
  assert.deepEqual(t.reviews, [{ reviewType: 'plan', approved: false, feedback: 'add timezone' }]);
});

test('open-ended run with no plan and no stepIndex grows the checklist in order', () => {
  let t = started();
  t = reduce(t, prog({ type: 'action', tool: 'weather', args: {} }, 1));
  assert.deepEqual(t.plan.steps, [{ index: 0, type: 'tool', tool: 'weather', description: 'weather', status: 'running' }]);
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'weather', ok: true, result: 'sunny' }, 2));
  assert.equal(t.plan.steps.length, 1);
  assert.equal(t.plan.steps[0].status, 'completed'); assert.equal(t.plan.steps[0].result, 'sunny');
  t = reduce(t, prog({ type: 'action', tool: 'textstats', args: {} }, 3));
  assert.equal(t.plan.steps.length, 2);
  assert.equal(t.plan.steps[1].index, 1); assert.equal(t.plan.steps[1].status, 'running');
  t = reduce(t, prog({ type: 'observation', stepType: 'tool', tool: 'textstats', ok: false, error: 'bad input' }, 4));
  assert.equal(t.plan.steps[1].status, 'failed'); assert.equal(t.plan.steps[1].error, 'bad input');
});

test('non-completed settles carry an error; later events are ignored', () => {
  const base = started();
  const failed = reduce(base, settledEvent(JOB, { status: 'failed', error: { code: 'run_failed', message: 'unexpected: kaboom' } }));
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.error, { code: 'run_failed', message: 'unexpected: kaboom' }); assert.equal(failed.answer, null);
  const cancelled = reduce(base, settledEvent(JOB, { status: 'cancelled' }));
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error.message, 'cancelled');
  const budget = reduce(base, settledEvent(JOB, { status: 'budget_exceeded', error: { code: 'budget_exceeded', message: 'maxIterations' } }));
  assert.equal(budget.status, 'budget_exceeded'); assert.equal(budget.error.message, 'maxIterations');
  const replayed = reduce(reduce(failed, startedEvent(JOB)), prog(PLAN, 9));
  assert.deepEqual(replayed, failed);
});

test('submitFailed, cancelling, and malformed events', () => {
  const t0 = initialTurn('x');
  const bad = submitFailed(t0, { message: 'queue_full (retry in 30s)' });
  assert.equal(bad.status, 'error'); assert.equal(bad.error.message, 'queue_full (retry in 30s)'); assert.equal(isLive(bad), false);
  const live = started();
  const c = cancelling(live);
  assert.equal(c.status, 'cancelling'); assert.equal(isLive(c), true);
  assert.equal(reduce(c, prog(PLAN, 1)).status, 'cancelling');          // progress does not un-cancel
  assert.equal(cancelling(bad), bad);                                   // no-op when not live
  assert.deepEqual(reduce(live, null), live);
  assert.deepEqual(reduce(live, { type: 'progress', kind: 'mystery', iteration: 7 }), { ...live, iteration: 7 });
  assert.deepEqual(reduce(live, { type: 'nonsense' }), live);
});
