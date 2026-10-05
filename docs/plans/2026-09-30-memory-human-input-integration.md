# Memory and Human Input Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `host/memory/run-state.mjs` and `host/human-input/snapshot.mjs` into one checkpoint record with one writer, stored in the memory store, so no fact is persisted twice.

**Architecture:** A new `host/checkpoint/` module owns the record and its save/load/clear. It is backed by the memory store, whose adapter (`filesystem | sqlite | cosmos`) is already resolved per deployment. The job record and the Durable orchestration output keep only `pendingBatchId` — a pointer, never state. `rebuildFromHistory` moves across unchanged and still governs: the checkpoint is a cache, history is the truth.

**Tech Stack:** Node 22 (≥22.16), ESM, `node:test`, `node:sqlite`, Zod v4, Express 5, `@azure/functions` v4 + `durable-functions` v3 (optional, lazy).

**Spec:** `docs/specs/2026-09-29-memory-human-input-integration-spec.md`

## Global Constraints

- Node `>=22.16`. `node:sqlite` via `DatabaseSync` only.
- **Terminology.** "Checkpoint" is the merged record. The words "snapshot" and "run-state" refer only to the two things being retired; after Task 9 neither should appear as a live concept.
- **`humanInput` requires `memory`.** Two failure points, both fatal: config says `humanInput` on with `memory` off (Task 8), and `memory` configured but failing to start while `humanInput` is on (Task 8).
- **History is never ring-buffered.** `ringEvents()` stays confined to the Azure `customStatus` view.
- **No credential is ever written to a checkpoint.** `scrub()` and the `identity` allow-list move across unchanged.
- **Learning rule, both clauses required:** `askedBy ∈ {tool, agent}` **AND** `kind ≠ 'approval'`.
- **`rebuildFromHistory` must keep passing its disposability test** — delete the checkpoint, rebuild from history, identical resume.
- Errors are values inside tools and the run loop. Only `AbortSignal` cancellation throws.
- `test:host`, `test:phase2`, `test:phase4`, `test:chat`, `test:eval`, `test:human-input`, `test:unit` and `tests/kit-conformance.test.mjs` keep passing after every task.
- Base is `feature/durable-human-input` @ `29cc74a` (PR #63). Cut the working branch from it.
- **Commits:** no AI attribution lines, ever. Each "Commit" step means stage the listed files, show `git status`, and commit **only after the user approves**. Never push to `main`.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each has its test named in the task that owns the code.

1. **Memory store unreachable mid-run.** `checkpoint.save()` fails on step 4 of 9. The run must continue — a failed checkpoint is degraded crash-recovery, not a failed run — but a failed *pause* must settle `failed`, because an unsaved pause is a question nobody will answer. Task 2 and Task 6.
2. **Checkpoint written by an older kit version.** `version` mismatch must refuse and fall back to `rebuildFromHistory`, never coerce. Resuming on a misread cursor re-executes completed work. Task 1 (refusal) and Task 6 (the fallback).
3. **`recalledFacts` grows without bound.** A long run recalls on every iteration. The checkpoint must not accumulate duplicates or grow past what a store row can hold. Task 5.
4. **Answer arrives after the memory store was wiped.** `pendingBatchId` is on the job record but the checkpoint is gone. Resume must rebuild from history and continue, not 500. Task 6.
5. **Two runs share a `taskKey`.** `taskKey` is `task.id ?? task.goal`; two jobs with the same goal and no id collide on one checkpoint row. Task 1 must key on something unique or reject the collision.
6. **Memory configured but unreachable at startup, with `humanInput` on.** The configuration is *correct*, so nobody is looking for a mistake — the store is simply down. Today this warns and continues; under this spec the host must refuse to start, because the first pause hours later has nowhere to go. Task 8.
7. **A real pause and resume through a real task hub.** Task 7 drives the orchestrator generator with a mock. Nothing exercises activity → Azurite → completed orchestration → new orchestration → resume. Task 12.

---

## Task dependency graph

```
Task 0   branch                                    (first)
Task 1   checkpoint record shape + taskKey         (independent)
Task 2   checkpoint save/load/clear over the store (needs 1)
Task 3   rebuildFromHistory moves across           (needs 1)
Task 4   strategies write the checkpoint           (needs 2)
Task 5   recalled facts + conversation captured    (needs 2, 4)
Task 6   jobs park/resume read the checkpoint      (needs 2, 3)
Task 7   Azure: output carries a pointer           (needs 6)
Task 8   config + startup dependency               (needs 6)
Task 9   retire run-state and snapshot             (needs 4, 6)
Task 10  learner takes answered batches            (needs 6)
Task 11  docs                                      (last)
Task 12  e2e on both targets, incl. Azurite       (needs 6, 7)
```

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Cut the working branch from the human-input branch**

```bash
git switch feature/durable-human-input
git switch -c feature/memory-human-input-integration
```

- [ ] **Step 2: Confirm the base and a green suite**

```bash
git log -1 --format='%h %s'          # expect 29cc74a
npm run test:human-input             # expect 314 pass
```

---

### Task 1: The checkpoint record

**Files:**
- Create: `host/checkpoint/record.mjs`
- Test: `tests/host-checkpoint-record.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `CHECKPOINT_VERSION` (number, `1`), `checkpointKey(task) → string`, `createCheckpointRecord(fields) → object`, `validateCheckpoint(raw) → {ok: true, checkpoint} | {ok: false, reason, detail?}`, `scrub(value) → value`.

- [ ] **Step 1: Write the failing test for the key**

Review Focus #5 lives here: `task.id ?? task.goal` collides when two jobs share a goal.

```js
// tests/host-checkpoint-record.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkpointKey, CHECKPOINT_VERSION, createCheckpointRecord, validateCheckpoint } =
  await import('../host/checkpoint/record.mjs');

test('key: an id wins, because two jobs may share a goal', () => {
  assert.equal(checkpointKey({ id: 'job-1', goal: 'plan a trip' }), 'job-1');
  assert.notEqual(
    checkpointKey({ id: 'job-1', goal: 'plan a trip' }),
    checkpointKey({ id: 'job-2', goal: 'plan a trip' }),
  );
});

test('key: a task with no id is refused rather than sharing a row', () => {
  // The old taskKey fell back to the goal. Two concurrent runs of the same
  // goal then read and wrote one checkpoint, each clobbering the other.
  assert.throws(() => checkpointKey({ goal: 'plan a trip' }), /requires an id/);
});

test('key: the id is safe to use as a memory id', () => {
  assert.throws(() => checkpointKey({ id: '../escape' }), /unsafe/);
  assert.throws(() => checkpointKey({ id: 'a/b' }), /unsafe/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-record.test.mjs`
Expected: FAIL — `Cannot find module '../host/checkpoint/record.mjs'`

- [ ] **Step 3: Write the key**

```js
// host/checkpoint/record.mjs
import { assertSafeMemoryId } from '../memory/store/interface.mjs';

export const CHECKPOINT_VERSION = 1;

/**
 * The row a run's checkpoint lives in.
 *
 * Keyed on the task id alone. The retired run-state keyed on
 * `task.id ?? task.goal`, so two concurrent runs of the same goal shared one
 * row and silently clobbered each other. A task with no id has no identity to
 * key on, and inventing one would hide the same bug.
 */
export function checkpointKey(task) {
  const id = task?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('checkpointKey requires an id on the task; a goal is not unique');
  }
  assertSafeMemoryId(id);
  return `cp-${id}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-record.test.mjs`
Expected: PASS on the three key tests.

- [ ] **Step 5: Write the failing test for the record shape**

```js
const base = () => ({
  taskKey: 'cp-job-1', jobId: 'job-1', traceId: 'tr-1',
  task: { goal: 'g' },
  agentName: 'apra-agent-kit', agentDescription: 'a travel agent',
  strategy: 'plan-execute',
  plan: { steps: ['a', 'b'], cursor: 1 },
  observations: [{ type: 'observation', tool: 'weather', args: {}, result: { ok: true } }],
  idempotencyKeys: ['weather-{}-0'],
  conversation: [{ role: 'user', content: 'hi' }],
  recalledFacts: [{ id: 'mem-1', text: 'prefers trains' }],
  budget: { iterations: 3, elapsedMs: 1200 },
  interruptions: 1,
  identity: { personId: 'p-1' },
  pendingBatchId: 'inp-1',
  workspace: { workerId: 'WORKER-1' },
});

test('record: carries the three fields the snapshot was missing', () => {
  // Resuming under a renamed agent or a different strategy changes behaviour
  // with no trace. These are as load-bearing as the plan cursor.
  const r = createCheckpointRecord(base());
  assert.equal(r.agentName, 'apra-agent-kit');
  assert.equal(r.agentDescription, 'a travel agent');
  assert.equal(r.strategy, 'plan-execute');
});

test('record: stamps its version and survives JSON', () => {
  const r = createCheckpointRecord(base());
  assert.equal(r.version, CHECKPOINT_VERSION);
  assert.deepEqual(validateCheckpoint(JSON.parse(JSON.stringify(r))).checkpoint, r);
});

test('record: interruptions persists, or maxInterruptions never trips', () => {
  assert.equal(createCheckpointRecord({ ...base(), interruptions: 7 }).interruptions, 7);
});

test('record: no credential survives', () => {
  const r = createCheckpointRecord({
    ...base(),
    task: { goal: 'g', inputs: { apiKey: 'sk-live-1' } },
    conversation: [{ headers: { Authorization: 'Bearer abc' } }],
    identity: { personId: 'p-1', accessToken: 'eyJ...', cookie: 'sid=abc' },
  });
  const json = JSON.stringify(r);
  for (const leak of ['sk-live-1', 'Bearer abc', 'eyJ...', 'sid=abc']) {
    assert.equal(json.includes(leak), false, `leaked: ${leak}`);
  }
  assert.deepEqual(r.identity, { personId: 'p-1' });
});

test('record: an incompatible version is refused, not coerced', () => {
  const res = validateCheckpoint({ version: 99, taskKey: 'cp-job-1' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'incompatible_version');
});

test('record: absent and unreadable are distinguishable', () => {
  assert.equal(validateCheckpoint(null).reason, 'absent');
  assert.equal(validateCheckpoint('nope').reason, 'unreadable');
  assert.equal(validateCheckpoint({ version: CHECKPOINT_VERSION }).reason, 'unreadable');
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-record.test.mjs`
Expected: FAIL — `createCheckpointRecord is not a function`

- [ ] **Step 7: Write the record**

Copy `scrub` and `safeIdentity` verbatim from `host/human-input/snapshot.mjs` — they are already tested and moving them unchanged keeps that coverage meaningful.

```js
// appended to host/checkpoint/record.mjs

const CREDENTIAL_KEYS = [
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'bearer',
  'authorization', 'auth', 'apikey', 'api_key', 'secret',
  'password', 'passwd', 'credential', 'credentials', 'cookie', 'sessionid',
];

const isCredentialKey = (key) => {
  const k = String(key).toLowerCase().replace(/[-_]/g, '');
  return CREDENTIAL_KEYS.some(c => k === c.replace(/[-_]/g, ''));
};

export function scrub(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map(v => scrub(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isCredentialKey(k)) continue;
    out[k] = scrub(v, seen);
  }
  return out;
}

// Allow-listed, not filtered: a filter only removes the credential shapes
// somebody thought of.
function safeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const out = {};
  if (identity.personId != null) out.personId = identity.personId;
  if (identity.tenantId != null) out.tenantId = identity.tenantId;
  return Object.keys(out).length === 0 ? null : out;
}

export function createCheckpointRecord({
  taskKey, jobId = null, traceId = null, kitVersion = null,
  task = null, agentName = null, agentDescription = null, strategy = null,
  plan = null, observations = [], idempotencyKeys = [],
  conversation = [], recalledFacts = [],
  budget = null, interruptions = 0,
  identity = null, pendingBatchId = null, workspace = null,
  writtenAt = new Date(),
} = {}) {
  return {
    version: CHECKPOINT_VERSION,
    kitVersion,
    taskKey, jobId, traceId,
    writtenAt: (writtenAt instanceof Date ? writtenAt : new Date(writtenAt)).toISOString(),
    task: scrub(task),
    agentName, agentDescription, strategy,
    plan: plan ? { steps: scrub(plan.steps ?? []), cursor: plan.cursor ?? 0 } : null,
    observations: scrub(observations),
    idempotencyKeys: [...idempotencyKeys],
    conversation: scrub(conversation),
    recalledFacts: scrub(recalledFacts),
    budget: budget ? { ...budget } : null,
    // MUST persist, or maxInterruptions resets on every resume and never trips.
    interruptions,
    identity: safeIdentity(identity),
    pendingBatchId,
    workspace: workspace ? { workerId: workspace.workerId ?? null } : null,
  };
}

/**
 * Refuses rather than guesses. A checkpoint written by a different build may
 * have meant something different by the same field name, and resuming on a
 * misread cursor re-executes work that already happened.
 */
export function validateCheckpoint(raw) {
  if (raw == null) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'unreadable' };
  if (raw.version !== CHECKPOINT_VERSION) {
    return { ok: false, reason: 'incompatible_version', detail: { found: raw.version ?? null, expected: CHECKPOINT_VERSION } };
  }
  if (typeof raw.taskKey !== 'string' || !raw.taskKey) return { ok: false, reason: 'unreadable', detail: 'taskKey' };
  return {
    ok: true,
    checkpoint: {
      ...raw,
      observations: raw.observations ?? [],
      idempotencyKeys: raw.idempotencyKeys ?? [],
      conversation: raw.conversation ?? [],
      recalledFacts: raw.recalledFacts ?? [],
      interruptions: raw.interruptions ?? 0,
      plan: raw.plan ?? null,
    },
  };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-record.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 9: Commit**

```bash
git add host/checkpoint/record.mjs tests/host-checkpoint-record.test.mjs
git status
git commit -m "feat(checkpoint): one record shape for crash recovery and pause"
```

---

### Task 2: Save, load and clear over the memory store

**Files:**
- Create: `host/checkpoint/index.mjs`
- Test: `tests/host-checkpoint-store.test.mjs`

**Interfaces:**
- Consumes: `createCheckpointRecord`, `validateCheckpoint`, `checkpointKey` from Task 1.
- Produces: `createCheckpoint({ store, logger, kitVersion }) → { save(taskKey, fields) → Promise<boolean>, load(taskKey) → Promise<{ok, checkpoint?, reason?}>, clear(taskKey) → Promise<void>, hasIdempotencyKey(taskKey, key) → Promise<boolean>, addIdempotencyKey(taskKey, key) → Promise<void> }`.

The memory store contract is `['open','close','store','get','update','remove','query','purge','count']` and entries need `kind`, `text`, `source`, `tags`. The retired run-state wrapped its JSON in a `procedure` entry tagged `__run_state__`; keep that shape with the tag renamed, so the store needs no change.

- [ ] **Step 1: Write the failing test**

Review Focus #1 lives here: a store failure degrades, it does not fail the run.

```js
// tests/host-checkpoint-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createCheckpoint } = await import('../host/checkpoint/index.mjs');
const { CHECKPOINT_VERSION } = await import('../host/checkpoint/record.mjs');

function fakeStore({ failOn = null } = {}) {
  const rows = new Map();
  return {
    rows,
    async open() {}, async close() {},
    async store(e) { if (failOn === 'store') throw new Error('store down'); rows.set(e.id, e); },
    async get(id) { if (failOn === 'get') throw new Error('store down'); return rows.get(id) ?? null; },
    async update(id, patch) { rows.set(id, { ...rows.get(id), ...patch }); },
    async remove(id) { rows.delete(id); },
    async query() { return []; }, async purge() {}, async count() { return rows.size; },
  };
}

const fields = () => ({
  jobId: 'job-1', task: { goal: 'g' }, strategy: 'plan-execute',
  agentName: 'kit', plan: { steps: ['a'], cursor: 0 }, observations: [],
});

test('save then load round-trips the record', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  assert.equal(await cp.save('cp-job-1', fields()), true);

  const out = await cp.load('cp-job-1');
  assert.equal(out.ok, true);
  assert.equal(out.checkpoint.version, CHECKPOINT_VERSION);
  assert.equal(out.checkpoint.strategy, 'plan-execute');
});

test('save twice updates one row rather than creating two', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());
  await cp.save('cp-job-1', { ...fields(), plan: { steps: ['a'], cursor: 1 } });
  assert.equal(store.rows.size, 1);
  assert.equal((await cp.load('cp-job-1')).checkpoint.plan.cursor, 1);
});

test('a failed save returns false and does not throw', async () => {
  // A checkpoint is crash recovery. Losing one degrades that; it must not
  // take down a run that is otherwise fine. The caller decides what a false
  // means — see Task 6, where a failed *pause* is fatal.
  const cp = createCheckpoint({ store: fakeStore({ failOn: 'store' }), logger: { warn() {} } });
  assert.equal(await cp.save('cp-job-1', fields()), false);
});

test('a failed load reports rather than throwing', async () => {
  const cp = createCheckpoint({ store: fakeStore({ failOn: 'get' }), logger: { warn() {} } });
  const out = await cp.load('cp-job-1');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unreadable');
});

test('load of a missing checkpoint is absent, not an error', async () => {
  const cp = createCheckpoint({ store: fakeStore(), logger: { warn() {} } });
  assert.equal((await cp.load('cp-nope')).reason, 'absent');
});

test('clear removes the row', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());
  await cp.clear('cp-job-1');
  assert.equal(store.rows.size, 0);
});

test('idempotency keys survive a round trip', async () => {
  const store = fakeStore();
  const cp = createCheckpoint({ store, logger: { warn() {} } });
  await cp.save('cp-job-1', fields());
  assert.equal(await cp.hasIdempotencyKey('cp-job-1', 'weather-{}-0'), false);
  await cp.addIdempotencyKey('cp-job-1', 'weather-{}-0');
  assert.equal(await cp.hasIdempotencyKey('cp-job-1', 'weather-{}-0'), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-store.test.mjs`
Expected: FAIL — `Cannot find module '../host/checkpoint/index.mjs'`

- [ ] **Step 3: Write the module**

```js
// host/checkpoint/index.mjs
import { createCheckpointRecord, validateCheckpoint, CHECKPOINT_VERSION } from './record.mjs';

export { CHECKPOINT_VERSION, checkpointKey, scrub } from './record.mjs';

const TAG = '__checkpoint__';

/**
 * One checkpoint per run, in the memory store.
 *
 * The store adapter — filesystem, sqlite or cosmos — is resolved per
 * deployment by the memory module. Nothing here knows or cares which.
 *
 * Errors are values. A checkpoint is crash recovery: losing one degrades that
 * and must not take down a run. Callers that need a save to have succeeded
 * check the return.
 */
export function createCheckpoint({ store, logger = console, kitVersion = null } = {}) {
  if (!store) throw new Error('createCheckpoint requires a memory store');

  async function save(taskKey, fields) {
    try {
      const record = createCheckpointRecord({ ...fields, taskKey, kitVersion });
      const entry = {
        id: taskKey,
        kind: 'procedure',
        text: JSON.stringify(record),
        tags: [TAG],
        source: 'system',
        confidence: 1.0,
        metadata: { type: 'checkpoint', taskKey },
      };
      const existing = await store.get(taskKey);
      if (existing) await store.update(taskKey, { text: entry.text });
      else await store.store(entry);
      return true;
    } catch (err) {
      logger.warn?.(`[checkpoint] save failed for ${taskKey}: ${err?.message ?? err}`);
      return false;
    }
  }

  async function load(taskKey) {
    let entry;
    try {
      entry = await store.get(taskKey);
    } catch (err) {
      logger.warn?.(`[checkpoint] load failed for ${taskKey}: ${err?.message ?? err}`);
      return { ok: false, reason: 'unreadable' };
    }
    if (!entry) return { ok: false, reason: 'absent' };
    try {
      return validateCheckpoint(JSON.parse(entry.text));
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

  async function clear(taskKey) {
    try { await store.remove(taskKey); }
    catch (err) { logger.warn?.(`[checkpoint] clear failed for ${taskKey}: ${err?.message ?? err}`); }
  }

  async function hasIdempotencyKey(taskKey, key) {
    const out = await load(taskKey);
    if (!out.ok) return false;
    return (out.checkpoint.idempotencyKeys ?? []).includes(key);
  }

  async function addIdempotencyKey(taskKey, key) {
    const out = await load(taskKey);
    if (!out.ok) return;
    const keys = out.checkpoint.idempotencyKeys ?? [];
    if (keys.includes(key)) return;
    await save(taskKey, { ...out.checkpoint, idempotencyKeys: [...keys, key] });
  }

  return { save, load, clear, hasIdempotencyKey, addIdempotencyKey };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-store.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add host/checkpoint/index.mjs tests/host-checkpoint-store.test.mjs
git status
git commit -m "feat(checkpoint): save, load and clear over the memory store"
```

---

### Task 3: `rebuildFromHistory` moves across

**Files:**
- Create: `host/checkpoint/rebuild.mjs`
- Modify: `host/checkpoint/index.mjs` (re-export)
- Test: `tests/host-checkpoint-rebuild.test.mjs`

**Interfaces:**
- Consumes: `createCheckpointRecord` from Task 1.
- Produces: `rebuildFromHistory(history, { taskKey, jobId, kitVersion, now }) → checkpoint`, `resumeState(record, history, opts) → { source: 'checkpoint'|'history', state, reason? }`.

This is a **move, not a rewrite.** Copy `rebuildFromHistory` from `host/human-input/snapshot.mjs` verbatim, change its final `capture(...)` call to `createCheckpointRecord(...)`, and copy its tests across. Its behaviour is the disposability contract; changing it here would hide a regression behind a refactor.

- [ ] **Step 1: Copy the existing tests across unchanged**

```bash
cp tests/host-human-input-snapshot.test.mjs tests/host-checkpoint-rebuild.test.mjs
```

Then edit only the import lines at the top:

```js
const { capture, restore, rebuildFromHistory, resumeState, scrub } =
  await import('../host/human-input/snapshot.mjs');
```

becomes

```js
const { createCheckpointRecord: capture, validateCheckpoint, scrub } =
  await import('../host/checkpoint/record.mjs');
const { rebuildFromHistory, resumeState } = await import('../host/checkpoint/rebuild.mjs');
const restore = validateCheckpoint;
```

Then replace `SNAPSHOT_VERSION` with `CHECKPOINT_VERSION` and `record.snapshot` with `record.checkpoint` throughout, and change `res.snapshot` to `res.checkpoint`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-rebuild.test.mjs`
Expected: FAIL — `Cannot find module '../host/checkpoint/rebuild.mjs'`

- [ ] **Step 3: Move the implementation**

Copy the bodies of `rebuildFromHistory` and `resumeState` from `host/human-input/snapshot.mjs` into `host/checkpoint/rebuild.mjs`, with these changes and no others:

- `import { createCheckpointRecord } from './record.mjs';`
- the trailing `return capture({...})` becomes `return createCheckpointRecord({ ...same fields, taskKey })`
- `resumeState` reads `record.checkpoint` where it read `record.snapshot`, and returns `source: 'checkpoint'` where it returned `'snapshot'`
- `validateCheckpoint` replaces `restore`

```js
// host/checkpoint/rebuild.mjs
import { createCheckpointRecord, validateCheckpoint } from './record.mjs';

/**
 * Rebuild a checkpoint from history alone.
 *
 * This is what makes the checkpoint genuinely disposable, and it is the
 * contract the whole design rests on: nothing may live only in the
 * checkpoint. History is append-only and ordered, so the rebuild is a fold —
 * later entries win.
 */
export function rebuildFromHistory(history = [], { taskKey, jobId, kitVersion = null, now = new Date() } = {}) {
  // ... body copied verbatim from snapshot.mjs rebuildFromHistory ...
  // ending in createCheckpointRecord({ taskKey, jobId, ... })
}

/**
 * The state a run resumes with: the loaded checkpoint if it is usable, a
 * rebuild from history otherwise.
 *
 * Takes the *loaded* checkpoint rather than reading it off the job record.
 * After Task 6 the record carries only a pointer, so there is nothing on it to
 * read — the caller loads from the store and hands the result here.
 */
export function resumeState(loaded, history, { kitVersion = null, now = new Date(), taskKey, jobId } = {}) {
  if (loaded?.ok) return { source: 'checkpoint', state: loaded.checkpoint };
  return {
    source: 'history',
    reason: loaded?.reason ?? 'absent',
    state: rebuildFromHistory(history, { taskKey, jobId, kitVersion, now }),
  };
}
```

Re-export from `host/checkpoint/index.mjs`:

```js
export { rebuildFromHistory, resumeState } from './rebuild.mjs';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-rebuild.test.mjs`
Expected: PASS, 19 tests — the same count as the snapshot file it came from. **A lower count means a test was lost in the move; find it before continuing.**

- [ ] **Step 5: Commit**

```bash
git add host/checkpoint/rebuild.mjs host/checkpoint/index.mjs tests/host-checkpoint-rebuild.test.mjs
git status
git commit -m "feat(checkpoint): move rebuildFromHistory across unchanged"
```

---

### Task 4: The strategies write the checkpoint

**Files:**
- Modify: `host/strategies/plan-execute.mjs:95-135` (checkpoint load), `:117` (save), `:262` (idempotency)
- Modify: `host/strategies/open-ended.mjs`
- Test: `tests/host-checkpoint-strategies.test.mjs`

**Interfaces:**
- Consumes: `createCheckpoint` from Task 2.
- Produces: both strategies accept `checkpoint` in place of `memory.runState`; `open-ended` gains checkpoint saving it never had.

`plan-execute` currently calls `memory.runState.load/save/hasIdempotencyKey`. Swap the object; the call shapes are deliberately identical so the diff is small.

- [ ] **Step 1: Write the failing test**

```js
// tests/host-checkpoint-strategies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { createOpenEndedStrategy } = await import('../host/strategies/open-ended.mjs');

function recordingCheckpoint() {
  const saves = [];
  return {
    saves,
    save: async (key, fields) => { saves.push({ key, fields }); return true; },
    load: async () => ({ ok: false, reason: 'absent' }),
    clear: async () => {},
    hasIdempotencyKey: async () => false,
    addIdempotencyKey: async () => {},
  };
}

const call = (tool) => '```tool_call\n' + JSON.stringify({ tool, args: {} }) + '\n```';
const done = () => '```done\n{"result":"ok","summary":"s"}\n```';

test('open-ended checkpoints after each observation', async () => {
  // It never did. A crash mid-run lost everything, because only plan-execute
  // had run-state.
  const checkpoint = recordingCheckpoint();
  const tools = [{ name: 't', reversible: true, run: async () => 'ok' }];
  const strat = createOpenEndedStrategy({
    task: { id: 'job-1', goal: 'g' }, tools, checkpoint,
    agentName: 'kit', strategy: 'open-ended',
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [call('t'), done()] }),
  });
  for await (const _ of strat.iterate()) { /* drain */ }

  assert.ok(checkpoint.saves.length >= 1, 'at least one checkpoint written');
  assert.equal(checkpoint.saves[0].key, 'cp-job-1');
  assert.equal(checkpoint.saves[0].fields.strategy, 'open-ended');
  assert.equal(checkpoint.saves[0].fields.agentName, 'kit');
});

test('open-ended survives a checkpoint store that is down', async () => {
  // Review Focus #1: degraded crash recovery, not a failed run.
  const checkpoint = { ...recordingCheckpoint(), save: async () => false };
  const tools = [{ name: 't', reversible: true, run: async () => 'ok' }];
  const strat = createOpenEndedStrategy({
    task: { id: 'job-1', goal: 'g' }, tools, checkpoint,
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [call('t'), done()] }),
  });

  let finished = false;
  for await (const e of strat.iterate()) if (e.type === 'done') finished = true;
  assert.equal(finished, true, 'the run completes despite an unwritable checkpoint');
});

test('a strategy with no checkpoint behaves exactly as before', async () => {
  const tools = [{ name: 't', reversible: true, run: async () => 'ok' }];
  const strat = createOpenEndedStrategy({
    task: { id: 'job-1', goal: 'g' }, tools,
    fleetApi: createMockFleetApi({ members: rosterNames(1), promptResponses: [call('t'), done()] }),
  });
  let finished = false;
  for await (const e of strat.iterate()) if (e.type === 'done') finished = true;
  assert.equal(finished, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-strategies.test.mjs`
Expected: FAIL — `checkpoint.saves.length >= 1` is false; open-ended ignores the option.

- [ ] **Step 3: Add checkpointing to open-ended**

```js
// host/strategies/open-ended.mjs — add to the destructured options
  checkpoint = null,
  strategy = 'open-ended',
```

and after `remember(...)` inside the `tool_call` branch:

```js
        remember({ type: 'observation', tool, args, result });
        // Crash recovery. A false return means the store is unreachable; the
        // run continues, because a lost checkpoint degrades recovery and does
        // not invalidate the work already done.
        if (checkpoint) {
          await checkpoint.save(checkpointKey(task), {
            jobId: task.id, task, agentName, agentDescription, strategy,
            observations, plan: null, conversation, recalledFacts: memories ?? [],
          });
        }
```

Import at the top: `import { checkpointKey } from '../checkpoint/record.mjs';`

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-strategies.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Swap plan-execute from run-state to checkpoint**

Three edits, all mechanical — the call shapes match on purpose:

```js
// :97   memory.runState.load(taskKey)            → checkpoint.load(taskKey)
//       ...and the result is now { ok, checkpoint } not the raw snapshot:
const loaded = await checkpoint.load(taskKey);
if (loaded.ok) {
  const cp = loaded.checkpoint;
  if (Number.isInteger(cp.plan?.cursor)) resumeStart = cp.plan.cursor;
  if (cp.plan?.steps) { currentPlan = { steps: cp.plan.steps }; resumePending = true; }
  for (const obs of cp.observations ?? []) remember(obs);
  idempotencyKeys = new Set(cp.idempotencyKeys ?? []);
}

// :117  memory.runState.save(taskKey, {...})     → checkpoint.save(taskKey, {...})
//       with stepIndex → plan.cursor and the three new fields added:
const saved = await checkpoint.save(taskKey, {
  jobId: task.id, task, agentName, agentDescription, strategy: 'plan-execute',
  plan: { steps: currentPlan?.steps ?? [], cursor: stepIndex },
  observations, idempotencyKeys: [...nextKeys],
  conversation, recalledFacts: memories ?? [],
});

// :262  memory.runState.hasIdempotencyKey(...)   → checkpoint.hasIdempotencyKey(...)
```

- [ ] **Step 6: Run the strategy suites**

Run: `npm run test:phase2 && node --test tests/host-checkpoint-strategies.test.mjs`
Expected: PASS — 93 + 3.

- [ ] **Step 7: Commit**

```bash
git add host/strategies/open-ended.mjs host/strategies/plan-execute.mjs tests/host-checkpoint-strategies.test.mjs
git status
git commit -m "feat(checkpoint): both strategies write one checkpoint"
```

---

### Task 5: Recalled facts and conversation are captured

**Files:**
- Modify: `host/tasks.mjs` (pass `conversationHistory`, `memories`, `agentName`, `agentDescription`, `strategy` into the strategy options)
- Test: `tests/host-checkpoint-reproducibility.test.mjs`

**Interfaces:**
- Consumes: the checkpoint from Task 2, the strategy wiring from Task 4.
- Produces: a checkpoint whose `recalledFacts` and `conversation` reproduce the prompt the original run had.

- [ ] **Step 1: Write the failing test**

Review Focus #3 lives here: recalled facts must not accumulate duplicates.

```js
// tests/host-checkpoint-reproducibility.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createCheckpointRecord } = await import('../host/checkpoint/record.mjs');

test('recalled facts are stored with id AND text', () => {
  // Ids alone are not enough: a fact deleted or edited between pause and
  // resume would silently change the prompt the run reasoned on.
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    recalledFacts: [{ id: 'mem-1', text: 'prefers trains', kind: 'preference' }],
  });
  assert.equal(r.recalledFacts[0].id, 'mem-1');
  assert.equal(r.recalledFacts[0].text, 'prefers trains');
});

test('recalled facts do not accumulate duplicates across saves', () => {
  // A long run recalls on every iteration. Appending each time grows the row
  // until it will not fit.
  const once = createCheckpointRecord({
    taskKey: 'cp-1',
    recalledFacts: [{ id: 'mem-1', text: 'a' }, { id: 'mem-1', text: 'a' }, { id: 'mem-2', text: 'b' }],
  });
  assert.equal(once.recalledFacts.length, 2, 'deduped by id');
  assert.deepEqual(once.recalledFacts.map(f => f.id), ['mem-1', 'mem-2']);
});

test('conversation is stored as it went into the prompt', () => {
  const r = createCheckpointRecord({
    taskKey: 'cp-1',
    conversation: [{ role: 'user', content: 'Paris in October' }],
  });
  assert.equal(r.conversation[0].content, 'Paris in October');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-reproducibility.test.mjs`
Expected: FAIL on the dedupe test — `recalledFacts.length` is 3.

- [ ] **Step 3: Dedupe recalled facts in the record**

```js
// host/checkpoint/record.mjs — inside createCheckpointRecord, replace
//   recalledFacts: scrub(recalledFacts),
// with:

    // Deduped by id. A long run recalls on every iteration, and appending each
    // time grows the row until it no longer fits the store.
    recalledFacts: scrub(dedupeById(recalledFacts)),
```

```js
function dedupeById(facts = []) {
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const id = f?.id;
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    out.push(f);
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-reproducibility.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Thread the fields through `tasks.mjs`**

In the `runTask` call in `executeHostedTask`, the strategy options already receive `memories` and `conversation: conversationHistory`. Add the checkpoint and identity fields alongside:

```js
        memory,
        memories,
        conversation: conversationHistory,
        askUser,
        resumeFrom,
        checkpoint,                       // built in host/index.mjs, Task 8
        agentName: runLoopConfig.agentName,
        agentDescription: runLoopConfig.agentDescription,
```

- [ ] **Step 6: Run the task suites**

Run: `npm run test:host && npm run test:phase2`
Expected: PASS — 93 and 93.

- [ ] **Step 7: Commit**

```bash
git add host/checkpoint/record.mjs host/tasks.mjs tests/host-checkpoint-reproducibility.test.mjs
git status
git commit -m "feat(checkpoint): capture recalled facts and conversation as used"
```

---

### Task 6: Park and resume read the checkpoint

**Files:**
- Modify: `host/jobs/in-process.mjs:82` (`resumeState`), `:116` (`capture`), `park()`
- Modify: `host/human-input/resume.mjs:11,82,142`
- Test: `tests/host-checkpoint-pause-resume.test.mjs`

**Interfaces:**
- Consumes: `createCheckpoint` (Task 2), `resumeState` (Task 3).
- Produces: the job record carries only `pendingInput` and `pendingBatchId`; `record.snapshot` is gone.

- [ ] **Step 1: Write the failing test**

Review Focus #1 and #4 both live here.

```js
// tests/host-checkpoint-pause-resume.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const { createInProcessJobs } = await import('../host/jobs/in-process.mjs');
const { createMemoryStore } = await import('../host/jobs/store/memory.mjs');
const { createCheckpoint } = await import('../host/checkpoint/index.mjs');

const BASE = { maxQueueSize: 10, concurrency: 1, leaseTimeoutMs: 60_000, retentionMs: 86_400_000, drainMs: 100, capacity: 1 };
const approvalQ = [{ fieldId: 'proceed', kind: 'approval', prompt: 'Go ahead?', required: true }];

function memoryBackedCheckpoint({ failSave = false } = {}) {
  const rows = new Map();
  const store = {
    async open() {}, async close() {},
    async store(e) { if (failSave) throw new Error('down'); rows.set(e.id, e); },
    async get(id) { return rows.get(id) ?? null; },
    async update(id, p) { rows.set(id, { ...rows.get(id), ...p }); },
    async remove(id) { rows.delete(id); },
    async query() { return []; }, async purge() {}, async count() { return rows.size; },
  };
  return { rows, checkpoint: createCheckpoint({ store, logger: { warn() {} } }) };
}

const askingRunner = () => ({
  runJob: async (task, { askUser }) => {
    try { await askUser({ questions: approvalQ }); }
    catch (err) {
      if (err.name !== 'PauseRequested') throw err;
      return { status: 'paused', batchId: err.batch.batchId, batch: err.batch,
               history: [], budget: null, progress: { observations: [], plan: null } };
    }
    return { status: 'completed', result: 'done', history: [], budget: null };
  },
});

const waitFor = async (jobs, id, status, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await jobs.get(id);
    if (r?.status === status) return r;
    await sleep(10);
  }
  assert.fail(`never reached ${status}`);
};

test('the job record carries a pointer, not state', async () => {
  const { checkpoint, rows } = memoryBackedCheckpoint();
  const jobs = createInProcessJobs({
    store: createMemoryStore(), runJob: askingRunner().runJob, checkpoint,
    humanInput: { enabled: true }, config: BASE, logger: { warn() {}, info() {} },
  });
  await jobs.start();
  const { jobId } = await jobs.submit({ goal: 'ask' });
  const rec = await waitFor(jobs, jobId, 'waiting_input');

  assert.equal(rec.snapshot, undefined, 'snapshot is gone from the record');
  assert.ok(rec.pendingInput, 'the batch is still on the record for the UI');
  assert.equal(rows.size, 1, 'the state is in the checkpoint store');
  await jobs.stop({ drainMs: 0 });
});

test('a pause that cannot be checkpointed settles failed', async () => {
  // Review Focus #1, the fatal half. An unsaved pause is a question nobody
  // will ever answer; continuing would be worse than failing.
  const { checkpoint } = memoryBackedCheckpoint({ failSave: true });
  const jobs = createInProcessJobs({
    store: createMemoryStore(), runJob: askingRunner().runJob, checkpoint,
    humanInput: { enabled: true }, config: BASE, logger: { warn() {}, info() {} },
  });
  await jobs.start();
  const { jobId } = await jobs.submit({ goal: 'ask' });
  const rec = await waitFor(jobs, jobId, 'failed');
  assert.equal(rec.error.code, 'pause_failed');
  await jobs.stop({ drainMs: 0 });
});

test('an answer after the checkpoint store was wiped rebuilds from history', async () => {
  // Review Focus #4. pendingBatchId is on the job record; the checkpoint is
  // gone. This must resume, not 500.
  const { checkpoint, rows } = memoryBackedCheckpoint();
  const jobs = createInProcessJobs({
    store: createMemoryStore(), runJob: askingRunner().runJob, checkpoint,
    humanInput: { enabled: true }, config: BASE, logger: { warn() {}, info() {} },
  });
  await jobs.start();
  const { jobId } = await jobs.submit({ goal: 'ask' });
  const parked = await waitFor(jobs, jobId, 'waiting_input');

  rows.clear();   // the store is wiped while the person is away

  const res = await jobs.provideInput(jobId, {
    batchId: parked.pendingInput.batchId, answers: { proceed: 'approve' },
  });
  assert.equal(res.ok, true, 'the answer is accepted');
  await waitFor(jobs, jobId, 'completed');
  await jobs.stop({ drainMs: 0 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-pause-resume.test.mjs`
Expected: FAIL — `createInProcessJobs` ignores `checkpoint`; `rec.snapshot` is still an object.

- [ ] **Step 3: Rewrite `park()` and `resumeContextFor()` in `host/jobs/in-process.mjs`**

```js
// accept the checkpoint
export function createInProcessJobs({ ..., checkpoint = null, ... }) {

// park(): write the checkpoint, put a pointer on the record
  async function park(jobId, record, outcome, askUser) {
    const taskKey = checkpointKey({ id: jobId });
    const saved = await checkpoint.save(taskKey, {
      jobId, traceId: outcome.traceId ?? null, task: record.task,
      agentName: record.metadata?.agentName ?? null,
      strategy: outcome.strategy ?? null,
      observations: outcome.progress?.observations ?? outcome.history ?? [],
      plan: outcome.progress?.plan ?? null,
      budget: outcome.budget ?? null,
      interruptions: askUser?.interruptions?.() ?? 0,
      identity: record.metadata?.identity ?? null,
      pendingBatchId: outcome.batchId,
      workspace: outcome.workspace ?? null,
    });
    // An unsaved pause is a question nobody will answer. Fail rather than
    // park a run whose state does not exist.
    if (!saved) throw new Error('checkpoint save failed');

    await store.update(jobId, {
      status: 'waiting_input',
      pendingInput: outcome.batch,
      pendingBatchId: outcome.batchId,
      history: outcome.history ?? [],
      budget: outcome.budget ?? null,
    });
    await publish(jobId, inputRequiredEvent(jobId, outcome.batch, now()));
  }

// resumeContextFor(): read the checkpoint, fall back to history
  async function resumeContextFor(jobId, record) {
    const history = await store.events(jobId);
    const answered = answeredBatchesFromHistory(history).slice(-1);

    const taskKey = checkpointKey({ id: jobId });
    const loaded = await checkpoint.load(taskKey);
    const { state, source, reason } = resumeState(loaded, history, { taskKey, jobId, kitVersion });
    if (source === 'history' && reason !== 'absent') {
      logger.warn(`[jobs] job ${jobId} rebuilt from history (${reason})`);
    }
    // ... rest unchanged, reading from `state` ...

// Import both at the top of in-process.mjs:
//   import { checkpointKey } from '../checkpoint/record.mjs';
//   import { resumeState } from '../checkpoint/rebuild.mjs';
  }
```

Delete the `capture` import and the `record.snapshot` write. `settle()` already clears `pendingInput`; add `pendingBatchId: null` beside it, and call `checkpoint.clear()` on a settle.

- [ ] **Step 4: Point `host/human-input/resume.mjs` at the new module**

```js
// was: import { resumeState } from './snapshot.mjs';
import { resumeState } from '../checkpoint/rebuild.mjs';
```

and at both call sites pass the loaded checkpoint plus `taskKey: checkpointKey({ id: record.id })` and `jobId: record.id`. `resume.mjs` now loads the checkpoint itself rather than reading `record.snapshot`.

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-pause-resume.test.mjs && npm run test:human-input`
Expected: PASS — 3 and 314.

- [ ] **Step 6: Commit**

```bash
git add host/jobs/in-process.mjs host/human-input/resume.mjs tests/host-checkpoint-pause-resume.test.mjs
git status
git commit -m "feat(checkpoint): park and resume read one checkpoint"
```

---

### Task 7: Azure — the output carries a pointer

**Files:**
- Modify: `comm/azure-functions/activity.mjs:91` (drop `capture`, write the checkpoint)
- Modify: `comm/azure-functions/orchestrator.mjs` (`guardPausedOutput` becomes an assertion)
- Modify: `host/jobs/durable.mjs` (`mapDurableStatus` reads a pointer)
- Test: `tests/host-checkpoint-durable.test.mjs`

**Interfaces:**
- Consumes: the checkpoint from Task 2, reached via `hostCtx.memory` — **verified present** at `activity.mjs:76`.
- Produces: `output = { status: 'paused', batchId, batch, checkpointKey }` — no `snapshot`, no `history`.

- [ ] **Step 1: Write the failing test**

```js
// tests/host-checkpoint-durable.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');

function run(activityOutput) {
  const customStatuses = [];
  const ctx = { df: {
    instanceId: 'job-1', currentUtcDateTime: new Date('2026-09-30T00:00:00Z'),
    getInput: () => ({ task: { goal: 'g' } }),
    setCustomStatus: (s) => customStatuses.push(structuredClone(s)),
    callActivity: () => ({ __activity: true }),
  } };
  const gen = buildOrchestrator()(ctx);
  gen.next();
  const step = gen.next(activityOutput);
  return { output: step.value, customStatuses, done: step.done };
}

test('a paused output carries a pointer, not state', () => {
  const { output, done } = run({
    status: 'paused', batchId: 'inp-1',
    batch: { batchId: 'inp-1', questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Go?' }], expiresAt: '2026-10-07T00:00:00Z' },
    checkpointKey: 'cp-job-1',
  });
  assert.equal(done, true);
  assert.equal(output.checkpointKey, 'cp-job-1');
  assert.equal('snapshot' in output, false, 'the snapshot is in the memory store now');
  assert.equal('history' in output, false);
});

test('a pause can no longer be too large to fit', () => {
  // The 16KB cap applied to the state. It now applies to a pointer, so the
  // failure this guard existed for is unreachable.
  const { output } = run({
    status: 'paused', batchId: 'inp-1',
    batch: { batchId: 'inp-1', questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Go?' }], expiresAt: '2026-10-07T00:00:00Z' },
    checkpointKey: 'cp-job-1',
  });
  assert.equal(output.status, 'paused');
  assert.notEqual(output.error?.code, 'pause_too_large');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-durable.test.mjs`
Expected: FAIL — `output.checkpointKey` is undefined.

- [ ] **Step 3: Write the checkpoint from the activity**

```js
// comm/azure-functions/activity.mjs — replace the capture(...) block
      if (run.status === 'paused' && !controller.signal.aborted) {
        const { createCheckpoint } = await import('../../host/checkpoint/index.mjs');
        const { checkpointKey } = await import('../../host/checkpoint/record.mjs');
        const taskKey = checkpointKey({ id: jobId });
        // hostCtx.memory is present — verified at host/index.mjs:347 and
        // azure-functions/main.mjs. `checkpointStore` is exposed in Task 8.
        const cp = createCheckpoint({ store: hostCtx.memory.checkpointStore, logger: hostCtx.logger });
        const saved = await cp.save(taskKey, {
          jobId, traceId: run.traceId ?? null, task,
          agentName: hostCtx.runLoopConfig?.agentName ?? null,
          strategy: run.routedTo ?? null,
          observations: run.progress?.observations ?? [],
          plan: run.progress?.plan ?? null,
          budget: run.budget ?? null,
          interruptions: askUser?.interruptions?.() ?? 0,
          identity: input.metadata?.identity ?? null,
          pendingBatchId: run.batchId,
        });
        if (!saved) {
          return { status: 'failed', result: null,
                   error: { code: 'pause_failed', message: 'the checkpoint could not be written; the question would never be answered' } };
        }
        return { status: 'paused', batchId: run.batchId, batch: run.batch, checkpointKey: taskKey, routedTo: run.routedTo ?? null };
      }
```

- [ ] **Step 4: Turn `guardPausedOutput` into an assertion**

```js
// comm/azure-functions/orchestrator.mjs
/**
 * The paused output is a pointer now, so it cannot realistically exceed the
 * 16 KB Durable cap. This stays as an assertion rather than a path: if it ever
 * fires, something has started putting state back in the output.
 */
function guardPausedOutput(output, jobId) {
  const json = JSON.stringify(output);
  if (json.length <= DURABLE_PAYLOAD_MAX_CHARS) return output;
  return {
    status: 'failed', result: null,
    error: { code: 'pause_too_large',
             message: `job ${jobId} paused with ${json.length} characters of output; a paused output must be a pointer, not state` },
  };
}
```

- [ ] **Step 5: Read the pointer in `mapDurableStatus`**

```js
// host/jobs/durable.mjs — in the rt === 'Completed' && output.status === 'paused' branch
      out.pendingInput = instance.output.batch ?? null;
      out.pendingBatchId = instance.output.batchId ?? null;
      out.checkpointKey = instance.output.checkpointKey ?? null;
      out.result = null;
      out.error = null;
```

- [ ] **Step 6: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-durable.test.mjs && node --test tests/host-human-input-durable.test.mjs`
Expected: PASS — 2 and 27.

- [ ] **Step 7: Commit**

```bash
git add comm/azure-functions/activity.mjs comm/azure-functions/orchestrator.mjs host/jobs/durable.mjs tests/host-checkpoint-durable.test.mjs
git status
git commit -m "feat(checkpoint): the Durable output carries a pointer, not state"
```

---

### Task 8: Configuration and the startup dependency

**Files:**
- Modify: `host/config.mjs` (the `humanInput` block)
- Modify: `host/index.mjs:196-207` (the memory start catch), and build the checkpoint
- Test: `tests/host-checkpoint-config.test.mjs`

**Interfaces:**
- Consumes: `createCheckpoint` (Task 2).
- Produces: `startHost` throws when `humanInput` is on and memory is absent or failed.

- [ ] **Step 1: Write the failing test**

Both failure points from spec §8.

```js
// tests/host-checkpoint-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveHumanInputConfig, assertHumanInputDependencies } = await import('../host/config.mjs');

test('config: humanInput without memory is a startup error, not a warning', () => {
  // A warning defers the failure to the first question, days into a
  // deployment, on the one path that cannot degrade gracefully.
  assert.throws(
    () => assertHumanInputDependencies({ humanInput: { enabled: true }, memory: { enabled: false }, dispatch: { enabled: true } }),
    /humanInput requires memory/,
  );
});

test('config: humanInput without dispatch still errors, as before', () => {
  assert.throws(
    () => assertHumanInputDependencies({ humanInput: { enabled: true }, memory: { enabled: true }, dispatch: { enabled: false } }),
    /dispatch/,
  );
});

test('config: humanInput off requires nothing', () => {
  assert.doesNotThrow(() => assertHumanInputDependencies({ humanInput: { enabled: false } }));
});

test('runtime: memory that fails to start is fatal when humanInput is on', () => {
  // The configuration is correct, so nobody is looking for a mistake. The
  // store is simply unreachable.
  assert.throws(
    () => assertHumanInputDependencies(
      { humanInput: { enabled: true }, memory: { enabled: true }, dispatch: { enabled: true } },
      { memoryStarted: false },
    ),
    /memory module failed to start/,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-config.test.mjs`
Expected: FAIL — `assertHumanInputDependencies is not a function`

- [ ] **Step 3: Write the assertion**

```js
// host/config.mjs
/**
 * Human input has no graceful degrade. A paused run needs somewhere to put a
 * checkpoint and something to park on; without either, the failure surfaces at
 * the first question rather than at startup.
 *
 * Called twice: once on the config, once after the memory module has actually
 * opened — the second is the sharper case, because the configuration is right
 * and only the store is unreachable.
 */
export function assertHumanInputDependencies(modules, { memoryStarted = true } = {}) {
  if (!modules?.humanInput?.enabled) return;

  if (!modules.dispatch?.enabled) {
    throw new Error('humanInput requires dispatch — there is nowhere to park a paused run on the synchronous /task?wait=true path');
  }
  if (modules.memory?.enabled === false || !modules.memory) {
    throw new Error('humanInput requires memory — a paused run stores its checkpoint in the memory store; enable modules.memory or disable modules.humanInput');
  }
  if (!memoryStarted) {
    throw new Error('memory module failed to start and humanInput is enabled — a paused run would have nowhere to store its checkpoint; fix the memory store or disable modules.humanInput');
  }
}
```

Call it from `validate()` after the modules are resolved, replacing the existing `humanInput`-without-`dispatch` warning.

- [ ] **Step 4: Make the memory start catch fatal when human input is on**

```js
// host/index.mjs — in the catch at :202
    } catch (err) {
      logger.warn(`[host] memory module failed to start: ${err?.message ?? err}`);
      try { await memory?.close(); } catch { /* memory failures never halt the host */ }
      memory = null;
    }
  }
  // Fatal only when human input is on; otherwise memory stays a graceful degrade.
  assertHumanInputDependencies(config.modules, { memoryStarted: memory !== null });

  const checkpoint = memory
    ? createCheckpoint({ store: memory.checkpointStore, logger: logger.child('checkpoint'), kitVersion: (await kitInfo()).version })
    : null;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-config.test.mjs && npm run test:host`
Expected: PASS — 4 and 93.

- [ ] **Step 6: Commit**

```bash
git add host/config.mjs host/index.mjs tests/host-checkpoint-config.test.mjs
git status
git commit -m "feat(checkpoint): humanInput requires memory, at config and at startup"
```

---

### Task 9: Retire run-state and snapshot

**Files:**
- Delete: `host/memory/run-state.mjs`, `host/human-input/snapshot.mjs`
- Modify: `host/memory/index.mjs` (drop the `runState` branch), `host/human-input/index.mjs` (drop the snapshot exports), `host/tasks.mjs:373`
- Delete: `tests/host-human-input-snapshot.test.mjs` (superseded by `tests/host-checkpoint-rebuild.test.mjs`)
- Test: `tests/kit-conformance.test.mjs` (update the two snapshot assertions)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: one persistence layer. `grep -r "runState\|snapshot\.mjs"` returns nothing outside history.

- [ ] **Step 1: Verify nothing still references the retired modules**

```bash
grep -rn "runState\|human-input/snapshot" --include=*.mjs host/ comm/ mcp/ tests/ | grep -v "^tests/host-checkpoint"
```

Expected: only `host/memory/index.mjs` and `host/tasks.mjs:373`, both fixed in Step 2.

- [ ] **Step 2: Expose the checkpoint store from the memory module**

The retired `runState` branch resolved its own store and kept it private. The
checkpoint needs one, so the same resolution moves up and is exposed under a
name that says what it is now. The config block renames with it.

```js
// host/memory/index.mjs — replacing the `const rs = memoryConfig?.runState?.enabled ...` block

  // Backs the run checkpoint. The adapter — filesystem, sqlite or cosmos — is
  // the deployment's choice; nothing above this line knows which.
  const cpConfig = memoryConfig?.checkpoint ?? memoryConfig?.runState ?? {};
  const checkpointStore = cpConfig.enabled === false
    ? null
    : await resolveStore(cpConfig);

  // ... and add `checkpointStore` to the returned object, dropping `runState`.
```

`memory.checkpoint` is the config block's new name; `memory.runState` is still
read so an existing config keeps working, and `host/config.mjs:135`'s warning
text changes from `memory.runState` to `memory.checkpoint`.

- [ ] **Step 3: Remove the last two call sites**

```js
// host/memory/index.mjs — delete the `const rs = memoryConfig?.runState?.enabled ...` block
//                         and the `runState: rs` key from the returned object.

// host/tasks.mjs:373 — replace
//   await memory.runState.clear(fullTask.id ?? task.id ?? task.goal);
// with
      await checkpoint?.clear(checkpointKey({ id: fullTask.id ?? task.id }));
```

- [ ] **Step 4: Delete the retired files**

```bash
git rm host/memory/run-state.mjs host/human-input/snapshot.mjs tests/host-human-input-snapshot.test.mjs
```

- [ ] **Step 5: Update the two conformance assertions**

`tests/kit-conformance.test.mjs` has `conformance: no credential survives a snapshot` and `conformance: an incompatible snapshot is refused, not coerced`. Change their imports to `../host/checkpoint/record.mjs`, `capture` to `createCheckpointRecord`, `restore` to `validateCheckpoint`, and add `taskKey: 'cp-job-1'` to the record calls. **The assertions themselves do not change** — they are the contract, not the implementation.

- [ ] **Step 6: Run everything**

```bash
npm run test:human-input && npm run test:host && npm run test:phase2 \
  && npm run test:phase4 && npm run test:chat && npm run test:eval \
  && npm run test:unit && node --test tests/kit-conformance.test.mjs
```

Expected: all pass. `test:human-input` should be **314 minus 19 plus the new checkpoint tests** — count it and make sure the drop is exactly the 19 moved in Task 3.

- [ ] **Step 7: Commit**

```bash
git add -A
git status
git commit -m "refactor(checkpoint): retire run-state and snapshot"
```

---

### Task 10: The learner takes answered batches

**Files:**
- Modify: `host/memory/learner.mjs` (accept an `answers` block)
- Modify: `host/tasks.mjs` (pass answered batches on settle)
- Test: `tests/host-checkpoint-learning.test.mjs`

**Interfaces:**
- Consumes: history from the jobs backend.
- Produces: `learnableAnswers(history) → [{ prompt, answer }]`, used by `createLearner().extract({ ..., answers })`.

- [ ] **Step 1: Write the failing test**

The safety rule from spec §3, both clauses.

```js
// tests/host-checkpoint-learning.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { learnableAnswers } = await import('../host/memory/learner.mjs');
const rec = await import('../host/jobs/record.mjs');

const batch = (over) => ({
  batchId: 'inp-1', jobId: 'job-1', askedBy: 'tool',
  questions: [{ fieldId: 'pace', kind: 'pick_one', prompt: 'How full should the days be?' }],
  askedAt: '2026-09-30T00:00:00Z', staleAfter: '2026-10-01T00:00:00Z', expiresAt: '2026-10-07T00:00:00Z',
  ...over,
});

const answered = (b, answers) => [
  rec.questionAskedEntry('job-1', { batch: b }),
  rec.answerReceivedEntry('job-1', { batchId: b.batchId, answers, answeredBy: 'p-1' }),
];

test('a tool question is learnable', () => {
  const out = learnableAnswers(answered(batch(), { pace: 'relaxed' }));
  assert.equal(out.length, 1);
  assert.equal(out[0].prompt, 'How full should the days be?');
  assert.equal(out[0].answer, 'relaxed');
});

test('a guardrail question is never learnable', () => {
  const b = batch({ askedBy: 'guardrail', questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' }] });
  assert.deepEqual(learnableAnswers(answered(b, { proceed: 'approve' })), []);
});

test('a TOOL-raised approval is never learnable either', () => {
  // The clause that matters. Nothing stops a tool raising an approval
  // question, and askedBy alone would let a standing permission through.
  const b = batch({ askedBy: 'tool', questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' }] });
  assert.deepEqual(learnableAnswers(answered(b, { proceed: 'approve' })), []);
});

test('a mixed batch learns the preferences and drops the approval', () => {
  const b = batch({ askedBy: 'agent', questions: [
    { fieldId: 'pace', kind: 'pick_one', prompt: 'How full?' },
    { fieldId: 'proceed', kind: 'approval', prompt: 'Book it?' },
  ] });
  const out = learnableAnswers(answered(b, { pace: 'relaxed', proceed: 'approve' }));
  assert.deepEqual(out.map(a => a.answer), ['relaxed']);
});

test('an unanswered batch contributes nothing', () => {
  assert.deepEqual(learnableAnswers([rec.questionAskedEntry('job-1', { batch: batch() })]), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/host-checkpoint-learning.test.mjs`
Expected: FAIL — `learnableAnswers is not a function`

- [ ] **Step 3: Write it**

```js
// host/memory/learner.mjs
/**
 * The answers a run may learn from.
 *
 * Both clauses are load-bearing. `askedBy` excludes the safety layer; `kind`
 * closes the case where a *tool* raises an approval question of its own, which
 * nothing in the kit prevents.
 *
 * A remembered approval is a guardrail that silently stopped working.
 * Permission is per-action and per-moment: somebody who approved one booking
 * has not approved the next one.
 */
export function learnableAnswers(history = []) {
  const batches = new Map();
  const out = [];

  for (const e of history) {
    if (e.type === 'question_asked') batches.set(e.batch?.batchId, e.batch);
    if (e.type !== 'answer_received') continue;

    const batch = batches.get(e.batchId);
    if (!batch || batch.askedBy === 'guardrail') continue;

    for (const q of batch.questions ?? []) {
      if (q.kind === 'approval') continue;
      const answer = e.answers?.[q.fieldId];
      if (answer === undefined) continue;
      out.push({
        prompt: q.prompt,
        // Plain language by contract (no identifiers), so this is already fit
        // to store as a fact.
        answer: typeof answer === 'object' && answer !== null && 'other' in answer
          ? answer.other
          : answer,
      });
    }
  }
  return out;
}
```

Add an `answers` block to `LEARNER_PROMPT` and `buildPrompt`, placed above the observation history because it is higher signal:

```
Answers the person gave when asked:
{{ANSWERS}}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/host-checkpoint-learning.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Pass answered batches on settle, except on cancel**

```js
// host/tasks.mjs — inside the `if (result.status !== 'paused')` guard
    if (memory?.learner && result.status !== 'cancelled') {
      const learned = await memory.learner.extract({
        task: fullTask,
        history: result.observations ?? result.history ?? [],
        // Higher signal than a tool result, so it goes in its own block.
        answers: learnableAnswers(await jobs?.events?.(fullTask.id) ?? []),
        recalledFacts: memories,
        fleetApi: pooledApi,
      });
      // ... existing onProgress reporting unchanged ...
    }
```

- [ ] **Step 6: Run the suites**

Run: `npm run test:eval && npm run test:host`
Expected: PASS — 48 and 93.

- [ ] **Step 7: Commit**

```bash
git add host/memory/learner.mjs host/tasks.mjs tests/host-checkpoint-learning.test.mjs
git status
git commit -m "feat(memory): learn from answers, never from approvals"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/human-input.md`, `docs/CONTRACT.md`, `package.json`, `.github/workflows/ci-host.yml`

- [ ] **Step 1: Add `test:checkpoint` and wire it into CI**

```json
"test:checkpoint": "node --test tests/host-checkpoint-record.test.mjs tests/host-checkpoint-store.test.mjs tests/host-checkpoint-rebuild.test.mjs tests/host-checkpoint-strategies.test.mjs tests/host-checkpoint-reproducibility.test.mjs tests/host-checkpoint-pause-resume.test.mjs tests/host-checkpoint-durable.test.mjs tests/host-checkpoint-config.test.mjs tests/host-checkpoint-learning.test.mjs"
```

Add `- run: npm run test:checkpoint` to `ci-host.yml` beside `test:human-input`.

- [ ] **Step 2: Update `docs/CONTRACT.md` §4e**

It currently says "The snapshot is a cache, and history is the truth". Rename to "The checkpoint is a cache, and history is the truth"; the property is unchanged, only the noun.

- [ ] **Step 3: Update `docs/human-input.md`**

Replace the "How a resume rebuilds the run" section's two-record description with one checkpoint, and add that `humanInput` now requires `memory`. Remove the `pause_too_large` paragraph from the Azure section — it is no longer a limitation an adopter can hit.

- [ ] **Step 4: Run everything one last time**

```bash
npm run test:checkpoint && npm run test:human-input && npm run test:host \
  && npm run test:phase2 && npm run test:phase4 && npm run test:chat \
  && npm run test:eval && npm run test:unit && node --test tests/kit-conformance.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add docs/ package.json .github/workflows/ci-host.yml
git status
git commit -m "docs: one checkpoint, and the memory dependency"
```

---

---

### Task 12: End-to-end on both targets, including a real task hub

**Files:**
- Create: `tests/e2e/scenarios/s20-human-input.json`
- Modify: `tests/e2e/scripted-llm.json` (a goal that asks), `tests/e2e/task.e2e.test.mjs`
- Test: the suite itself — black-box HTTP, run twice

**Interfaces:**
- Consumes: the whole stack from Tasks 1–11.
- Produces: one scenario that runs unchanged on `E2E_TARGET=vm` and `E2E_TARGET=durable`.

This is the only task that exercises the Azure path for real. Task 7 drives the
orchestrator generator with a mock and asserts its shape; it never proves that
a pause survives a *completed* orchestration, that answering starts a new one,
or that the checkpoint is readable from the next activity. The harness for this
already exists — `docker-compose.e2e.yml` has a `durable` profile with Azurite
and an Azure Functions host — and has simply never been pointed at this feature.

The e2e suite is black-box HTTP against `BASE_URL` and never imports host code,
so **the same test proves both deployments**.

- [ ] **Step 1: Add a scripted goal that asks a question**

```json
// tests/e2e/scripted-llm.json — add to "goals"
  "save a trip to Kyoto": [
    "```plan\n{\"steps\": [{\"type\": \"tool\", \"tool\": \"confirm-itinerary\", \"args\": {\"destination\": \"Kyoto\", \"summary\": \"Three days\", \"estimatedCost\": \"JPY 90,000\"}, \"reason\": \"save\", \"review\": false}]}\n```",
    "```review\n{\"approved\": true}\n```",
    "```done\n{\"result\": \"Saved your Kyoto itinerary.\", \"summary\": \"Saved\"}\n```"
  ]
```

`confirm-itinerary` is `reversible: false`, so the guardrail raises the approval
question without the script having to model it.

- [ ] **Step 2: Write the failing scenario**

```json
// tests/e2e/scenarios/s20-human-input.json
{
  "name": "a run parks on an approval, is answered over HTTP, and resumes",
  "goal": "save a trip to Kyoto",
  "expectStatus": "completed",
  "humanInput": {
    "expectAskedBy": "guardrail",
    "expectKind": "approval",
    "answer": { "proceed": "approve" },
    "expectResultMatches": "Saved"
  }
}
```

- [ ] **Step 3: Teach the runner to answer a parked job**

```js
// tests/e2e/task.e2e.test.mjs — add to the api helper
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
```

```js
// ...and inside the scenario loop, when s.humanInput is present
  if (s.humanInput) {
    const parked = await api.waitWaiting(jobId);
    assert.ok(parked.pendingInput, 'the batch is on the record');
    assert.equal(parked.pendingInput.askedBy, s.humanInput.expectAskedBy);
    assert.equal(parked.pendingInput.questions[0].kind, s.humanInput.expectKind);

    // The load-bearing assertion for this whole change: the job record carries
    // a pointer, and the state is in the checkpoint store.
    assert.equal(parked.snapshot, undefined, 'no state on the job record');
    assert.ok(parked.pendingBatchId, 'a pointer is on the job record');

    const answered = await api.post(`/jobs/${jobId}/input`, {
      batchId: parked.pendingInput.batchId,
      answers: s.humanInput.answer,
    });
    assert.equal(answered.status, 200);
  }
```

- [ ] **Step 4: Run it on the VM target to verify it passes**

```bash
npm run e2e:vm
```

Expected: PASS, including `s20-human-input`.

- [ ] **Step 5: Run it on the durable target — the one that has never been tested**

```bash
npm run e2e:durable
```

Expected: PASS. This is the first time a pause has survived a real completed
orchestration and been resumed by a new one.

**If it fails, that is the point of the task.** The likely causes, in order:

1. `hostCtx.memory` is null in the Functions host because the memory module is
   not configured in `deploy/azure-functions/host.config.mjs`. Task 8 then
   fails startup, which is correct behaviour and a config fix, not a code fix.
2. The memory store adapter on Functions defaults to `filesystem`, whose writes
   do not survive between activity invocations. Set `memory.checkpoint.store`
   to `cosmos` — or, for this harness, `sqlite` on a mounted volume.
3. `pendingBatchId` is not read back by `mapDurableStatus` — Task 7, Step 5.

- [ ] **Step 6: Record which of those it was**

Whatever the outcome, append a short note to `docs/human-input.md` under the
Azure section saying the durable path is now covered end to end, and by which
command. The spec has said "unit-tested against mocks only" since #63; this is
the task that changes that sentence.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/ docs/human-input.md
git status
git commit -m "test(e2e): a pause and resume on both targets, including Azurite"
```

## Out of scope

Carried from spec §9, so an implementer does not add them opportunistically:

- **MCP provenance.** Nothing records which MCP server a tool came from. Its own spec.
- **Prompt text and per-step token accounting.** Only aggregate budget is kept.
- **Sharing learnt preferences across people.**
- **Retracting facts learnt from work that was later reversed.**
