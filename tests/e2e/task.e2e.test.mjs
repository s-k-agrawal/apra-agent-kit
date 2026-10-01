// Black-box: only HTTP against BASE_URL. Never imports host code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSse } from '../helpers/sse.mjs';
import { startWebhookReceiver } from './webhook-receiver.mjs';

const BASE = process.env.BASE_URL;
if (!BASE) throw new Error('BASE_URL is required, e.g. http://agent-vm:3000 or http://agent-durable/api');
const MODE = process.env.E2E_MODE ?? 'scripted';
const TARGET = process.env.E2E_TARGET ?? 'vm';
const TIMEOUT = MODE === 'live' ? 600_000 : 90_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const api = {
  async post(p, body) { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; },
  async get(p) { const r = await fetch(`${BASE}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; },
  async del(p) { const r = await fetch(`${BASE}${p}`, { method: 'DELETE' }); return { status: r.status, body: await r.json().catch(() => null) }; },
  async follow(jobId) {
    const events = [];
    for await (const e of readSse(await fetch(`${BASE}/jobs/${jobId}/events`))) { events.push(e); if (e.event === 'settled') break; }
    return events;
  },
  async waitProcessing(jobId) {
    for (let i = 0; i < 600; i++) {
      const r = await api.get(`/jobs/${jobId}`);
      if (r.body?.status === 'processing') return;
      await sleep(100);
    }
    throw new Error(`job ${jobId} never reached processing`);
  },
  async waitWaiting(jobId) {
    for (let i = 0; i < 900; i++) {
      const r = await api.get(`/jobs/${jobId}`);
      if (r.body?.status === 'waiting_input') return r.body;
      if (['completed', 'failed', 'cancelled'].includes(r.body?.status)) {
        throw new Error(`job ${jobId} settled ${r.body.status} without ever asking`);
      }
      await sleep(100);
    }
    throw new Error(`job ${jobId} never reached waiting_input`);
  },
};

const summary = [];
test.after(() => { console.log('E2E_SUMMARY_JSON ' + JSON.stringify({ target: TARGET, mode: MODE, results: summary })); });

test('health', async () => { assert.deepEqual((await api.get('/health')).body, { ok: true }); });

const scenarioFiles = (await readdir(path.join(here, 'scenarios'))).filter(f => f.endsWith('.json')).sort();
for (const file of scenarioFiles) {
  const s = JSON.parse(await readFile(path.join(here, 'scenarios', file), 'utf8'));
  test(`scenario ${s.id}: ${s.title}`, { timeout: TIMEOUT }, async () => {
    const t0 = Date.now();
    const constraints = MODE === 'live' && s.liveConstraints ? s.liveConstraints : s.constraints;
    const sub = await api.post('/task', { goal: s.goal, constraints, metadata: { scenario: s.id } });
    assert.equal(sub.status, 202, JSON.stringify(sub.body));
    const { jobId, links } = sub.body;
    assert.equal(links.events, `/jobs/${jobId}/events`);

    // A paused run emits no `settled`, so the follow would block until the
    // question is answered. Start it first, then answer, then collect.
    const following = api.follow(jobId);

    if (s.humanInput) {
      const parked = await api.waitWaiting(jobId);
      assert.ok(parked.pendingInput, 'the batch is on the record');
      assert.equal(parked.pendingInput.askedBy, s.humanInput.expectAskedBy);
      assert.equal(parked.pendingInput.questions[0].kind, s.humanInput.expectKind);
      assert.equal(parked.pendingInput.questions[0].prompt.includes(s.expectedTools[0]), false,
        'no tool name reaches the person');

      // The load-bearing assertion for the checkpoint change: the job record
      // carries a pointer, and the state lives in the checkpoint store.
      assert.equal(parked.snapshot, undefined, 'no run state on the job record');
      assert.ok(parked.pendingBatchId, 'a pointer is on the job record');

      const answered = await api.post(`/jobs/${jobId}/input`, {
        batchId: parked.pendingInput.batchId,
        answers: s.humanInput.answer,
      });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
    }

    const events = await following;
    const types = events.map(e => e.event);
    assert.equal(types.at(-1), 'settled');
    assert.ok(types.includes('started'), `expected started in ${types}`);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].id > events[i - 1].id, 'ids strictly increase');
    const progress = events.filter(e => e.event === 'progress');
    for (const p of progress) assert.ok(typeof p.data.kind === 'string', 'progress events carry kind');
    const settled = events.at(-1).data;

    const rec = (await api.get(`/jobs/${jobId}`)).body;
    assert.equal(rec.status, settled.status);
    assert.ok(s.expectedStatus.includes(rec.status), `status ${rec.status} not in ${s.expectedStatus}`);
    assert.ok(rec.finishedAt && rec.startedAt, 'timestamps populated');
    assert.ok(Array.isArray(rec.history));
    const toolsSeen = new Set(rec.history.filter(h => h.tool).map(h => h.tool));
    for (const tool of s.expectedTools) assert.ok(toolsSeen.has(tool), `expected tool ${tool} in history; saw ${[...toolsSeen]}`);
    if (s.humanInput?.expectResultMatches) {
      const text = typeof rec.result === 'string' ? rec.result : JSON.stringify(rec.result);
      assert.match(text, new RegExp(s.humanInput.expectResultMatches));
      // The tool ran once across the pause, not once per run.
      const ran = rec.history.filter(h => h.tool === s.expectedTools[0]);
      assert.equal(ran.length, 1, `${s.expectedTools[0]} ran ${ran.length} times across the pause`);
    }
    summary.push({ scenario: s.id, status: rec.status, iterations: rec.budget?.iterations ?? null, tokens: rec.budget?.totalTokens ?? null, costUsd: rec.budget?.estimatedCostUsd ?? null, wallMs: Date.now() - t0 });
  });
}

test('unknown job is 404', async () => { assert.equal((await api.get('/jobs/does-not-exist')).status, 404); });

test('cancel a running job settles cancelled', { timeout: TIMEOUT }, async () => {
  const sub = await api.post('/task', { goal: 'Research every capital city in Europe - weather and country info for each.', constraints: { maxIterations: 50 } });
  assert.equal(sub.status, 202);
  const { jobId } = sub.body;
  await api.waitProcessing(jobId);
  const del = await api.del(`/jobs/${jobId}`);
  assert.ok([200, 202].includes(del.status), JSON.stringify(del.body));
  const events = await api.follow(jobId);
  assert.equal(events.at(-1).data.status, 'cancelled');
  assert.equal((await api.get(`/jobs/${jobId}`)).body.status, 'cancelled');
});

test('backpressure returns 429 with Retry-After when the queue is full', { timeout: TIMEOUT }, async () => {
  // agent-vm runs with JOBS_MAX_QUEUE_SIZE=1 JOBS_CONCURRENCY=1; agent-durable with
  // JOBS_MAX_QUEUE_SIZE=2 (Durable counts Running + Pending). Both yield: a=202, b=202, c=429.
  const goal = 'Research every capital city in Europe - weather and country info for each.';
  const a = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  assert.equal(a.status, 202);
  await api.waitProcessing(a.body.jobId);
  const b = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  const c = await api.post('/task', { goal, constraints: { maxIterations: 50 } });
  assert.equal(b.status, 202, JSON.stringify(b.body));
  assert.equal(c.status, 429, JSON.stringify(c.body));
  assert.equal(c.headers.get('retry-after'), '30');
  await api.del(`/jobs/${a.body.jobId}`);
  await api.del(`/jobs/${b.body.jobId}`);
  await api.follow(a.body.jobId);
  await api.follow(b.body.jobId);
});

test('webhook delivers exactly one settled event', { timeout: TIMEOUT }, async () => {
  const receiver = await startWebhookReceiver({ port: Number(process.env.WEBHOOK_RECEIVER_PORT ?? 9000) });
  try {
    const url = `http://${process.env.WEBHOOK_RECEIVER_HOST ?? 'e2e'}:${receiver.port}/hook`;
    const sub = await api.post('/task', { goal: 'What is the weather in Tokyo?', constraints: { maxIterations: 10 }, callbackUrl: url });
    assert.equal(sub.status, 202, JSON.stringify(sub.body));
    const hit = await receiver.waitFor(e => e.headers['x-fleet-job-id'] === sub.body.jobId, TIMEOUT - 5000);
    assert.equal(hit.body.type, 'settled');
    await sleep(500);
    assert.equal(receiver.received.filter(e => e.headers['x-fleet-job-id'] === sub.body.jobId).length, 1);
  } finally { await receiver.close(); }
});

test('record survives an agent restart (vm only, needs E2E_RESTART_CMD)', { skip: !(TARGET === 'vm' && process.env.E2E_RESTART_CMD), timeout: TIMEOUT }, async () => {
  const sub = await api.post('/task', { goal: 'What is the weather in Tokyo?', constraints: { maxIterations: 10 } });
  await api.follow(sub.body.jobId);
  execSync(process.env.E2E_RESTART_CMD, { stdio: 'inherit' });
  for (let i = 0; i < 120; i++) { try { if ((await api.get('/health')).status === 200) break; } catch { /* booting */ } await sleep(500); }
  const rec = await api.get(`/jobs/${sub.body.jobId}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.status, 'completed');
});
