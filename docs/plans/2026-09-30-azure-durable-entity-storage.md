# Azure Durable Entity storage — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans
> (inline) or superpowers:subagent-driven-development to implement this plan
> task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On Azure Functions, hold the checkpoint, chat history and long-term
facts in the Durable task hub via Durable Entities — with no Cosmos and no SQL
required for a default deployment.

**Architecture:** The orchestrator stops being a one-shot dispatcher and becomes
the run loop: it repeatedly calls an `advance` activity that performs exactly
one step, then commits the resulting delta to a checkpoint entity with
`callEntity` before continuing. Entity state is addressed directly by the
orchestrator, not through the promise-based memory store interface, because
`callEntity` must be `yield`ed from a generator.

**Tech Stack:** Node 22 ESM, `durable-functions@3.5.0`, `@azure/functions` v4,
`node:test`, Azurite for e2e.

**Spec:** `docs/specs/2026-09-30-azure-durable-entity-storage-spec.md`

---

## Global Constraints

- **No Cosmos, no SQL in any default path.** Both remain selectable adapters.
  A default clone must run on Azure Functions with only `AzureWebJobsStorage`.
- **SQL means Microsoft SQL Server** (`mssql` driver), lazy-loaded exactly the
  way `host/memory/store/cosmos.mjs` is, so an unused adapter is never imported.
- **The VM path does not change.** `host/jobs/in-process.mjs`, the strategies
  and the memory store interface keep working exactly as they do now. Every
  existing suite must stay green.
- **Orchestrator determinism rules** (spec §5.3), checked at review:
  no `waitForExternalEvent` in a loop; no `Task.any` racing an event against an
  activity; the yield sequence derives only from input and prior activity
  results; task objects created in a fixed order.
- **No credential reaches an entity.** `scrub()` applies to entity payloads
  exactly as it does to checkpoint records.
- **Never add `Co-Authored-By` or any AI attribution to commits** (repo rule,
  `docs/plans/phase4-jobs-durable-plan.md`).
- Plain-language rule for anything a person reads still applies
  (`docs/CONTRACT.md`).

## Review Focus

The five things most likely to bite somebody, that no task's tests fully cover:

1. **Replay determinism under a real task hub.** Every unit test drives the
   generator by hand and cannot reproduce the SDK's event-ID counter. Only
   `e2e:durable` can. A regression here reproduces the 125-activity incident.
2. **Worker lease churn.** One activity per step means acquiring and releasing
   a pool lease per step instead of once per run. Under `WORKER_POOL_SIZE=2`
   a multi-step run may now contend with itself.
3. **Entity state growth.** `facts` is capped at 500 but `conversation` and
   `checkpoint.observations` are not obviously bounded; entity state is read and
   rewritten whole on every operation.
4. **A crash between the step activity returning and `callEntity` committing.**
   The step ran; the checkpoint does not know. Idempotency keys are what make
   this safe — verify the key is written in the same entity operation that
   records the observation, not a later one.
5. **Answering a pause that was created by an older kit version.** A checkpoint
   entity written before this change has no entity at all; the resume must fall
   back to `rebuildFromHistory` rather than fail.

---

## Task 1 — DONE: The entity definitions

**Files:**
- Create: `comm/azure-functions/entities/checkpoint-entity.mjs`
- Create: `comm/azure-functions/entities/conversation-entity.mjs`
- Create: `comm/azure-functions/entities/facts-entity.mjs`
- Test: `tests/comm-azure-entities.test.mjs`

**Interfaces:**
- Consumes: `scrub`, `createCheckpointRecord` from `host/checkpoint/record.mjs`.
- Produces: three entity handler functions, each `(context) => void`, registered
  with `df.app.entity(name, handler)`. Operation names are the contract later
  tasks call:
  - checkpoint: `save`, `get`, `clear`, `addIdempotencyKey`, `hasIdempotencyKey`
  - conversation: `append`, `forPrompt`, `clear`
  - facts: `store`, `query`, `promote`, `remove`, `count`, `purge`

Entity state is a single JSON object. Handlers are pure functions of
`(currentState, input)` so they can be unit-tested without Durable at all —
the Durable wrapper is three lines around a tested core.

- [ ] **Step 1: Write the failing test for the checkpoint entity core**

```js
// tests/comm-azure-entities.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { checkpointOps } = await import('../comm/azure-functions/entities/checkpoint-entity.mjs');

test('save merges rather than replacing', () => {
  let s = checkpointOps.save(null, { jobId: 'j1', observations: [], idempotencyKeys: ['a'] });
  s = checkpointOps.save(s, { jobId: 'j1', pendingBatchId: 'inp-1' });
  assert.deepEqual(s.idempotencyKeys, ['a'], 'a writer that did not mention the keys keeps them');
  assert.equal(s.pendingBatchId, 'inp-1');
});

test('a credential never reaches entity state', () => {
  const s = checkpointOps.save(null, { jobId: 'j1', task: { args: { client_secret: 'LEAK' } } });
  assert.equal(JSON.stringify(s).includes('LEAK'), false);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `node --test tests/comm-azure-entities.test.mjs`
      Expected: `Cannot find module .../checkpoint-entity.mjs`

- [ ] **Step 3: Implement the ops core**

```js
// comm/azure-functions/entities/checkpoint-entity.mjs
import { createCheckpointRecord } from '../../../host/checkpoint/record.mjs';

// Same merge rule as host/checkpoint/index.mjs save(): a field the writer did
// not mention keeps the value already stored, because the orchestrator commits
// a step's delta and knows nothing of the idempotency keys the step produced.
export const checkpointOps = {
  save: (state, fields) => createCheckpointRecord({ ...(state ?? {}), ...fields }),
  get: (state) => state ?? null,
  clear: () => null,
  addIdempotencyKey: (state, key) => {
    const keys = state?.idempotencyKeys ?? [];
    return keys.includes(key) ? state : { ...state, idempotencyKeys: [...keys, key] };
  },
  hasIdempotencyKey: (state, key) => (state?.idempotencyKeys ?? []).includes(key),
};
```

- [ ] **Step 4: Run it, expect PASS.**

- [ ] **Step 5: Repeat steps 1–4 for the conversation and facts entities.**
      `facts.query` implements the same predicate set the sqlite store does —
      `{ kinds, tags, states, limit }`, filtered in memory, sorted by
      `retrievalStrength`. `facts.store` enforces `maxEntries` and returns
      `{ ok: false, reason: 'at_cap' }` rather than throwing.

- [ ] **Step 6: Wrap each core in a Durable entity handler and register it**

```js
import * as df from 'durable-functions';
df.app.entity('checkpoint', (context) => {
  const op = context.df.operationName;
  const state = context.df.getState(() => null);
  if (op === 'get') return context.df.return(checkpointOps.get(state));
  if (op === 'hasIdempotencyKey') return context.df.return(checkpointOps.hasIdempotencyKey(state, context.df.getInput()));
  context.df.setState(checkpointOps[op](state, context.df.getInput()));
});
```

- [ ] **Step 7: Commit** — `feat(azure): durable entities for checkpoint, conversation and facts`

---

## Task 2 — DONE: `advance` — one step per activity

**Files:**
- Modify: `comm/azure-functions/activity.mjs`
- Create: `comm/azure-functions/advance.mjs`
- Test: `tests/comm-azure-advance.test.mjs`

**Interfaces:**
- Consumes: the strategies unchanged.
- Produces: `runAdvanceActivity(input) → { done, delta, output? , paused? }`
  where `delta` is `{ observations, plan, idempotencyKeys, interruptions }` —
  what the orchestrator commits to the entity.

This is the load-bearing task. The activity currently runs a whole task to
completion; it must instead perform **one** step and return.

Both strategies decompose the same way, which is why `advance` is uniform
rather than `plan`/`step`/`finish`: plan-execute's "one step" is one plan step,
open-ended's is one LLM turn plus whatever tool it chose. In both cases the
activity reads the run's accumulated state, advances it by one, and returns the
delta.

**State is read, not passed.** The activity reads the checkpoint through
`client.readEntityState()` rather than receiving it in its input, because a
run's observations can exceed the Durable payload cap. The orchestrator passes
only `{ jobId, checkpointKey }`.

- [ ] **Step 1: Write the failing test**

```js
test('advance performs exactly one step and reports not-done', async () => {
  let toolCalls = 0;
  const out = await runAdvance({
    jobId: 'job-1',
    state: { plan: { steps: [step('book'), step('email')], cursor: 0 }, observations: [], idempotencyKeys: [] },
    tools: [{ name: 'book', reversible: false, run: async () => { toolCalls += 1; return { ok: true }; } }],
  });
  assert.equal(toolCalls, 1, 'one step, not the whole plan');
  assert.equal(out.done, false);
  assert.equal(out.delta.plan.cursor, 1);
  assert.equal(out.delta.observations.length, 1);
});

test('advance skips a step whose idempotency key is already recorded', async () => {
  let toolCalls = 0;
  const key = stepIdempotencyKey(step('book'), 0);
  const out = await runAdvance({
    jobId: 'job-1',
    state: { plan: { steps: [step('book')], cursor: 0 }, observations: [], idempotencyKeys: [key] },
    tools: [{ name: 'book', reversible: false, run: async () => { toolCalls += 1; return { ok: true }; } }],
  });
  assert.equal(toolCalls, 0, 'a crash between the step and its commit must not re-run it');
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `advance.mjs`.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Prove the delta is bounded** — a test asserting a single
      advance's returned delta stays under `DURABLE_PAYLOAD_MAX_CHARS`, with a
      tool result of 100 KB. A large result must be summarised or referenced in
      the delta, never inlined. **Expected: this fails first and drives the fix.**
- [ ] **Step 6: Commit.**

---

## Task 3 — DONE: The orchestrator drives the loop

**Files:**
- Modify: `comm/azure-functions/orchestrator.mjs`
- Test: `tests/comm-azure-orchestrator.test.mjs` (extend)

**Interfaces:**
- Consumes: `advance` from Task 2, entity ops from Task 1.
- Produces: an orchestrator whose yield sequence is a pure function of history.

```js
const cp = new df.EntityId('checkpoint', checkpointKey);
for (let i = 0; i < MAX_STEPS; i += 1) {
  const r = yield df.callActivity(ADVANCE_NAME, { jobId, checkpointKey });
  yield df.callEntity(cp, 'save', r.delta);      // confirmed before continuing
  if (r.paused) { /* record the batch, complete the orchestration */ break; }
  if (r.done)   { output = r.output; break; }
}
```

- [ ] **Step 1: Write the failing determinism test** — drive the generator three
      times over the same synthetic history and assert an identical sequence of
      task creations each time. This cannot prove the SDK's counter (only
      `e2e:durable` can) but it catches a yield sequence that varies.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `MAX_STEPS` is a bound, not a feature: an
      unbounded `for(;;)` in an orchestrator is how a replay bug becomes an
      infinite bill. Exceeding it settles the run `failed` with a clear reason.
- [ ] **Step 4: Run, expect PASS. Re-run the existing orchestrator suite.**
- [ ] **Step 5: Commit.**

---

## Task 4 — DONE: Resume reads the entity

**Files:**
- Modify: `host/jobs/durable.mjs`
- Test: `tests/host-checkpoint-durable.test.mjs` (extend)

`provideInput` currently loads the checkpoint through the store abstraction
(added when the pointer was fixed). On Azure it must read the entity instead,
via `client.readEntityState(new df.EntityId('checkpoint', taskKey))`.

- [ ] **Step 1: Failing test** — a paused instance whose state is in an entity
      resumes with its observations, cursor and interruptions.
- [ ] **Step 2: Failing test for the old-format fallback** — a paused instance
      with **no** entity (written by a previous kit version) must fall back to
      `rebuildFromHistory` and still resume, not throw. *(Review Focus 5.)*
- [ ] **Step 3: Run both, expect FAIL.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run, expect PASS.**
- [ ] **Step 6: Commit.**

---

## Task 5 — DONE: Conversation and facts on entities

**Files:**
- Create: `host/memory/store/entity.mjs`, `host/memory/conversation-store/entity.mjs`
- Modify: `host/memory/index.mjs` (`resolveStore` / `resolveConversationStore`)
- Test: `tests/host-memory-store-entity.test.mjs`

Unlike the checkpoint these **are** reachable through the store interface,
because they are read and written from the activity, not the orchestrator:
`readEntityState` for reads, and writes committed by the orchestrator from the
delta the activity returns. `signalEntity` is not used — it is unconfirmed, and
a silently lost fact is indistinguishable from one that was never learnt.

- [ ] **Step 1: Failing test** — `store: 'entity'` resolves, and the adapter
      satisfies `assertMemoryStore` / `assertConversationStore`.
- [ ] **Step 2: Failing test** — `query({ kinds, tags, states, limit })` returns
      the same results as the sqlite store for the same fixture. Run the
      existing long-term suite against both adapters.
- [ ] **Step 3: Run, expect FAIL. Step 4: Implement. Step 5: Run, expect PASS.**
- [ ] **Step 6: Commit.**

---

## Task 6 — DONE: Default the Azure config to entities

**Files:**
- Modify: `deploy/azure-functions/host.config.mjs`
- Modify: `docs/human-input.md`, `docs/memory.md`, `docs/getting-started.md`

- [ ] **Step 1:** `checkpoint`, `conversationContext` and `longTerm` all
      `store: 'entity'`. Remove the stale `runState: { store: 'sqlite' }`.
- [ ] **Step 2:** Update the docs, which currently say Cosmos is required on
      Functions. It is not, and must not be.
- [ ] **Step 3: Commit.**

---

## Task 7 — DONE: Microsoft SQL Server adapter (selectable, never default)

**Files:**
- Create: `host/memory/store/mssql.mjs`, `host/memory/conversation-store/mssql.mjs`
- Modify: `package.json` (`mssql` as an **optional** dependency)
- Test: `tests/host-memory-store-mssql.test.mjs`

- [ ] **Step 1:** Lazy `await import('mssql')` inside the `case 'mssql':` branch
      only, mirroring the Cosmos adapter, so a clone that never selects it never
      needs the driver installed.
- [ ] **Step 2:** Tests run against a double; a `*.live.test.mjs` variant, not in
      CI, runs against a real server. State that plainly — the sqlite lesson from
      `docs/plans/2026-09-30-checkpoint-integration-issues.md` §1.2 applies here:
      a double accepted a record shape the real store rejected.
- [ ] **Step 3: Commit.**

---

## Task 8 — DONE: Entity retention

**Files:**
- Create: `host/jobs/entity-retention.mjs`
- Test: `tests/host-entity-retention.test.mjs`

Purging orchestration instances does not remove entities. Without this, entity
state accumulates for the life of the storage account.

- [ ] **Step 1: Failing test** — an entity older than `retention.afterDays` with
      no live paused run is removed; one belonging to a paused run is **not**,
      whatever its age. *(The same rule `purgeStaleOrchestrations` already
      follows — a blanket purge would destroy every paused run.)*
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

---

## Task 9 — BLOCKED (needs Docker): End to end on Azurite

**Files:**
- Modify: `docker-compose.e2e.yml` if needed, `.github/workflows/ci-host.yml`

**This task requires Docker and cannot be done on the current machine.**

- [ ] **Step 1:** `npm run e2e:durable`. Expected: 10/10 including `s20`.
- [ ] **Step 2:** Confirm the entity harness needs no change — entities use the
      same storage account as the task hub (spec rule 6).
- [ ] **Step 3:** Check the activity execution count for a multi-step run equals
      the step count. **This is the determinism proof** deferred from spec §5.4.
      A higher count is the 125-activity bug returning.
- [ ] **Step 4:** Measure entity state size and operation latency for a 20-step
      run and a 500-fact store, and record the numbers. The spec's §2(b) payload
      question is answered here, by measurement, not by assumption.
- [ ] **Step 5:** Add `e2e:durable` to CI if the runner can host Azurite.
- [ ] **Step 6: Commit.**

---

## Sequencing note

Tasks 1 and 2 are independent and can run in parallel. Task 3 needs both.
Tasks 5, 7 and 8 are independent of 2–4. **Task 9 gates the merge**, and
until it has run, everything here is unverified against a real task hub —
exactly the state the previous branch was criticised for.
