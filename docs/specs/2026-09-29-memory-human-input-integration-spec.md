# Fleet Agent Kit — Memory and Human Input, Integrated

Status: proposed design — not yet implemented. Follow-up to #30 / PR #63, designed against `main`
plus that PR as a fixed base.

> **The earlier human-input spec opens by saying it has nothing to do with the memory module.**
> That was true when it was written and is the thing this document changes. The two subsystems were
> built independently, both persist mid-run state, and they now hold three of the same facts in two
> places. This spec makes that one place.

## What this ships

**One checkpoint.** `host/memory/run-state.mjs` and `host/human-input/snapshot.mjs` both retire onto
a single record with a single writer, living in the memory store. Nothing is stored twice.

**Answers become memory.** What a person tells the agent — pace, budget, what to avoid — is learnt
as a preference, so the agent stops asking the same question on every run. Permission is never
learnt.

**A resume sees what the original run saw.** The same recalled facts, the same conversation, the
same agent, the same strategy. A resumed run that behaves differently because memory moved
underneath it is a bug nobody can see.

**Consequence: `humanInput` now requires `memory`.** Both were independently optional. Under one
checkpoint there is nowhere else to put it.

## Why one checkpoint

Today these two records overlap:

| `memory/run-state.mjs` | `human-input/snapshot.mjs` | |
|---|---|---|
| `stepIndex` | `plan.cursor` | same fact |
| `plan` | `plan.steps` | same fact |
| `observations` | `observations` | same fact |
| `idempotencyKeys` | — | |
| `strategy` | — | |
| — | `pendingBatchId`, `interruptions`, `identity`, `budget`, `task`, `version` | |

Two writers, two triggers, two homes. Run-state saves after each step for crash recovery; the
snapshot saves at a pause. **They can disagree, and nothing says which wins.**

A contract between them — each owning some fields, the boundary documented — would remove the
duplicated data but not the second writer. It would survive on discipline. One module with one
writer makes duplication structurally impossible, which is the point.

## Where it lives

Not in either existing module, because neither can own it:

| | Depends on | Would break |
|---|---|---|
| `memory/run-state` | the memory store | merging into human input gives it a `dispatch` dependency, killing crash recovery on the sync `/task?wait=true` path |
| `human-input/snapshot` | the job record | merging into memory makes human input require an optional module — which is the trade this spec accepts, see below |

So the record and its writer live in a new `host/checkpoint/`, and the **memory store is its
backing**. Which store that is, is an adapter decision resolved per deployment — the pattern
`dispatch.store.kind: 'auto'` already establishes:

```
VM        → memory store: sqlite | filesystem
Functions → memory store: cosmos
```

**A production system is one deployment or the other, never both.** There is no precedence rule to
arbitrate, and this spec deliberately does not invent one.

### What the job record and the orchestration output keep

Only `pendingBatchId`. A pointer, never state.

This dissolves a limitation PR #63 had to ship with. Durable Functions caps an orchestration output
at 16 KB, so an oversized pause had to **fail** with `pause_too_large`. With the state in the memory
store the output carries a pointer, the cap stops mattering, and that guard becomes vestigial rather
than load-bearing.

---

## 1. The checkpoint record

```
host/checkpoint/
  record.mjs     shape, version, validation
  index.mjs      createCheckpoint({ store }) → save / load / clear
```

```js
{
  version: 1,
  kitVersion: '0.1.0',
  taskKey, jobId, traceId,
  writtenAt: '2026-09-29T09:14:22.104Z',

  // what the run is
  task,                          // goal, inputs, constraints, budget
  agentName, agentDescription,   // feed buildSystemPrompt
  strategy: 'plan-execute',

  // where it got to
  plan: { steps, cursor },
  observations,                  // tool name, args and result, per step
  idempotencyKeys,

  // what it was given
  conversation,                  // as it went into the prompt
  recalledFacts,                 // ids AND text, as used — see §4

  // accounting
  budget,
  interruptions,                 // MUST persist, or maxInterruptions never trips

  // who, and what it is waiting on
  identity: { personId, tenantId? },
  pendingBatchId,                // set only while parked on a question
  workspace: { workerId },       // which worker ran it — for incidents, not resume
}
```

### Three fields the snapshot was missing

`agentName`, `agentDescription` and `strategy` are new. Resuming under a renamed agent, a re-worded
description, or a different strategy is the same class of fault as recalling different facts: the
run's behaviour changes for reasons that leave no trace. `strategy` already exists in the run-state
checkpoint; the other two exist nowhere.

`workspace.workerId` is recorded but not used to resume — a resume deliberately takes a *fresh*
worker. It is there so "which worker did this" is answerable during an incident.

### Two triggers, one record

| Trigger | Was | Now |
|---|---|---|
| after each step | `runState.save()` | `checkpoint.save()` |
| on pause | snapshot written to the job record | `checkpoint.save()` |

Same function, different moments. Saving more often is strictly safer for both purposes.

### The checkpoint stays a cache

**`rebuildFromHistory` survives unchanged and still governs.** History is the truth; the checkpoint
is a read-once convenience. If it is absent, unreadable, or written at an incompatible `version`,
the run rebuilds from history and must come out identical.

The test that deletes the checkpoint and demands an identical resume carries over to the merged
record. Without it this change trades duplication for a weaker guarantee, which is a bad trade.

---

## 2. Configuration and the new dependency

```js
modules: {
  memory:     { enabled: true, store: 'sqlite' },   // 'cosmos' on Functions
  humanInput: { enabled: true },                    // now requires memory
}
```

**`humanInput` without `memory` is a startup error, not a warning.** There is nowhere to put a
checkpoint. A warning would defer the failure to the first question — potentially days into a
deployment, on the one path that cannot degrade gracefully.

This is a real loss of independence and worth stating plainly: two optional modules become one
optional module and one that depends on it. It is the price of a single writer, accepted
deliberately.

`dispatch` is still required by `humanInput`, unchanged — there is nowhere to park a run on the
synchronous path.

---

## 3. Learning from answers

The learner already runs on settle. PR #63 guards it off for paused runs; once a resumed run
completes, it runs normally.

Answered batches are passed to the learner as a **distinct input block**, not folded into the
observation history. They are higher signal than a tool result and the prompt should say so. The
learner still writes the fact text — a deterministic conversion from question and answer would
produce facts nobody wants to read.

### What may be learnt

```
learnable   askedBy ∈ { tool, agent }   AND   kind ≠ 'approval'
never       askedBy = 'guardrail'        OR   kind = 'approval'
```

Both clauses are load-bearing. `askedBy` excludes the safety layer. `kind` closes the case where a
*tool* raises an approval question of its own — nothing in the kit prevents that, and without the
second clause it would slip through.

**A remembered approval is a guardrail that silently stopped working.** Permission is per-action and
per-moment. Somebody who approved one booking has not approved the next one, and an agent that
learns otherwise is worse than an agent that asks every time.

A property inherited from #63 makes this safe to feed a model: question prompts are plain language
**by contract** — no identifiers, no tool names, no parameter names. What reaches the learner is
already fit to store.

### When

On any settle **except `cancelled`**. A person who withdrew did not state a preference.

---

## 4. Recall consistency on resume

The original run recalls facts at start. A cold resume days later re-recalls, and can get a
different set: decay moved them, another run learnt something, someone edited memory through the
routes. The agent then behaves differently mid-task, and nothing in the record explains why.

**The checkpoint stores the recalled facts as used — ids *and* text.** A resumed run reproduces the
prompt the original had.

This is not the duplication this spec exists to remove. It records *what this run was given*, the
same way `step_completed` records the arguments a step actually ran with. Memory remains the source
of truth for which facts exist; the checkpoint records which ones this run saw.

A fact deleted or decayed between pause and resume is still reproduced from the checkpoint. That is
the intent: the run finishes on the basis it started on. Fresh facts reach the *next* run.

---

## 5. The conversation field

`host/human-input/snapshot.mjs` has a `conversation` field that **nothing populates** — it has been
dead since it was written.

`tasks.mjs` already computes `conversationHistory` from memory's conversation store and passes it to
`runTask`. The checkpoint stores that, for the same reproducibility reason as §4.

The field was right; it was never wired. This wires it rather than deleting it.

---

## 6. Changes to existing files

| File | Change |
|---|---|
| `host/checkpoint/record.mjs` | **new** — shape, version, validation |
| `host/checkpoint/index.mjs` | **new** — `createCheckpoint({ store })` |
| `host/memory/run-state.mjs` | **retired** — callers move to the checkpoint |
| `host/human-input/snapshot.mjs` | `capture`/`restore` retire; **`rebuildFromHistory` moves to the checkpoint module unchanged** |
| `host/strategies/plan-execute.mjs` | one checkpoint writer; `resumeStart`/`resumePending` already unified in #63 |
| `host/strategies/open-ended.mjs` | checkpoint writer for observations |
| `host/tasks.mjs` | pass `agentName`, `agentDescription`, `strategy`, `conversationHistory`, recalled facts to the checkpoint; answered batches to the learner |
| `host/jobs/in-process.mjs` | park/resume read the checkpoint; the record keeps only `pendingBatchId` |
| `host/jobs/durable.mjs` | orchestration output carries a pointer, not state |
| `comm/azure-functions/orchestrator.mjs` | `pause_too_large` guard becomes unreachable — keep as an assertion, not a path |
| `host/memory/learner.mjs` | accept an answered-batches input block |
| `host/config.mjs` | `humanInput` requires `memory` — startup error |
| `host/index.mjs` | wire the checkpoint; confirm memory reaches the Durable activity |

**Net effect is less code than today.** Two persistence layers become one.

---

## 7. Testing

| Property | Test |
|---|---|
| **Disposability** | delete the checkpoint, rebuild from history, demand an identical resume — the #63 contract, now governing the merged record |
| **One writer** | both triggers produce the same shape; no field is written by two paths |
| **Safety** | a guardrail answer is never learnt; a **tool-raised `approval`** is never learnt |
| **Reproducibility** | a resumed run's prompt contains the same recalled facts and conversation as the original |
| **New fields** | resuming under a changed `agentName` or `strategy` is refused or reported, not silently accepted |
| **Config** | `humanInput` without `memory` fails at startup, with a message naming the fix |
| **Runtime** | `memory` configured but failing to start is **fatal** when `humanInput` is on, not a warning |
| **Adapter** | sqlite on a VM, cosmos on Functions; no precedence logic exists to test |
| **Azure** | the orchestration output carries a pointer; a large pause no longer fails |
| **Learner** | answered batches reach it as a distinct block; `cancelled` runs learn nothing |

### Existing state

**No migration.** Checkpoints are in-flight state and disposable by design: a `version` bump makes
old ones unreadable, `rebuildFromHistory` covers anything mid-flight, and a run that loses its
checkpoint rebuilds from history. Memory landed days ago and #63 is unmerged, so the real-world
population is near zero.

---

## 8. Verified: memory reaches the Durable activity

Checked, because the whole Azure path depends on it. The plumbing already exists end to end:

```
host/index.mjs:347          startHost returns { …, memory, … }
azure-functions/main.mjs    hostContextFactory: { …, memory: started.memory, … }
activity.mjs:76             executeHostedTask({ …, memory: hostCtx.memory, … })
```

**No new plumbing is needed.** The activity can write the checkpoint to the memory store today.

### But `started.memory` can be null even when memory is configured

`host/index.mjs:203` treats a failed memory start as non-fatal:

```
[host] memory module failed to start — continuing without memory: <reason>
```

On a VM without human input that is a reasonable degrade — the agent loses recall and carries on.
**Under this spec it cannot be.** A run that pauses with no memory module has nowhere to put its
checkpoint, and the failure would surface at the first question rather than at startup.

So there are **two** failure points, not one, and §2 only covers the first:

| When | Today | Required |
|---|---|---|
| config: `humanInput` on, `memory` off | warning | **startup error** (§2) |
| runtime: `memory` configured but fails to start | warning, continues | **fatal when `humanInput` is on** |

The second is the sharper of the two: the configuration is correct, so nobody is looking for a
mistake. It must fail at startup with a message naming human input as the reason memory is no longer
optional — not at the first pause, hours later, on the one path that cannot degrade gracefully.

---

## 9. Out of scope

### MCP provenance — absent from the kit entirely

**Nothing anywhere records which MCP server a tool came from.** The registry is a flat in-process
array; a tool has a `name`, a schema and a `run` function, and no origin. So a checkpoint can say
*`geocode` was called with these arguments and returned this result*, but not *`geocode` came from
this server, at this version, reached over this transport*.

This matters for a paused run more than a live one. State that sits for a week and is then resumed
may run its next step against a **different** server than the one that produced the observations it
is reasoning about, and nothing would notice. During an incident, "which server actually served
this call" is unanswerable from the record.

Adding it means giving the registry an origin field, threading it through `extendRegistry`, and
recording it per step in the history — a change to the tool contract, and therefore its own spec.
**Recorded here so it is a known gap rather than a discovered one.**

### Also out of scope

- **Prompt text and per-step token accounting.** Only aggregate budget is kept. Reconstructing an
  exact prompt needs the prompt builders, not a stored copy.
- **Sharing learnt preferences across people.** Facts are learnt per the identity that answered.
  Whether one person's preference should inform another's run is a policy question this kit takes no
  position on.
- **Reversal interacting with memory.** If a reversal undoes work a fact was learnt from, that fact
  is not retracted. Rare, and the retraction semantics are not obvious.
