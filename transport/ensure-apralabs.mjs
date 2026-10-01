import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findApralabsSource() {
  const fleetLocal = path.join(os.homedir(), '.apra-fleet', 'node_modules', '@apralabs');
  if (
    fs.existsSync(fleetLocal) &&
    fs.existsSync(path.join(fleetLocal, 'apra-fleet-workflow'))
  ) {
    return { scope: fleetLocal };
  }

  // npm global prefix — where `npm install -g @apralabs/apra-fleet` lands.
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const npmGlobal = path.join(prefix, 'node_modules', '@apralabs');
    if (
      fs.existsSync(npmGlobal) &&
      fs.existsSync(path.join(npmGlobal, 'apra-fleet-workflow'))
    ) {
      return { scope: npmGlobal };
    }

    // Monorepo layout: the workflow package lives inside apra-fleet/packages/.
    const monorepo = path.join(npmGlobal, 'apra-fleet', 'packages');
    if (fs.existsSync(path.join(monorepo, 'apra-fleet-workflow'))) {
      return { monorepo };
    }
  } catch {
    // npm not available or errored — skip this source.
  }

  // Same monorepo check under ~/.apra-fleet.
  const localMonorepo = path.join(fleetLocal, 'apra-fleet', 'packages');
  if (fs.existsSync(path.join(localMonorepo, 'apra-fleet-workflow'))) {
    return { monorepo: localMonorepo };
  }

  return null;
}

/**
 * Copy a package's missing dependencies out of a global install.
 *
 * npm hoists: a package's dependencies normally sit in the root `node_modules`,
 * not inside the package. So copying a package directory alone produces one
 * that cannot resolve its own imports — the failure surfaces much later, as
 * `Cannot find package 'ajv' imported from .../apra-fleet-workflow/...`.
 *
 * Only what is actually declared is copied, and only when it is missing.
 * Copying the whole global tree would also work and would be wrong: it is slow,
 * and it can shadow versions npm resolved deliberately.
 *
 * Best effort throughout. Fleet is optional, and a dependency that cannot be
 * found degrades the workflow tests rather than taking down a host that was
 * starting perfectly well without Fleet at all.
 *
 * @param {string} pkgDir      the copied package, in the destination tree
 * @param {string} globalRoot  the global `node_modules` to copy from
 * @param {string} destRoot    the destination `node_modules`
 */
export function copyMissingDeps(pkgDir, globalRoot, destRoot, seen = new Set()) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return;   // no manifest, nothing declared, nothing to do
  }

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (seen.has(name)) continue;    // a -> b -> a would otherwise recurse forever
    seen.add(name);

    const dest = path.join(destRoot, name);
    // Already there: npm resolved it, and we are filling gaps rather than
    // taking over. Overwriting could downgrade something the lockfile pinned.
    if (fs.existsSync(dest)) continue;

    // Nested first — npm puts a dependency there when the hoisted version
    // conflicts, and that copy is the one this package is meant to see.
    const nested = path.join(pkgDir, 'node_modules', name);
    const hoisted = path.join(globalRoot, name);
    const src = fs.existsSync(nested) ? nested : hoisted;
    if (!fs.existsSync(src)) continue;

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      copyMissingDeps(dest, globalRoot, destRoot, seen);
    } catch {
      // Leave it; the import that needs it will say so more usefully than we can.
    }
  }
}

export function ensureApralabs() {
  const destDir = path.join(repoRoot, 'node_modules');
  const scopeDest = path.join(destDir, '@apralabs');

  if (fs.existsSync(path.join(scopeDest, 'apra-fleet-workflow'))) {
    return;
  }

  const src = findApralabsSource();
  if (!src) {
    throw new Error(
      'Cannot resolve @apralabs/apra-fleet-workflow. Install Fleet (see README) or run: docker compose run --rm fleet node --test tests/demo.test.mjs',
    );
  }

  fs.mkdirSync(scopeDest, { recursive: true });

  if (src.scope) {
    let destIsSymlink = false;
    try { destIsSymlink = fs.lstatSync(scopeDest).isSymbolicLink(); } catch {}

    if (destIsSymlink) {
      let destIsCorrect = false;
      try { destIsCorrect = fs.realpathSync(scopeDest) === fs.realpathSync(src.scope); } catch {}
      if (destIsCorrect) return;
      fs.rmSync(scopeDest, { recursive: true, force: true });
      fs.symlinkSync(src.scope, scopeDest, 'junction');
      return;
    }

    // Real directory (npm-installed). Fill in any packages npm dropped
    // (the file: dependency hoisting bug) without nuking what's there.
    const needed = ['apra-fleet', 'apra-fleet-workflow', 'apra-fleet-client'];
    let allPresent = true;
    for (const pkg of needed) {
      if (!fs.existsSync(path.join(scopeDest, pkg))) {
        allPresent = false;
        const srcPkg = path.join(src.scope, pkg);
        if (fs.existsSync(srcPkg)) {
          const pkgDest = path.join(scopeDest, pkg);
          fs.cpSync(srcPkg, pkgDest, { recursive: true });
          // npm hoists, so the package's own dependencies are not inside it.
          // Without this the copy lands unable to resolve its imports —
          // `Cannot find package 'ajv' imported from apra-fleet-workflow`.
          copyMissingDeps(pkgDest, path.dirname(src.scope), destDir);
        }
      }
    }
    if (allPresent) return;
    if (fs.existsSync(path.join(scopeDest, 'apra-fleet-workflow'))) return;

    // Nothing useful — replace with symlink.
    fs.rmSync(scopeDest, { recursive: true, force: true });
    fs.symlinkSync(src.scope, scopeDest, 'junction');
  } else {
    // Monorepo layout: symlink each package individually.
    const pkgs = fs.readdirSync(src.monorepo).filter(
      (name) => fs.statSync(path.join(src.monorepo, name)).isDirectory(),
    );
    for (const pkg of pkgs) {
      const pkgDest = path.join(scopeDest, pkg);
      const pkgSrc = path.join(src.monorepo, pkg);
      let correct = false;
      try {
        correct = fs.existsSync(pkgDest) && fs.realpathSync(pkgDest) === fs.realpathSync(pkgSrc);
      } catch {
        correct = false;
      }
      if (!correct) {
        fs.rmSync(pkgDest, { recursive: true, force: true });
        fs.symlinkSync(pkgSrc, pkgDest, 'junction');
      }
    }
  }
}
