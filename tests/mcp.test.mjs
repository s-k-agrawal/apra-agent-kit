import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi as createSharedMock, rosterNames } from './helpers/mock-fleet.mjs';

const { buildMcpServer } = await import('../mcp/server.mjs');
const { createMcpHttpApp } = await import('../mcp/http.mjs');
const { startMcpServer } = await import('../mcp/main.mjs');

function mockPayloadForCommand(command) {
  if (command.includes('weather.py')) {
    return JSON.stringify({
      ok: true, location: 'London, United Kingdom', temp_c: '15',
      temp_f: '59', feels_like_c: '14', humidity: '72',
      description: 'Partly cloudy', wind_speed_kmph: '11',
      wind_dir: 'WSW', visibility_km: '10', uv_index: '3',
    });
  }
  if (command.includes('timezone.py')) {
    return JSON.stringify({
      ok: true, timezone: 'Europe/London', datetime: '2025-06-15T14:30:00+01:00',
      utc_offset: '+01:00', day_of_week: 0, abbreviation: 'BST',
    });
  }
  if (command.includes('textstats.py')) {
    return JSON.stringify({
      ok: true, char_count: 26, word_count: 5,
      sentence_count: 1, unique_words: 5, avg_word_length: 4.2,
    });
  }
  return JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
}

function createMockFleetApi() {
  return createSharedMock({
    members: rosterNames(2),
    commandPayload: (options) => mockPayloadForCommand(options.command ?? ''),
  });
}

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 2, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
}

// Starts the real express app on an ephemeral port and connects a real MCP
// client over streamable HTTP, so the transport wiring is exercised too.
async function withServer(registryOverride, run) {
  const fleetApi = createMockFleetApi();
  const dispatcher = await makeDispatcher();
  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi, dispatcher, registry: registryOverride }),
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await run({ client, fleetApi, dispatcher });
    } finally {
      await client.close();
    }
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await dispatcher.close();
  }
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('startMcpServer rejects a real port collision', async () => {
  const occupyingServer = createHttpServer();
  occupyingServer.listen(0, '127.0.0.1');
  await once(occupyingServer, 'listening');

  try {
    const port = occupyingServer.address().port;
    await assert.rejects(
      within(
        startMcpServer({ fleetApi: createMockFleetApi(), dispatcher: await makeDispatcher(), port }),
        1_000,
        'timed out waiting for the port collision to reject',
      ),
      (err) => err?.code === 'EADDRINUSE',
    );
  } finally {
    await new Promise((resolve) => occupyingServer.close(resolve));
  }
});

test('startMcpServer removes its startup error listener after listening', async () => {
  const { server, close } = await startMcpServer({
    fleetApi: createMockFleetApi(),
    dispatcher: await makeDispatcher(),
    port: 0,
  });
  try {
    assert.equal(server.listenerCount('error'), 0);
  } finally {
    await close();
  }
});

test('shutdown rejects queued dispatches before waiting for HTTP to drain', async () => {
  let releaseHold;
  const held = new Promise((resolve) => {
    releaseHold = resolve;
  });
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const registry = [
    {
      name: 'hold',
      description: 'holds the only worker',
      async run() {
        resolveStarted();
        await held;
        return 'held';
      },
    },
    {
      name: 'next',
      description: 'queues behind hold',
      async run() {
        return 'next';
      },
    },
  ];
  const fleetApi = createMockFleetApi();
  const dispatcher = new WorkerDispatcher({
    pool: WorkerPool.create({
      config: { size: 1, root: await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-shutdown-')), acquireTimeoutMs: 5000 },
    }),
    ephemeral: null,
    config: { maxQueueSize: 4, queueTimeoutMs: 5000 },
  });
  const { server, close } = await startMcpServer({ fleetApi, dispatcher, port: 0, registry });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const clientA = new Client({ name: 'shutdown-a', version: '1.0.0' });
  const clientB = new Client({ name: 'shutdown-b', version: '1.0.0' });
  let holdCall;
  let nextCall;
  let shuttingDown;
  try {
    await clientA.connect(new StreamableHTTPClientTransport(url));
    await clientB.connect(new StreamableHTTPClientTransport(new URL(url)));
    holdCall = clientA.callTool({ name: 'hold' });
    await within(started, 1_000, 'timed out waiting for hold to start');
    nextCall = clientB.callTool({ name: 'next' });
    await within(
      (async () => {
        while (dispatcher.queued < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      })(),
      1_000,
      'timed out waiting for next to queue',
    );

    shuttingDown = close();
    const nextResult = await within(
      nextCall,
      800,
      'queued dispatch should reject promptly when shutdown begins',
    );
    assert.equal(nextResult.isError, true);
    assert.match(nextResult.content[0].text, /shutting down/);
    releaseHold();
    await holdCall;
    try { await clientA.close(); } catch { /* already closed */ }
    try { await clientB.close(); } catch { /* already closed */ }
    await shuttingDown;
  } finally {
    releaseHold?.();
    await Promise.allSettled([holdCall, nextCall, shuttingDown].filter(Boolean));
    try { await clientA.close(); } catch { /* server may already be down */ }
    try { await clientB.close(); } catch { /* server may already be down */ }
    try { await close(); } catch { /* idempotent best-effort */ }
    await dispatcher.close();
  }
});

test('advertises exactly the registry tools, with schemas and annotations', async () => {
  await withServer(undefined, async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'choose-destination',
        'city-briefing',
        'confirm-itinerary',
        'country-info',
        'currency',
        'demo',
        'destination-overview',
        'forecast',
        'geocode',
        'inspect-members',
        'places-of-interest',
        'public-holidays',
        'quick-weather',
        'route-check',
        'route-distance',
        'textstats',
        'timezone',
        'travel-advisory',
        'travel-prep',
        'trip-planner',
        'trip-preferences',
        'weather',
        'wikipedia-summary',
      ],
    );

    const inspect = tools.find((tool) => tool.name === 'inspect-members');
    assert.deepEqual(Object.keys(inspect.inputSchema.properties).sort(), ['includeFiles', 'roles']);
    assert.deepEqual(inspect.inputSchema.properties.roles.items.enum, ['doer', 'reviewer']);
    assert.equal(inspect.annotations.readOnlyHint, true);

    const demo = tools.find((tool) => tool.name === 'demo');
    assert.deepEqual(demo.inputSchema.properties ?? {}, {});
    assert.equal(demo.annotations.readOnlyHint, false);

    const weather = tools.find((tool) => tool.name === 'weather');
    assert.ok(weather.inputSchema.properties.city, 'weather should have a city param');
    assert.equal(weather.annotations.readOnlyHint, true);
    assert.equal(weather.annotations.idempotentHint, true);

    const timezone = tools.find((tool) => tool.name === 'timezone');
    assert.ok(timezone.inputSchema.properties.city, 'timezone should have a city param');
    assert.equal(timezone.annotations.readOnlyHint, true);

    const textstats = tools.find((tool) => tool.name === 'textstats');
    assert.ok(textstats.inputSchema.properties.text, 'textstats should have a text param');
    assert.equal(textstats.annotations.readOnlyHint, true);
  });
});

test('calling demo runs the workflow', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'demo' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /demo workflow completed/);
    assert.ok(fleetApi.promptCalls.length >= 1, 'the agent phase should have run');
  });
});

test('calling inspect-members with one role touches only that role', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({
      name: 'inspect-members',
      arguments: { roles: ['doer'] },
    });
    assert.equal(result.isError, undefined);
    assert.equal(fleetApi.commandCalls.length, 1);
    assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');

    const report = JSON.parse(result.content[0].text);
    assert.equal(report.workerId, 'pool-1');
    assert.deepEqual(report.members.map((entry) => entry.name), ['WORKER-1-DOER']);
  });
});

test('a throwing workflow returns isError and the server keeps serving', async () => {
  const registry = [
    {
      name: 'boom',
      description: 'always throws',
      async run() {
        throw new Error('workflow exploded');
      },
    },
    {
      name: 'fine',
      description: 'always works',
      async run() {
        return 'still here';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const failed = await client.callTool({ name: 'boom' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /workflow exploded/);

    const after = await client.callTool({ name: 'fine' });
    assert.equal(after.isError, undefined);
    assert.equal(after.content[0].text, 'still here');
  });
});

test('invalid arguments are rejected before the workflow runs', async () => {
  let ran = false;
  const registry = [
    {
      name: 'typed',
      description: 'takes a number',
      inputSchema: z.object({ count: z.number() }),
      async run() {
        ran = true;
        return 'ok';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const result = await client.callTool({ name: 'typed', arguments: { count: 'nope' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /count/);
    assert.equal(ran, false, 'run must not be called with invalid arguments');
  });
});

test('an unknown tool name fails cleanly', async () => {
  await withServer(undefined, async ({ client }) => {
    await assert.rejects(() => client.callTool({ name: 'no-such-tool' }));
  });
});

test('a client requesting progress receives a heartbeat per phase', async () => {
  await withServer(undefined, async ({ client }) => {
    const updates = [];
    const result = await client.callTool(
      { name: 'inspect-members', arguments: {} },
      { onprogress: (update) => updates.push(update) },
    );
    assert.equal(result.isError, undefined);
    assert.ok(updates.length >= 1, 'expected at least one progress notification');
    assert.ok(
      updates.every((update, index) => index === 0 || update.progress > updates[index - 1].progress),
      'progress must strictly increase',
    );
  });
});

test('a client that does not request progress still gets the result', async () => {
  await withServer(undefined, async ({ client }) => {
    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.ok(JSON.parse(result.content[0].text).members.length >= 1);
  });
});

test('calling weather returns parsed weather data', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'weather', arguments: { city: 'Paris' } });
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.ok, true);
    assert.equal(data.location, 'London, United Kingdom');
    assert.equal(fleetApi.commandCalls.length, 1);
    assert.match(fleetApi.commandCalls[0].command, /weather\.py.*Paris/);
    assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');
  });
});

test('weather defaults to London when no city given', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'weather', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(fleetApi.commandCalls[0].command, /weather\.py.*London/);
  });
});

test('calling timezone returns parsed timezone data', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'timezone', arguments: { city: 'Tokyo' } });
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.ok, true);
    assert.equal(data.timezone, 'Europe/London');
    assert.match(fleetApi.commandCalls[0].command, /timezone\.py.*Tokyo/);
  });
});

test('calling textstats returns parsed analysis', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({
      name: 'textstats',
      arguments: { text: 'Hello world this is a test' },
    });
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.ok, true);
    assert.equal(typeof data.word_count, 'number');
    assert.equal(typeof data.char_count, 'number');
    assert.match(fleetApi.commandCalls[0].command, /textstats\.py/);
  });
});

test('textstats rejects call with missing required text param', async () => {
  await withServer(undefined, async ({ client }) => {
    const result = await client.callTool({ name: 'textstats', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /text/);
  });
});

test('disconnecting a client closes the request server and aborts its workflow', async () => {
  let resolveStarted;
  let resolveAborted;
  let resolveClosed;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const aborted = new Promise((resolve) => {
    resolveAborted = resolve;
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const registry = [
    {
      name: 'slow',
      description: 'waits for cancellation',
      async run({ signal }) {
        resolveStarted();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        resolveAborted();
        return 'cancelled';
      },
    },
  ];
  const fleetApi = createMockFleetApi();
  const dispatcher = await makeDispatcher();
  const app = createMcpHttpApp({
    buildServer: () => {
      const server = buildMcpServer({ fleetApi, dispatcher, registry });
      server.server.onclose = resolveClosed;
      return server;
    },
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slow', arguments: {} },
  });
  const request = httpRequest({
    hostname: '127.0.0.1',
    port: httpServer.address().port,
    path: '/mcp',
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  });
  request.on('error', () => {});
  request.end(body);

  try {
    await within(started, 1_000, 'timed out waiting for workflow to start');
    request.destroy();
    await within(
      Promise.all([closed, aborted]),
      1_000,
      'timed out waiting for request cleanup to abort the workflow',
    );
  } finally {
    request.destroy();
    await new Promise((resolve) => httpServer.close(resolve));
    await dispatcher.close();
  }
});

test('every tool call releases its lease, even when the tool throws', async () => {
  const registry = [
    { name: 'boom', description: 'throws', async run() { throw new Error('nope'); } },
    { name: 'ok', description: 'works', async run({ workspace }) { return workspace.workerId; } },
  ];
  await withServer(registry, async ({ client, dispatcher }) => {
    for (let i = 0; i < 3; i += 1) {
      const failed = await client.callTool({ name: 'boom' });
      assert.equal(failed.isError, true);
    }
    const ok = await client.callTool({ name: 'ok' });
    assert.equal(ok.content[0].text, 'pool-1', 'worker 1 must be free again after failures');
    assert.equal(dispatcher.queued, 0);
  });
});

test('tools see a pooled fleetApi that resolves role keywords', async () => {
  const registry = [
    {
      name: 'who',
      description: 'runs a command as the doer',
      async run({ fleetApi, workspace }) {
        await fleetApi.executeCommand({ member_name: 'doer', command: 'echo hi' });
        return workspace.doer.name;
      },
    },
  ];
  await withServer(registry, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'who' });
    assert.equal(result.content[0].text, 'WORKER-1-DOER');
    assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');
  });
});
