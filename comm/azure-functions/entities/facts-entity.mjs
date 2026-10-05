// comm/azure-functions/entities/facts-entity.mjs
//
// Long-term facts for one person, held in the task hub as an entity.
//
// This is the weakest fit of the three and the spec says so plainly: facts need
// a real query (kind x tags x state, plus count and purge sweeps), so every
// recall loads the whole entity state to filter it in memory. `maxEntries`
// (500 by default) is what keeps that bounded, and it is load-bearing here in a
// way it is not for sqlite.
//
// The filtering below must match host/memory/store/sqlite.mjs `query()`
// exactly. If it drifts, a run recalls different facts on Azure than on a VM
// and reasons differently, with nothing to indicate why.

import { scrub } from '../../../host/checkpoint/record.mjs';

const DEFAULT_MAX_ENTRIES = 500;

const entries = (state) => state?.entries ?? [];

export const factsOps = {
  /**
   * Insert or replace by id.
   *
   * At the cap this refuses rather than throwing — the long-term tier logs and
   * skips, and an entity that threw would fail the whole orchestration over a
   * fact nobody needed.
   */
  store(state, entry, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    const current = entries(state);
    const existing = current.findIndex(e => e.id === entry.id);

    if (existing === -1 && maxEntries && current.length >= maxEntries) {
      return { ok: false, reason: 'at_cap', state: state ?? { entries: current } };
    }

    const clean = scrub(entry);
    const next = existing === -1
      ? [...current, clean]
      : current.map((e, i) => (i === existing ? clean : e));
    return { ok: true, state: { ...(state ?? {}), entries: next } };
  },

  /** Same predicates, same order, same limit placement as the sqlite store. */
  query(state, { kinds, tags, states, query: textQuery, limit } = {}) {
    let results = entries(state);
    if (kinds?.length) results = results.filter(e => kinds.includes(e.kind));
    if (states?.length) results = results.filter(e => states.includes(e.state));
    if (textQuery) results = results.filter(e => String(e.text ?? '').includes(textQuery));
    // Any-of, not all-of — matching the sqlite adapter's `tags.some(...)`.
    if (tags?.length) results = results.filter(e => (e.tags ?? []).some(t => tags.includes(t)));
    results = [...results].sort((a, b) => (b.retrievalStrength ?? 0) - (a.retrievalStrength ?? 0));
    // After the sort, so a limit returns the strongest rather than an arbitrary slice.
    return limit ? results.slice(0, limit) : results;
  },

  get(state, id) {
    return entries(state).find(e => e.id === id) ?? null;
  },

  update(state, { id, patch }) {
    const next = entries(state).map(e => (e.id === id ? { ...e, ...scrub(patch) } : e));
    return { ...(state ?? {}), entries: next };
  },

  remove(state, id) {
    const current = entries(state);
    const next = current.filter(e => e.id !== id);
    return { removed: current.length - next.length, state: { ...(state ?? {}), entries: next } };
  },

  /** With no predicate this removes nothing, exactly as the sqlite store does. */
  purge(state, { states, olderThan } = {}) {
    if (!states?.length && !olderThan) return { removed: 0, state: state ?? { entries: [] } };
    const current = entries(state);
    const next = current.filter((e) => {
      const stateMatches = states?.length ? states.includes(e.state) : true;
      const ageMatches = olderThan ? String(e.createdAt ?? '') < olderThan : true;
      return !(stateMatches && ageMatches);
    });
    return { removed: current.length - next.length, state: { ...(state ?? {}), entries: next } };
  },

  count(state, { kinds, states } = {}) {
    let results = entries(state);
    if (kinds?.length) results = results.filter(e => kinds.includes(e.kind));
    if (states?.length) results = results.filter(e => states.includes(e.state));
    return results.length;
  },
};

const READ_OPS = new Set(['query', 'get', 'count']);
/** Ops that answer *and* mutate, so the wrapper must do both. */
const WRITE_AND_RETURN_OPS = new Set(['store', 'remove', 'purge']);

export function registerFactsEntity(df) {
  df.app.entity('facts', (context) => {
    const op = context.df.operationName;
    const state = context.df.getState(() => null);
    const input = context.df.getInput();

    if (!Object.hasOwn(factsOps, op)) {
      throw new Error(`facts entity: unknown operation "${op}"`);
    }
    if (READ_OPS.has(op)) {
      context.df.return(factsOps[op](state, input ?? {}));
      return;
    }
    if (WRITE_AND_RETURN_OPS.has(op)) {
      const result = op === 'store'
        ? factsOps.store(state, input?.entry, input?.options ?? {})
        : factsOps[op](state, input);
      context.df.setState(result.state);
      const { state: _omitted, ...answer } = result;
      context.df.return(answer);
      return;
    }
    context.df.setState(factsOps[op](state, input));
  });
}
