// tests/host-memory-module.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createMemoryModule } = await import('../host/memory/index.mjs');

function fakeConversationStore() {
  const turns = new Map();
  const calls = [];
  return {
    calls,
    async open() { calls.push('open'); },
    async close() { calls.push('close'); },
    async append(turn) { turns.set(turn.id, turn); calls.push('append'); },
    async get(id) { return turns.get(id) ?? null; },
    async update(id, patch) {
      const next = { ...turns.get(id), ...patch };
      turns.set(id, next);
      return next;
    },
    async listSession(sessionId) {
      return [...turns.values()].filter(t => t.sessionId === sessionId);
    },
    async purgeSessions() { return 0; },
  };
}

function fakeStore() {
  const data = new Map();
  const calls = [];
  return {
    calls,
    async open() { calls.push('open'); },
    async close() { calls.push('close'); },
    async store(entry) { data.set(entry.id, entry); calls.push('store'); },
    async get(id) { return data.get(id) ?? null; },
    async update(id, patch) {
      const next = { ...data.get(id), ...patch };
      data.set(id, next);
      return next;
    },
    async remove(id) { data.delete(id); },
    async query() { return [...data.values()]; },
    async purge() { return 0; },
    async count() { return data.size; },
  };
}

test('createMemoryModule wires long-term memory, routes, and events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-'));
  const published = [];
  const notifier = { publish: async (event) => { published.push(event); } };
  const mod = await createMemoryModule({
    longTerm: {
      enabled: true,
      store: 'filesystem',
      dir,
      decay: { mode: 'none' },
    },
  }, { notifier, fleetApi: {}, logger: console });
  assert.equal(mod.conversationContext, null);
  assert.equal(mod.checkpointStore, null);
  assert.equal(mod.learner, null);
  assert.ok(mod.longTerm);
  assert.equal(typeof mod.routes.memoryStore.handler, 'function');
  await mod.open();
  try {
    await mod.longTerm.store({ kind: 'domain', text: 'the sky is blue', source: 'human', tags: ['sky'] });
    assert.ok(published.some(event => event.type === 'memory:store'));
  } finally {
    await mod.close();
  }
});

test('createMemoryModule enables learner, run state, and conversation context only when configured', async () => {
  const store = fakeStore();
  const ccStore = fakeConversationStore();
  const mod = await createMemoryModule({
    conversationContext: { enabled: true, store: () => ccStore, maxRecentTurns: 4 },
    runState: { enabled: true, store: () => store },
    longTerm: { enabled: true, autoLearn: true, store: () => fakeStore(), decay: { mode: 'none' } },
  }, { notifier: null, fleetApi: { executePrompt() {} }, logger: console });
  assert.ok(mod.conversationContext);
  assert.equal(mod.conversationContext.mode, 'store');
  // The module exposes the STORE; host/checkpoint/ owns save/load/clear, so
  // one record serves both crash recovery and a pause.
  assert.ok(mod.checkpointStore);
  assert.ok(mod.learner);
  assert.ok(mod.longTerm);
  await mod.open();
  try {
    await mod.checkpointStore.store({ id: 'cp-task-1', kind: 'procedure', text: '{}' });
    assert.ok(store.calls.includes('store'));
    assert.ok(ccStore.calls.includes('open'));
  } finally {
    await mod.close();
    assert.ok(store.calls.includes('close'));
    assert.ok(ccStore.calls.includes('close'));
  }
});

test('createMemoryModule supports passthrough conversation context mode', async () => {
  const mod = await createMemoryModule({
    conversationContext: { enabled: true, mode: 'passthrough', maxRecentTurns: 10 },
  }, { notifier: null, fleetApi: { executePrompt() {} }, logger: console });
  assert.ok(mod.conversationContext);
  assert.equal(mod.conversationContext.mode, 'passthrough');
  assert.equal(mod.conversationContext.maxRecentTurns, 10);
  await mod.open();
  await mod.close();
});

test('createMemoryModule interpolates env vars in long-term config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-env-'));
  const previous = process.env.MEM_TEST_DIR;
  process.env.MEM_TEST_DIR = dir;
  try {
    const mod = await createMemoryModule({
      longTerm: { enabled: true, store: 'filesystem', dir: '${MEM_TEST_DIR}', decay: { mode: 'none' } },
    }, { logger: console });
    await mod.open();
    try {
      const stored = await mod.longTerm.store({ kind: 'preference', text: 'prefer windows', source: 'human' });
      const id = stored.entry?.id ?? stored.id;
      const onDisk = await fs.readFile(path.join(dir, `${id}.json`), 'utf8');
      assert.match(onDisk, /prefer windows/);
    } finally {
      await mod.close();
    }
  } finally {
    if (previous === undefined) delete process.env.MEM_TEST_DIR;
    else process.env.MEM_TEST_DIR = previous;
  }
});

test('createMemoryModule closes ltm and rsStore independently', async () => {
  const ltmStore = fakeStore();
  ltmStore.close = async () => { throw new Error('ltm close failed'); };
  const rsStore = fakeStore();
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(String(msg)) };
  const mod = await createMemoryModule({
    runState: { enabled: true, store: () => rsStore },
    longTerm: { enabled: true, store: () => ltmStore, decay: { mode: 'none' } },
  }, { logger });
  await mod.open();
  await mod.close();
  assert.ok(rsStore.calls.includes('close'), 'the checkpoint store must close even when long-term close fails');
  assert.ok(warnings.some(w => /long-term memory/i.test(w)));
});

test('createMemoryModule open resolves when preload fails with non-ENOENT error', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-store-'));
  const preloadPath = path.join(os.tmpdir(), `mem-mod-preload-file-${process.pid}-${Date.now()}`);
  await fs.writeFile(preloadPath, 'not a directory');
  const warnings = [];
  const mod = await createMemoryModule({
    longTerm: {
      enabled: true,
      store: 'filesystem',
      dir: storeDir,
      decay: { mode: 'none' },
      preloadDir: preloadPath,
    },
  }, { logger: { info() {}, warn: (msg) => warnings.push(String(msg)) } });
  try {
    await assert.doesNotReject(() => mod.open());
    assert.ok(warnings.some(w => /preload failed/i.test(w)), 'should warn when preload throws');
  } finally {
    await mod.close();
    await fs.unlink(preloadPath).catch(() => {});
  }
});

test('createMemoryModule preloads knowledge when preloadDir is set', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-store-'));
  const preloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-mod-preload-'));
  await fs.writeFile(path.join(preloadDir, 'rules.json'), JSON.stringify([
    { kind: 'rule', text: 'Always validate input', tags: ['safety'] },
  ]));
  const mod = await createMemoryModule({
    longTerm: {
      enabled: true,
      store: 'filesystem',
      dir: storeDir,
      decay: { mode: 'none' },
      preloadDir,
    },
  }, { logger: { info() {}, warn() {} } });
  await mod.open();
  try {
    const entries = await mod.longTerm.query({});
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /validate input/);
  } finally {
    await mod.close();
  }
});

test('memory module lazy-loads cosmos and does not import @azure/cosmos', async () => {
  const src = await fs.readFile(new URL('../host/memory/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /await import\('\.\/store\/cosmos\.mjs'\)/);
  assert.doesNotMatch(src, /@azure\/cosmos/);
  await assert.rejects(
    () => createMemoryModule({
      longTerm: { enabled: true, store: 'cosmos', cosmos: {} },
    }),
    /endpoint/,
  );
});
