// tests/host-memory-host.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { WorkerDispatcher } from '../pool/worker-dispatcher.mjs';
import { WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { startHost } = await import('../host/index.mjs');
const { createMemoryModule } = await import('../host/memory/index.mjs');
const { createSqliteStore } = await import('../host/jobs/store/sqlite.mjs');
const { createRecord } = await import('../host/jobs/record.mjs');

async function makeDispatcher() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-mem-pool-'));
  return new WorkerDispatcher({
    pool: WorkerPool.create({ config: { size: 1, root, acquireTimeoutMs: 5000 } }),
    ephemeral: null,
    config: { maxQueueSize: 2, queueTimeoutMs: 5000 },
  });
}

function httpCall(port, method, urlPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function writeHostConfig(dir, modules) {
  await fs.writeFile(path.join(dir, 'host.config.mjs'), `export default {
    name: 'mem-host',
    fleet: {},
    comm: { adapter: 'express', host: '127.0.0.1' },
    modules: ${modules},
  };`);
}

test('startHost mounts memory routes and tools when memory is configured', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-mem-on-'));
  const memDir = path.join(dir, 'memory');
  await writeHostConfig(dir, `{
    memory: {
      longTerm: { enabled: true, store: 'filesystem', dir: ${JSON.stringify(memDir)}, decay: { mode: 'none' } },
    },
  }`);
  const dispatcher = await makeDispatcher();
  const started = await startHost({
    fleetApi: createMockFleetApi({ members: rosterNames(1) }),
    dispatcher,
    port: 0,
    configDir: dir,
  });
  try {
    assert.ok(started.memory, 'startHost must return the memory module when memory is enabled');
    assert.equal(typeof started.memory.close, 'function');
    assert.ok(started.registry.some(tool => tool.name === 'remember'));
    const created = await httpCall(started.host.port(), 'POST', '/memory', {
      text: 'pack layers', kind: 'domain', tags: ['travel'],
    });
    assert.equal(created.status, 201);
    const listed = await httpCall(started.host.port(), 'GET', '/memory');
    assert.equal(listed.status, 200);
    assert.match(listed.body, /pack layers/);
  } finally {
    await started.close();
  }
});

test('startHost continues when memory fails to open', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-mem-fail-'));
  await writeHostConfig(dir, `{
    memory: { enabled: true, longTerm: { enabled: true, store: 'cosmos', cosmos: {} } },
  }`);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  const dispatcher = await makeDispatcher();
  let started;
  try {
    started = await startHost({
      fleetApi: createMockFleetApi({ members: rosterNames(1) }),
      dispatcher,
      port: 0,
      configDir: dir,
    });
  } finally {
    console.warn = origWarn;
  }
  try {
    assert.equal(started.memory, null, 'startHost must return null memory when memory fails to open');
    // The message moved from console.warn to the host logger, so the outcome
    // is asserted rather than the log line: the host is up, memory is off, and
    // nothing memory-shaped is exposed. That is the degrade this test is for.
    //
    // It degrades only because humanInput is off here. With it on, a memory
    // that fails to open is fatal — a paused run would have nowhere to put its
    // checkpoint. See tests/host-checkpoint-config.test.mjs.
    assert.ok(!started.registry.some(tool => tool.name === 'remember'));
    const health = await httpCall(started.host.port(), 'GET', '/health');
    assert.equal(health.status, 200);
    const missing = await httpCall(started.host.port(), 'GET', '/memory');
    assert.equal(missing.status, 404);
  } finally {
    await started.close();
  }
});

test('startHost skips memory when enabled is false', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-mem-off-'));
  await writeHostConfig(dir, `{ memory: { enabled: false, longTerm: { enabled: true, store: 'cosmos', cosmos: {} } } }`);
  const dispatcher = await makeDispatcher();
  const started = await startHost({
    fleetApi: createMockFleetApi({ members: rosterNames(1) }),
    dispatcher,
    port: 0,
    configDir: dir,
  });
  try {
    assert.equal(started.memory, null, 'startHost must return null memory when memory is disabled');
    assert.ok(!started.registry.some(tool => tool.name === 'remember'));
    const missing = await httpCall(started.host.port(), 'GET', '/memory');
    assert.equal(missing.status, 404);
  } finally {
    await started.close();
  }
});

test('restored queued job sees memory opened before jobs.start', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-mem-before-jobs-'));
  const memDir = path.join(dir, 'memory');
  const dbPath = path.join(dir, 'jobs.db');
  const seeded = await createMemoryModule({
    longTerm: { enabled: true, store: 'filesystem', dir: memDir, decay: { mode: 'none' } },
  }, { logger: console });
  await seeded.open();
  await seeded.longTerm.store({ kind: 'rule', text: 'Never delete without backup', tags: ['safety'], source: 'human' });
  await seeded.close();

  const jobsStore = createSqliteStore({ dbPath });
  await jobsStore.open();
  await jobsStore.insert(createRecord({ goal: 'Inspect the weather in London' }, { id: 'job-restored' }));
  await jobsStore.close();

  await writeHostConfig(dir, `{
    runLoop: { enabled: true, strategy: 'open-ended' },
    router: { enabled: false },
    guardrails: { enabled: false },
    budgets: { enabled: false },
    chat: { enabled: false },
    dispatch: { enabled: true, backend: 'in-process', store: { kind: 'sqlite', dbPath: ${JSON.stringify(dbPath)} } },
    memory: { longTerm: { enabled: true, store: 'filesystem', dir: ${JSON.stringify(memDir)}, decay: { mode: 'none' } } },
  }`);

  const fleetApi = createMockFleetApi({
    members: rosterNames(1),
    promptResponses: ['```done\n{"result": "done", "summary": "s"}\n```'],
  });
  const dispatcher = await makeDispatcher();
  const started = await startHost({ fleetApi, dispatcher, port: 0, configDir: dir });
  try {
    let job = null;
    for (let i = 0; i < 50; i++) {
      job = await started.jobs.get('job-restored');
      if (job && job.status !== 'queued' && job.status !== 'processing') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(job?.status, 'completed');
    assert.ok(fleetApi.promptCalls.some(call => call.prompt.includes('Never delete without backup')));
    assert.ok(started.registry.some(tool => tool.name === 'remember'));
  } finally {
    await started.close();
  }
});
