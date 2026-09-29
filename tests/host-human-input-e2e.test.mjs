// tests/host-human-input-e2e.test.mjs
//
// Offline proof of the whole loop over real HTTP: a run reaches an
// irreversible tool, the guardrail asks, the run parks, the worker is
// released, an HTTP caller answers, a fresh worker picks the run up and
// finishes it — and the tool runs exactly once.
//
// Mock Fleet, real host, real routes, real SSE. No token, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';
import { readSse } from './helpers/sse.mjs';

const { startHost } = await import('../host/index.mjs');
const { extendRegistry } = await import('../host/tools/registry.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-hi-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

// A doer that decides from what it has been told, not from a call counter.
// Several jobs share one mock here, so a positional script would hand job two
// the reply meant for job one. It asks to book until its own history shows a
// booking reference or a refusal, then reports — which is what a real model
// does.
const bookingFleet = () => createMockFleetApi({
  members: rosterNames(2),
  promptResponses: ({ prompt }) => {
    const text = String(prompt ?? '');
    if (text.includes('task router')) return '{"path":"open-ended"}';
    if (text.includes('BR-')) {
      return '```done\n{"result": "Booked a flight to Paris", "summary": "Done"}\n```';
    }
    if (text.includes('approval_denied')) {
      return '```done\n{"result": "I did not book anything.", "summary": "Denied"}\n```';
    }
    return '```tool_call\n{"tool": "book", "args": {"city": "Paris"}}\n```';
  },
});

function bookingTool() {
  const calls = [];
  return {
    calls,
    tool: {
      name: 'book',
      description: 'book a flight',
      // Plain language, no identifiers: this is what a person actually reads.
      approvalPrompt: (args) => `Book a flight to ${args.city}?`,
      reversible: false,
      timeout: 5000,
      async run({ args }) {
        calls.push(args);
        return { ok: true, ref: `BR-${calls.length}` };
      },
    },
  };
}

const bookingHost = (tools, extra = {}) => startHost({
  port: 0,
  env: { ...process.env, NODE_ENV: 'test' },
  registry: extendRegistry(tools),
  runLoop: { enabled: true, strategy: 'open-ended', maxNoActionTurns: 3 },
  guardrails: { enabled: true, defaultPolicy: 'allow' },
  dispatch: { enabled: true, store: { kind: 'memory' }, maxQueueSize: 4, concurrency: 1 },
  notify: { sse: { enabled: true } },
  humanInput: { enabled: true },
  ...extra,
});

const url = (host, p) => `http://127.0.0.1:${host.port()}${p}`;
const getJson = async (host, p) => {
  const r = await fetch(url(host, p));
  return { status: r.status, body: await r.json() };
};
const postJson = async (host, p, body) => {
  const r = await fetch(url(host, p), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

async function waitForStatus(host, jobId, status, ms = 20_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(host, `/jobs/${jobId}`);
    if (last.body?.status === status) return last.body;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail(`job never reached ${status} (is ${last?.body?.status})`);
}

test('e2e: a run parks on an approval, an HTTP answer resumes it, the tool runs once', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { calls, tool } = bookingTool();
  const { host, close } = await bookingHost([tool], { fleetApi: bookingFleet(), dispatcher });

  try {
    const submitted = await postJson(host, '/task', { goal: 'book a flight to Paris' });
    assert.equal(submitted.status, 202);
    const { jobId } = submitted.body;

    // 1. It parks, and the question is on the record in plain language.
    const parked = await waitForStatus(host, jobId, 'waiting_input');
    assert.ok(parked.pendingInput, 'the question is on the record');
    assert.equal(parked.stale, false);
    const question = parked.pendingInput.questions[0];
    assert.equal(question.kind, 'approval');
    assert.equal(question.prompt, 'Book a flight to Paris?');
    assert.equal(question.prompt.includes('book'), false, 'no tool name reaches the screen');
    assert.deepEqual(calls, [], 'nothing was booked before anyone approved');

    // 2. The worker is free while it waits. This is the load-bearing claim.
    const other = await postJson(host, '/task', { goal: 'book a flight to Paris' });
    await waitForStatus(host, other.body.jobId, 'waiting_input');

    // 3. A wrong answer is refused, and changes nothing.
    const bad = await postJson(host, `/jobs/${jobId}/input`, {
      batchId: parked.pendingInput.batchId, answers: { proceed: 'maybe' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'validation_failed');
    assert.ok(bad.body.fields.proceed);
    assert.equal((await getJson(host, `/jobs/${jobId}`)).body.status, 'waiting_input');

    // 4. A good answer resumes it.
    const answer = await postJson(host, `/jobs/${jobId}/input`, {
      batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.ok, true);

    const done = await waitForStatus(host, jobId, 'completed');
    assert.equal(done.result, 'Booked a flight to Paris');
    assert.equal(done.pendingInput, null);

    // 5. Booked once. Resume restores state; it does not replay side effects.
    assert.equal(calls.length, 1, `the flight was booked ${calls.length} times`);
    assert.deepEqual(calls[0], { city: 'Paris' });

    // 6. History says who agreed to what.
    const events = await getJson(host, `/jobs/${jobId}`);
    assert.equal(events.status, 200);
  } finally {
    await close();
    await dispatcher.close();
  }
});

test('e2e: input_required reaches a waiting SSE client', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { tool } = bookingTool();
  const { host, close } = await bookingHost([tool], { fleetApi: bookingFleet(), dispatcher });

  try {
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'book a flight to Paris' });

    let asked = null;
    for await (const e of readSse(await fetch(url(host, `/jobs/${jobId}/events`)))) {
      if (e.event === 'input_required') { asked = e.data; break; }
      if (e.event === 'settled') break;
    }

    assert.ok(asked, 'a client watching the stream is told a question is waiting');
    assert.equal(asked.jobId, jobId);
    assert.equal(asked.questions[0].prompt, 'Book a flight to Paris?');
    assert.ok(asked.expiresAt, 'the client is told how long it has');
  } finally {
    await close();
    await dispatcher.close();
  }
});

test('e2e: denying refuses the tool and the run finishes without it', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { calls, tool } = bookingTool();
  const { host, close } = await bookingHost([tool], { fleetApi: bookingFleet(), dispatcher });

  try {
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'book a flight to Paris' });
    const parked = await waitForStatus(host, jobId, 'waiting_input');

    const answer = await postJson(host, `/jobs/${jobId}/input`, {
      batchId: parked.pendingInput.batchId, answers: { proceed: 'deny' },
    });
    assert.equal(answer.status, 200);

    await waitForStatus(host, jobId, 'completed');
    assert.deepEqual(calls, [], 'a denial means the booking never happens');
  } finally {
    await close();
    await dispatcher.close();
  }
});

test('e2e: cancelling while waiting settles at once', { timeout: 60_000 }, async () => {
  const dispatcher = await makeDispatcher();
  const { calls, tool } = bookingTool();
  const { host, close } = await bookingHost([tool], { fleetApi: bookingFleet(), dispatcher });

  try {
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'book a flight to Paris' });
    const parked = await waitForStatus(host, jobId, 'waiting_input');

    const cancelled = await fetch(url(host, `/jobs/${jobId}`), { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { ok: true, status: 'cancelled' });

    const record = (await getJson(host, `/jobs/${jobId}`)).body;
    assert.equal(record.status, 'cancelled');
    assert.equal(record.pendingInput, null);
    assert.deepEqual(calls, []);

    // Answering afterwards is refused rather than reviving the run.
    const late = await postJson(host, `/jobs/${jobId}/input`, {
      batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' },
    });
    assert.equal(late.status, 409);
  } finally {
    await close();
    await dispatcher.close();
  }
});

test('e2e: with the feature off, an irreversible tool is denied exactly as before', { timeout: 60_000 }, async () => {
  // The promise the whole design rests on: a clone that never turns this on
  // behaves the way it did before the feature existed.
  const dispatcher = await makeDispatcher();
  const { calls, tool } = bookingTool();
  const { host, close } = await bookingHost([tool], {
    fleetApi: bookingFleet(), dispatcher, humanInput: { enabled: false },
  });

  try {
    const { body: { jobId } } = await postJson(host, '/task', { goal: 'book a flight to Paris' });
    const done = await waitForStatus(host, jobId, 'completed');

    assert.equal(done.pendingInput ?? null, null, 'nothing was ever asked');
    assert.deepEqual(calls, [], 'and the irreversible tool was denied, not run');
  } finally {
    await close();
    await dispatcher.close();
  }
});
