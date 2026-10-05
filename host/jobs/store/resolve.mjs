// host/jobs/store/resolve.mjs
//
// `store.kind: 'auto'` — the right store for wherever this is running.
//
// The common case should need no decision. On a VM, jobs belong in SQLite; on
// Azure Functions, the task hub already *is* the store, and standing a second
// one beside it means two places to look and two things to purge.
//
// An adopter who does have an opinion sets `kind` explicitly, and that always
// wins — including asking for Cosmos on Functions.

export const STORE_KINDS = ['auto', 'memory', 'sqlite', 'cosmos', 'taskhub'];

// What `auto` means, per backend. `taskhub` is not a store module: it is the
// absence of one, and the durable backend reads its state from the
// orchestration's own output.
const AUTO = {
  'in-process': 'sqlite',
  durable: 'taskhub',
};

/**
 * @param {object} store    the `dispatch.store` block
 * @param {string} backend  'in-process' | 'durable'
 * @returns {{kind: string, resolvedFrom: 'auto'|'explicit', dbPath?: string}}
 */
export function resolveStoreKind(store = {}, backend = 'in-process') {
  const requested = store.kind ?? 'auto';

  if (!STORE_KINDS.includes(requested)) {
    throw new Error(`dispatch.store.kind must be one of ${STORE_KINDS.join(', ')}, got "${requested}"`);
  }

  if (requested !== 'auto') {
    // `taskhub` on the in-process backend is a configuration that cannot work
    // — there is no task hub — and failing loudly beats falling back to SQLite
    // and leaving somebody to discover their jobs are not where they expected.
    if (requested === 'taskhub' && backend !== 'durable') {
      throw new Error('dispatch.store.kind "taskhub" requires dispatch.backend "durable"');
    }
    return { ...store, kind: requested, resolvedFrom: 'explicit' };
  }

  const resolved = AUTO[backend];
  if (!resolved) throw new Error(`cannot resolve store.kind "auto" for unknown backend "${backend}"`);

  return { ...store, kind: resolved, resolvedFrom: 'auto' };
}

/**
 * Build the store for a resolved kind.
 *
 * `cosmos` is imported lazily and only when actually selected, so a clone that
 * never uses it never loads `@azure/cosmos` — and never needs it installed.
 */
export async function createStore(store, backend = 'in-process') {
  const resolved = resolveStoreKind(store, backend);

  switch (resolved.kind) {
    case 'memory': {
      const { createMemoryStore } = await import('./memory.mjs');
      return createMemoryStore();
    }
    case 'sqlite': {
      const { createSqliteStore } = await import('./sqlite.mjs');
      return createSqliteStore({ dbPath: resolved.dbPath });
    }
    case 'cosmos': {
      const { createCosmosStore } = await import('./cosmos.mjs');
      return createCosmosStore(resolved);
    }
    case 'taskhub':
      // The durable backend does not take a store. Asking for one here is a
      // wiring mistake worth naming rather than returning null for.
      throw new Error('store kind "taskhub" has no store module — the durable backend reads its own task hub');
    default:
      throw new Error(`unsupported store kind "${resolved.kind}"`);
  }
}
