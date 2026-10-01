// tests/host-memory-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'host-memory-config-'));
}

async function writeConfig(dir, content) {
  await fs.writeFile(path.join(dir, 'host.config.mjs'), content);
}

async function loadWithWarnings(dir) {
  const { loadConfig } = await import('../host/config.mjs');
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const config = await loadConfig(dir);
    return { config, warnings };
  } finally {
    console.warn = origWarn;
  }
}

const base = `name: 'x', fleet: {}, comm: { adapter: 'express' }`;

test('memory enabled does not warn not implemented', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, `export default { ${base}, modules: { memory: { enabled: true } } };`);
  const { config, warnings } = await loadWithWarnings(dir);
  assert.equal(config.modules.memory.enabled, true);
  assert.ok(!warnings.some(w => /memory/i.test(w) && /not implemented/i.test(w)));
});

test('memory submodules without runLoop warn about missing run history', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, `export default { ${base}, modules: { memory: {
    runState: { enabled: true },
    longTerm: { enabled: false, autoLearn: true },
  } } };`);
  const { warnings } = await loadWithWarnings(dir);
  assert.ok(warnings.some(w => w.includes('memory.checkpoint enabled but runLoop disabled')));
  assert.ok(warnings.some(w => w.includes('memory.longTerm.autoLearn enabled but runLoop disabled')));
  assert.ok(warnings.some(w => w.includes('memory.longTerm.autoLearn enabled but longTerm disabled')));
  assert.ok(!warnings.some(w => /not implemented/i.test(w)));
});

test('memory submodules with runLoop and longTerm enabled do not warn', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, `export default { ${base}, modules: {
    runLoop: { enabled: true },
    memory: {
      enabled: true,
      runState: { enabled: true },
      longTerm: { enabled: true, autoLearn: true },
    },
  } };`);
  const { warnings } = await loadWithWarnings(dir);
  assert.ok(!warnings.some(w => w.includes('memory.checkpoint enabled but runLoop disabled')));
  assert.ok(!warnings.some(w => w.includes('memory.longTerm.autoLearn enabled but runLoop disabled')));
  assert.ok(!warnings.some(w => w.includes('memory.longTerm.autoLearn enabled but longTerm disabled')));
  assert.ok(!warnings.some(w => /memory/i.test(w) && /not implemented/i.test(w)));
});

test('memory.conversationContext enabled without chat warns about missing conversation tracking', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, `export default { ${base}, modules: {
    runLoop: { enabled: true },
    memory: { conversationContext: { enabled: true } },
  } };`);
  const { warnings } = await loadWithWarnings(dir);
  assert.ok(warnings.some(w => w.includes('memory.conversationContext enabled but chat disabled')));
});

test('memory.conversationContext enabled with chat enabled does not warn', async () => {
  const dir = await tmpDir();
  await writeConfig(dir, `export default { ${base}, modules: {
    runLoop: { enabled: true },
    dispatch: { enabled: true },
    notify: { sse: { enabled: true } },
    chat: { enabled: true },
    memory: { conversationContext: { enabled: true } },
  } };`);
  const { warnings } = await loadWithWarnings(dir);
  assert.ok(!warnings.some(w => w.includes('memory.conversationContext enabled but chat disabled')));
});
