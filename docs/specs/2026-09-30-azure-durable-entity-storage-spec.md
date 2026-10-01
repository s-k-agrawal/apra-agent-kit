# Azure state storage: Durable Entities as the default

**Status:** draft for approval — no code written
**Date:** 2026-09-30
**Supersedes the storage half of:** `docs/specs/2026-09-29-memory-human-input-integration-spec.md`
**Branch it builds on:** `feature/memory-human-input-integration`

---

## 1. The correction this spec starts from

An earlier answer in this workspace said the Durable task hub cannot hold the
checkpoint, chat history or long-term facts. **That was wrong**, and the
correction stands: it reasoned only about orchestration *input and output*.
Durable Entities are a separate feature — addressable, durable objects that
live in the task hub's own storage, keyed by entity ID, outliving any single
orchestration.

Verified in this checkout, not assumed:

```
durable-functions 3.5.0
df.app.entity        → function
df.EntityId          → exported
lib/src/entities/    → Entity, EntityId, EntityState, Signal, DurableLock, …
```

So entity-backed storage is available on the version already installed. No
dependency change is needed for entities themselves.

---

## 2. The three questions, answered

### (a) What does `pause_too_large` guard — output or custom status?

**The orchestration output.** `comm/azure-functions/orchestrator.mjs:81` returns
`guardPausedOutput(output, jobId)`, and that function (`:102`) measures
`JSON.stringify(output)` against `DURABLE_PAYLOAD_MAX_CHARS = 12_000`, commented
"stay safely under the 16 KB UTF-16 limit".

`customStatus` is a *different* thing and is not what the guard covers. The
orchestrator keeps it deliberately small — a ring of 50 events
(`ringEvents(events, ringSize)`) — and the code states the contract outright:

> `customStatus` has a hard size limit and is a live view, never a source of
> truth — the state is in the output.

One thing that changed under you today: as of commit `d8235ae` on this branch,
the paused output is already a pointer (`{ status, batchId, batch, checkpointKey }`),
so `pause_too_large` is now an unreachable assertion rather than a live failure
path. It was deliberately kept as an assertion: if it ever fires, something has
started putting state back in the output.

### (b) Which Durable backend, and its payload limits?

**Azure Storage** — the default provider. `comm/azure-functions/host.json`
declares only:

```json
"extensions": { "durableTask": { "hubName": "%DURABLE_TASK_HUB%" } }
```

There is no `storageProvider` block, so it is not Netherite, not MSSQL, and not
the Durable Task Scheduler. Extension bundle `[4.*, 5.0.0)`. The e2e harness
points `AzureWebJobsStorage` at Azurite (blob 10000 / queue 10001 / table 10002).

**On the limits, I am deliberately not asserting a number.** The 16 KB figure in
our code is our own conservative choice, not a quoted Azure limit, and the
Azure Storage provider's actual behaviour around large payloads (queue-message
caps, automatic blob offloading, and what applies to *entity state* specifically
as opposed to messages) is the one thing in this spec I could not verify from
the repo. **This must be measured on a real Azurite run before the design
depends on it** — measured on the `e2e:durable` run in §7. Designing to an
unverified limit is how
`pause_too_large` came to exist in the first place.

### (c) Do long-term facts need search?

**Yes — query, not key lookup.** `host/memory/long-term.mjs:99` recalls via:

```js
store.query({ kinds: ['rule'], states: ['active'] })
store.query({ kinds: nonRuleKinds, tags, states: ['active'], limit: room })
```

That is a multi-predicate filter (kind ∈ set, tag membership, state ∈ set,
limit), followed by a sort on `retrievalStrength`. The full required surface is:

```js
MEMORY_STORE_METHODS = ['open','close','store','get','update','remove','query','purge','count']
```

`count({})` backs the `maxEntries` cap (500 by default) and `purge` backs the
decay sweep — both cross-cutting operations over the whole fact set, not
per-key.

**This is satisfiable by an entity but it is the weakest fit of the three.** A
per-user entity holds ≤500 facts and filters in memory; correctness is fine.
The cost is that *every* recall loads the whole entity state and *every* store
rewrites it. That is the operation whose latency and state size will cross a
threshold first, which is exactly what your "when to switch to Cosmos or SQL"
alert list is for. My recommendation in §4.

---

## 3. What the plan asks for that already exists

Three of the six implementation rules are already true on this branch, so they
should be struck from the work rather than re-done:

| Rule | Status |
|---|---|
| 4. Idempotency keys on irreversible steps | **Exists** — `stepIdempotencyKey()`, `host/checkpoint/record.mjs` |
| Checkpoint written after each step | **Exists** — both strategies, `saveCheckpoint(i, key)` |
| Jobs stay on the task hub | **Exists** — `AUTO = { durable: 'taskhub' }` |

**One correction on rule 4.** The proposed key format `convId:stepN` is *weaker*
than what shipped today. Today's key is `${tool}-${sha256(scrub(args))}-${i}` —
it includes a hash of the step's scrubbed arguments. `convId:stepN` omits them,
so after a replan (which this kit does, up to `maxReplanAttempts`) a *different*
step occupying index N would match the old key and be **silently skipped as
already done**. The args must stay in the key. The scrubbing is also
load-bearing: it was added today because a credential in a step argument was
being written verbatim into the stored key.

---

## 4. Design

### 4.1 Adapter shape

Three new adapters behind the two existing interfaces — no caller changes:

```
host/memory/store/entity.mjs               → MEMORY_STORE_METHODS  (checkpoint + long-term)
host/memory/conversation-store/entity.mjs  → CONVERSATION_STORE_METHODS
host/memory/store/sql.mjs + conversation-store/sql.mjs  → the new SQL option
```

Selection stays config-only, via the existing `resolveStore` switch:

```js
memory: {
  checkpoint:          { enabled: true, store: 'entity' },
  conversationContext: { enabled: true, store: 'entity', mode: 'store' },
  longTerm:            { enabled: true, store: 'entity' },   // see §4.4
}
```

### 4.2 Entity keying

| Store | Entity name | Key | Lifetime |
|---|---|---|---|
| Checkpoint | `checkpoint` | `cp-<jobId>` | cleared on settle |
| Conversation | `conversation` | `<sessionId>` | retention job |
| Long-term facts | `facts` | `<personId>` (or `global`) | retention job |

The checkpoint key already exists and is already computed this way
(`checkpointKey({ id: jobId })`), so the pointer in the paused output needs no
change — only something on the other end that reads it from an entity rather
than a memory store.

### 4.3 Who writes, and how

Per your rule 2: **`callEntity` from the orchestrator only.** `signalEntity` is
fire-and-forget and gives no confirmation, so a crash between signal and
execution loses the checkpoint silently — the exact failure the checkpoint
exists to prevent. Activities do not write entities.

### 4.4 Long-term facts: my recommendation

**Default long-term facts to Cosmos, not entities**, while checkpoint and
conversation default to entities.

Facts are the one store with a genuine cross-cutting query (kind × tags × state,
plus `count` and `purge` sweeps over everything), the one whose state only ever
grows, and the one that is *not* scoped to a single conversation — so it gets
none of the locality benefit entities give the other two. Putting it on entities
means loading ~500 facts to answer every recall, on every run.

This is a recommendation, not a decision — it is Open Question 1.

---

## 5. Multi-yield: resolved, not a blocker

An earlier draft of this spec made this a blocking spike. **That was
over-cautious.** Reading the commit that introduced the single-yield rule
(`b83f2d8`) identifies the cause exactly, and it is not yield count.

### 5.1 What actually broke

The old orchestrator (`b83f2d8^`):

```js
const activity = df.callActivity(ACTIVITY_NAME, {...});   // created ONCE
for (;;) {
  const progress = df.waitForExternalEvent('progress');   // created EVERY iteration
  const cancel   = df.waitForExternalEvent('cancel');     // created EVERY iteration
  const winner = yield df.Task.any([activity, progress, cancel]);
  if (winner === activity) break;
  ...
}
```

The Durable SDK assigns each task an event ID **by creation order**. The number
of loop iterations here depends on how many `progress` events had been raised by
the time of a given replay — that is wall-clock, not history. So:

- replay with 0 progress events → 2 `waitForExternalEvent` tasks created
- replay with 4 progress events → 10 created

Different task-creation counts on each replay shifted the counter, so on the
next replay `callActivity`'s ID no longer matched its history entry. The SDK
concluded it was a *new* activity and scheduled another. One request produced
**125 activities** and exhausted the pool (5 busy + 20 queued → `dispatch_failed`).

That is a textbook non-determinism bug. Its cause is **a loop whose iteration
count depends on external event arrival**. It is not "yielding more than once."

### 5.2 Why multi-yield is safe here

Deterministic multi-yield is the pattern Durable exists for — function chaining
and fan-out/fan-in are Microsoft's own canonical samples. The rule is that the
sequence of yields must be a pure function of orchestration history:

```js
const plan = yield df.callActivity('plan', input);     // replay: same result from history
for (const step of plan.steps) {                       // replay: same iteration count
  const r = yield df.callActivity('step', step);       // replay: same IDs, matched
  yield df.callEntity(cpEntity, 'save', r);
}
```

On replay the plan comes back from history identically, so the loop runs the
same number of times in the same order, and every task ID matches.

**The cause is already gone.** The current orchestrator contains no
`waitForExternalEvent`, no `Task.any`, and no external events whatsoever —
cancellation is polled by the activity through `getStatus`
(`activity.mjs:42`). There is nothing left to drift the counter.

### 5.3 The rule this imposes

Any orchestrator work must obey, and the review should check it:

1. **No `waitForExternalEvent` in a loop**, and preferably not at all. Keep
   cancellation on the existing poll.
2. **No `Task.any` racing an external event against an activity.**
3. **Yield sequence derives only from input and prior activity results** — never
   from wall-clock time, `Math.random`, or event arrival.
4. Task objects are created in a fixed order per replay.

### 5.4 Call

**Proceed with multi-yield. No separate spike.** The one genuine residual risk —
that the SDK's counter behaves differently than the mechanism above predicts —
is already covered by the `e2e:durable` gate in §7, which has to run anyway.
Folding it there costs nothing; a standalone spike would be a second Azurite
setup to learn the same fact.

If `e2e:durable` shows duplicate activity executions, §6 is the fallback.

### 5.5 The architectural cost, which still stands

This is a real decision and is **not** resolved by the above.

- Today the run loop lives in the **activity**: `activity.mjs` → `executeHostedTask`
  → the strategy, which owns the plan/execute loop.
- Those strategies are **shared with the VM path**. One code path, two
  deployments — that is what lets one black-box e2e suite prove both.
- The plan isn't known until an LLM produces it, *inside* an activity. So the
  shape becomes `activity(plan)` → orchestrator loops → `activity(step)` × N,
  and the orchestrator becomes a second plan-execute loop existing only on Azure.

That forks the execution model between VM and Functions. It buys per-step
durability a single long activity cannot give, which is a real benefit — but it
should be chosen deliberately. It remains Open Question 2.

---

## 6. Fallback if e2e:durable shows duplicate activities

Keep the single activity, and have the activity write checkpoints through an
**HTTP call to an entity** via the Durable client binding (`signalEntity` plus a
read-back to confirm, or the entity-state REST endpoint). Slower and less
elegant than `callEntity`, and it violates plan rule 2 — but it keeps the
one-activity model, keeps VM and Azure on the same strategies, and still puts
the state in the task hub.

---

## 7. What is not verified, and cannot be here

`npm run e2e:durable` has **never been run**. Docker is not installed on this
machine, so every Azure claim in this repo — including the pointer fix committed
today — is unit-tested against mocks only. Mocks prove the orchestrator's
*shape*, not that a pause survives a genuinely completed orchestration.

**Nothing in this spec should be built until `e2e:durable` runs green on the
current branch on a machine with Docker.** Otherwise we would be layering
entities on top of an Azure path whose basic pause/resume has never executed.

Your rule 6 is right, though, and cheap to confirm: entities use the same
storage account, so the Azurite harness should need no change.

---

## 8. Out of scope

- Large tool results → blob storage with a reference in the entity (plan rule 5).
  Worth doing, but it is a separate change from *where state lives*, and it has
  its own retention and cleanup story.
- The migration job. New conversations to the new store, existing ones finishing
  on entities, is enough.
- MCP provenance in the checkpoint — still out of scope, carried from the
  previous spec.

---

## 9. Decisions

All three questions are settled. Recorded here because they are constraints on
the plan, not preferences.

**1. Entities are the default for all three stores.** Checkpoint, conversation
and long-term facts. **Cosmos and SQL are selectable adapters only, never the
default.** This is a strict instruction: a default deployment must not require a
Cosmos account or a SQL server.

This overrides §4.4, which recommended Cosmos for long-term facts because they
need real queries. The concern stands technically — a per-user entity holds ≤500
facts (`maxEntries`) and every recall loads the whole state to filter it — but
the no-external-dependency requirement wins, and the cap keeps it bounded. The
§10 alert thresholds are how we find out if that becomes a problem in practice.

**2. Forking the execution model is accepted.** Per-step activities with the
orchestrator driving the loop and committing checkpoints via `callEntity`.

**3. SQL means Microsoft SQL Server** — the one used with SSMS. Driver: `mssql`,
lazy-loaded the way the Cosmos adapter already is, so a clone that never selects
it never installs it.

### 9.1 The consequence that shapes everything

Verified against `durable-functions@3.5.0` type definitions:

| API | Where | Confirmed? |
|---|---|---|
| `callEntity(id, op, input): Task` | orchestration context only | **yes** — must be `yield`ed |
| `signalEntity(id, op, input): void` | orchestration **and** client | no — fire and forget |
| `readEntityState(id)` | client (so: usable from an activity) | read only |

`callEntity` returns a Task that must be yielded, so it is reachable **only from
the orchestrator generator**. An orchestrator is a generator and cannot `await`
a promise — doing so breaks replay determinism.

**Therefore the entity-backed checkpoint cannot be implemented behind the
existing `MEMORY_STORE_METHODS` interface**, which is promise-based and called
with `await` from inside the activity. On Azure the checkpoint stops travelling
through `host/memory/store/*` altogether; the orchestrator addresses the entity
directly.

That is not an adapter. It is a second execution path, which is what decision 2
accepts. The VM path is untouched and keeps using the store interface.

---

## 10. Recommended order

1. Get `e2e:durable` green on the current branch (needs Docker). **Gate** —
   this also confirms multi-yield determinism (§5.4); there is no separate spike.
2. Resolve Open Questions 1–3.
3. Entity adapter for the checkpoint — smallest, clearest win, one key, cleared
   on settle.
4. Entity adapter for the conversation store.
5. Long-term facts, per the answer to Q1.
6. SQL adapter behind the same interface.
7. Retention job for entities.
