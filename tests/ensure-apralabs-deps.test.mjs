// tests/ensure-apralabs-deps.test.mjs
//
// A copied package has to arrive with the dependencies it needs.
//
// `ensureApralabs` copies @apralabs packages out of a global install when npm
// has not provided them locally. npm *hoists*: a package's dependencies
// normally sit in the root `node_modules`, not inside the package. So copying
// the package directory alone produces a package that cannot resolve its own
// imports, and the failure surfaces far away — as
// `Cannot find package 'ajv' imported from .../apra-fleet-workflow/src/workflow/index.mjs`,
// nineteen integration tests into a Docker run.
//
// These build a fake global install rather than needing one, so they run
// anywhere — including a machine with no Fleet and no Docker, which is exactly
// where the real bug could not be reproduced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { copyMissingDeps } = await import('../transport/ensure-apralabs.mjs');

/**
 * A global npm tree: @apralabs packages, with their dependencies hoisted to
 * the root the way npm actually installs them.
 */
function fakeGlobal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-global-'));
  const nm = path.join(root, 'node_modules');

  const pkg = (dir, name, deps = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies: deps }));
    fs.writeFileSync(path.join(dir, 'index.mjs'), `export const name = '${name}';`);
  };

  pkg(path.join(nm, '@apralabs', 'apra-fleet-workflow'), '@apralabs/apra-fleet-workflow', { ajv: '^8.0.0' });
  pkg(path.join(nm, 'ajv'), 'ajv', { 'json-schema-traverse': '^1.0.0' });   // hoisted, as npm does
  pkg(path.join(nm, 'json-schema-traverse'), 'json-schema-traverse');        // transitive
  pkg(path.join(nm, 'unrelated'), 'unrelated');                             // must not be dragged in

  return { root, nm, scope: path.join(nm, '@apralabs') };
}

function fakeDest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-dest-'));
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(nm, '@apralabs'), { recursive: true });
  return { root, nm };
}

test('a copied package brings the dependency it imports', () => {
  const g = fakeGlobal();
  const d = fakeDest();
  // The package itself, copied the way ensureApralabs copies it.
  fs.cpSync(path.join(g.scope, 'apra-fleet-workflow'), path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), { recursive: true });

  copyMissingDeps(path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), g.nm, d.nm);

  assert.ok(fs.existsSync(path.join(d.nm, 'ajv')), 'ajv was not copied — this is the bug');
});

test('transitive dependencies come too', () => {
  // ajv needs json-schema-traverse. Copying one level deep would move the
  // failure rather than fix it.
  const g = fakeGlobal();
  const d = fakeDest();
  fs.cpSync(path.join(g.scope, 'apra-fleet-workflow'), path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), { recursive: true });

  copyMissingDeps(path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), g.nm, d.nm);

  assert.ok(fs.existsSync(path.join(d.nm, 'json-schema-traverse')), 'transitive dependency missing');
});

test('packages nothing asked for are left behind', () => {
  // Copying the whole global tree would work and would also be wrong: it is
  // slow, and it can shadow versions npm resolved deliberately.
  const g = fakeGlobal();
  const d = fakeDest();
  fs.cpSync(path.join(g.scope, 'apra-fleet-workflow'), path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), { recursive: true });

  copyMissingDeps(path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), g.nm, d.nm);

  assert.equal(fs.existsSync(path.join(d.nm, 'unrelated')), false);
});

test('a dependency npm already installed is not overwritten', () => {
  // npm resolved it; we are filling gaps, not taking over. Overwriting could
  // downgrade a package the lockfile pinned.
  const g = fakeGlobal();
  const d = fakeDest();
  fs.mkdirSync(path.join(d.nm, 'ajv'), { recursive: true });
  fs.writeFileSync(path.join(d.nm, 'ajv', 'package.json'), JSON.stringify({ name: 'ajv', version: '9.9.9' }));
  fs.cpSync(path.join(g.scope, 'apra-fleet-workflow'), path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), { recursive: true });

  copyMissingDeps(path.join(d.nm, '@apralabs', 'apra-fleet-workflow'), g.nm, d.nm);

  const kept = JSON.parse(fs.readFileSync(path.join(d.nm, 'ajv', 'package.json'), 'utf8'));
  assert.equal(kept.version, '9.9.9', 'the installed copy was replaced');
});

test('a dependency the global install does not have is skipped, not thrown', () => {
  // Fleet is optional. A missing dependency degrades the workflow tests; it
  // must not take down a host that was starting fine without Fleet at all.
  const g = fakeGlobal();
  const d = fakeDest();
  const pkgDir = path.join(d.nm, '@apralabs', 'apra-fleet-workflow');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@apralabs/apra-fleet-workflow', dependencies: { 'not-anywhere': '^1.0.0' },
  }));

  assert.doesNotThrow(() => copyMissingDeps(pkgDir, g.nm, d.nm));
});

test('a package with no dependencies is a no-op', () => {
  const g = fakeGlobal();
  const d = fakeDest();
  const pkgDir = path.join(d.nm, '@apralabs', 'plain');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'plain' }));

  assert.doesNotThrow(() => copyMissingDeps(pkgDir, g.nm, d.nm));
  assert.deepEqual(fs.readdirSync(d.nm).filter(n => n !== '@apralabs'), []);
});

test('a dependency cycle terminates', () => {
  // a -> b -> a. Without a visited set this recurses until the stack dies.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyc-'));
  const nm = path.join(root, 'node_modules');
  const mk = (name, deps) => {
    fs.mkdirSync(path.join(nm, name), { recursive: true });
    fs.writeFileSync(path.join(nm, name, 'package.json'), JSON.stringify({ name, dependencies: deps }));
  };
  mk('a', { b: '^1' });
  mk('b', { a: '^1' });

  const d = fakeDest();
  const pkgDir = path.join(d.nm, '@apralabs', 'cyclic');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'cyclic', dependencies: { a: '^1' } }));

  assert.doesNotThrow(() => copyMissingDeps(pkgDir, nm, d.nm));
  assert.ok(fs.existsSync(path.join(d.nm, 'a')));
  assert.ok(fs.existsSync(path.join(d.nm, 'b')));
});
