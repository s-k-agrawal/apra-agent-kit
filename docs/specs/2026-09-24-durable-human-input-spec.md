# Fleet Agent Kit — Durable Human Input

Status: proposed design — not yet implemented. Supersedes the approach in #30 that keeps a paused
run alive in the host process.

> **A note on the word "memory".** This document does not use it loosely. `memory` appears only as
> the name of an existing store backend (`store: { kind: 'memory' }` — the in-process Map used by
> tests, alongside `sqlite` and `cosmos`). Where the old approach is described, it is called
> *in-process* rather than *in-memory*.
>
> **This is unrelated to the kit's memory module** — the working context, long-term facts and recall
> described in `docs/specs/phase3-memory-eval-spec.md`. Nothing here reads, writes or depends on
> that module. A paused run's saved state is job storage, not agent memory.

## What this ships

A run that needs something from a person **saves its state, releases its worker, and stops**. When
the answer arrives — on any machine, after any restart — a fresh worker rebuilds the run and
continues. Nothing is held while waiting.

Five kinds of question, asked in batches, raised by the safety layer, the agent, or a capability.
Answers may revise the remaining plan and may reverse work already done. Ships for both deployment
targets in one go: **SQLite/local file** on a VM, **Cosmos** on Azure Functions.

## Relationship to existing code

This builds on the shipped Phase 4 jobs system and reuses its persistence contract rather than
adding a second one. The mapping is close to exact:

| Need | Existing mechanism |
|---|---|
| Append-only history | `store.appendEvent()` / `store.events()` |
| Snapshot | a field on the job record, persisted by `store.update()` |
| The open question | a field on the job record |
| Find everything paused | `store.listByStatus('waiting_input')` |

**No new store methods.** `STORE_METHODS` in `host/jobs/store/interface.mjs` is unchanged; Cosmos
becomes a third implementation of the same contract alongside `memory` and `sqlite`.

One correction to the original issue: the run loop, the strategies and guardrails change, but no
existing module is restructured. With human input disabled, behaviour is byte-for-byte what it is
today.

---

## 1. The question batch

One interruption carries many questions. A form, not a chat.

```js
{
  batchId: 'inp-a3f19c284d61',      // newRequestId()-style, unique per batch
  jobId: 'job-7c21b9e4f038',
  askedBy: 'guardrail' | 'agent' | 'tool',
  askedByDetail: 'logbook_create',  // tool name, or null for agent/guardrail
  questions: [ /* Question[] — see below */ ],
  askedAt:    '2026-09-24T09:14:22.104Z',
  staleAfter: '2026-09-25T09:14:22.104Z',   // soft: warn on resume past this
  expiresAt:  '2026-10-01T09:14:22.104Z',   // hard: treated as refused past this
}
```

### Question

```js
{
  fieldId: 'building',              // unique within the batch; the answer key
  kind: 'approval' | 'pick_one' | 'pick_many' | 'text' | 'pick_one_or_text',
  prompt: 'Which building is this for?',   // plain language — see the rule below
  options: [                        // choice kinds only
    { value: 'b-1f2e', label: 'Tower A' },
    { value: 'b-9a44', label: 'Riverside' },
  ],
  allowOther: false,                // pick_one_or_text: show a free-text box too
  otherPrompt: null,                // label for that box
  required: true,
  default: null,                    // pre-selected value, if any
}
```

`approval` carries no options — it is always two fixed outcomes, and is a distinct kind rather than
a two-item `pick_one` because the guardrail must be able to recognise permission as permission.

### The plain-language rule

**Normative, not stylistic.** `prompt` and `label` contain no identifiers, no tool names, no
parameter names, no internal structure.

```
good:  "Create an incident entry for Tower A saying 'fire in the basement'?"
bad:   "Execute logbook_create with sLogBookTypeId=5, BuildingId=a3f1-…?"
```

Two reasons: a question nobody understands trains people to approve reflexively, and internal
structure on a screen is an information-disclosure surface. `options[].value` may be an opaque
identifier; `options[].label` may not.

### The answer

```js
{
  batchId: 'inp-a3f19c284d61',
  answers: {
    building: 'b-9a44',                       // pick_one → option value
    scope:    ['s-11', 's-12'],               // pick_many → array of values
    summary:  'Sprinklers activated level 2', // text → string
    category: { other: 'Water ingress' },     // pick_one_or_text → chose Other
    proceed:  'approve',                      // approval → 'approve' | 'deny'
  },
  answeredBy: 'person-6f2a',
  answeredAt: '2026-09-24T09:31:07.882Z',
}
```

Validated **as a set** before anything resumes: every `required` field present, every value legal
for its kind, no unknown keys. A partial or invalid submission is rejected whole — it never resumes
the run partially.

### Limits

`maxInterruptions` per task, default `10`, counted in **interruptions not questions** — ten fields in
one batch is one interruption. On exceeding it the run settles `failed` with
`error.code = 'too_many_interruptions'`.

---

## 2. History — the source of truth

Append-only, ordered, never edited. Written through the existing `store.appendEvent()`.

```js
{ seq, jobId, type, at, ...payload }
```

| `type` | Payload |
|---|---|
| `run_started` | `{ task, traceId }` |
| `planned` | `{ plan, replanOf? }` — `replanOf` names the batch that caused a revision |
| `step_started` | `{ stepIndex, stepType, tool?, args? }` |
| `step_completed` | `{ stepIndex, result, reversible, undo? }` — `undo` captures what a later reversal would need |
| `step_failed` | `{ stepIndex, error }` |
| `question_asked` | `{ batch }` — the full batch as sent |
| `answer_received` | `{ batchId, answers, answeredBy }` |
| `question_expired` | `{ batchId, at }` |
| `reversal_planned` | `{ batchId, steps: [{ stepIndex, mode }], undoable, notUndoable }` |
| `reversal_step` | `{ stepIndex, outcome: 'undone' \| 'failed', error? }` |
| `reversal_finished` | `{ undone, failed, skipped }` |
| `run_settled` | `{ status, result, error }` |

`step_completed.undo` is captured **at execution time**, not reconstructed later — the arguments
needed to reverse a step are often derivable only from its result.

**History is never ring-buffered.** `ringEvents()` exists for the Azure `customStatus` view, which
has a hard size limit; it must not be applied to the stored history. On Azure the history therefore
lives in Cosmos, and `customStatus` remains a live-progress view only, never a source of truth.

---

## 3. Snapshot — a disposable cache

Written at each pause so a normal resume is one read rather than a full replay. Stored on the job
record.

```js
{
  version: 1,                    // bumped on any breaking shape change
  kitVersion: '0.1.0',
  jobId, traceId,
  writtenAt: '2026-09-24T09:14:22.104Z',
  task,                          // goal, inputs, constraints, budget
  conversation: [ /* full message history from the start */ ],
  plan: { steps: [...], cursor: 3 },
  observations: [ /* what the strategies carry today */ ],
  budget: { iterations, totalInputTokens, totalOutputTokens, elapsedMs },
  identity: { personId, tenantId? },   // who the work is for — never a credential
  pendingBatchId: 'inp-a3f19c284d61',
}
```

**Rebuild rule:** the snapshot is a cache. If absent, unreadable, or written at an incompatible
`version`, it is rebuilt from history. Nothing may exist only in the snapshot. A test asserts this
by deleting the snapshot and requiring an identical resume.

**Credentials are never persisted.** `identity` records *who*, never the bearer that proves it. A
resumed run re-acquires authority the same way a fresh run does. These records live for days.

---

## 4. Storage

### Contract

Unchanged — `STORE_METHODS` in `host/jobs/store/interface.mjs`. Human input needs no new methods.

### Backends

| Backend | Target | Notes |
|---|---|---|
| `memory` | tests | existing — an in-process Map, not the kit's memory module |
| `sqlite` | VM / local file | existing; record is already a JSON column, so snapshot and pending need no migration |
| `cosmos` | Azure Functions | **new** — same contract |

### Cosmos partitioning — a decision this spec makes

Partitioning by `jobId` is right for the hot path (all reads and writes for one job hit one
partition) but makes `listByStatus('waiting_input')` a cross-partition query — and that is exactly
what the staleness sweep runs on a schedule.

**Decision: a small secondary `pending` collection**, partitioned by a coarse bucket (for example
`yyyy-mm` of `askedAt`), holding one lightweight document per waiting job:
`{ jobId, batchId, personId, askedAt, staleAfter, expiresAt }`. Written when a job pauses, deleted
when it resumes or settles.

The sweep and any future notification job read only this collection. The alternative — a synthetic
status partition key — keeps everything in one container but makes the hot path pay for a query it
never needs. The duplication is small, bounded by the number of *currently waiting* jobs, and always
reconstructible from `listByStatus`.

SQLite needs none of this; `listByStatus` is already indexed.

---

## 5. Pause and resume

### Status model

`waiting_input` joins `STATUSES`. `TERMINAL_STATUSES` is unchanged, so every terminal check in the
notifier and the SSE handler keeps working untouched.

```js
queued:        → processing | cancelled
processing:    → waiting_input | <terminal>
waiting_input: → processing | cancelled | failed
```

### Pausing

1. Capture the snapshot; append `question_asked`.
2. Persist both, plus `pendingInput` on the record; write the `pending` row on Cosmos.
3. Transition to `waiting_input`; publish `input_required`.
4. **Release the worker lease and return.** The run unwinds out of the run loop rather than blocking
   inside it.

If any of 1–3 fails, the pause fails and the run settles `failed`. It must never continue as though
it had asked and been refused — that executes something nobody declined.

### Resuming

1. Validate the answer against the batch.
2. Conditional write of `answer_received`, keyed on `batchId` — first writer wins.
3. Clear `pendingInput`; delete the `pending` row; transition to `processing`.
4. Enqueue a resume.
5. A worker acquires a **fresh** lease, loads the snapshot (or rebuilds from history), appends the
   answer as an observation, and continues.

**Completed work is never re-executed.** Resume restores state; it does not replay side effects.

### Resume trigger, per backend

**VM / SQLite.** The input endpoint enqueues the job onto the existing queue. `pump()` picks it up
like any other work — no new scheduler, no polling loop.

**Azure Functions.** The orchestration **ends at the pause**: the activity returns a `paused`
outcome, the orchestration completes, and the job sits in `waiting_input` with nothing alive. The
answer write **starts a new orchestration** seeded with the job id, which loads the record and
continues.

This is the crux, and it is why the replay bug cannot recur: *we do not resume an orchestration, we
start another one.* No `waitForExternalEvent`, no `Task.any`, no growing replay history, no activity
billed while idle.

### Lease release

The genuinely new work. Today a lease is held across the whole of `executeHostedTask`. Pausing must
release it, and resuming must acquire a fresh one. The pause therefore returns a distinguished
outcome from `runTask` rather than blocking:

```js
{ status: 'paused', batchId, snapshot, history }
```

`executeHostedTask` persists it and returns; the jobs backend transitions and releases. With
`dispatch.concurrency: 1` this is what stops one unanswered question from stalling the agent.

---

## 6. Guardrails integration

`config.approvalCallback` keeps **precedence**. An adopter with their own transport sees no change.

```
policy resolves to 'approve'
  ├─ approvalCallback configured?     → call it (today's behaviour)
  ├─ askUser available?               → raise a one-question batch, kind 'approval'
  └─ neither                          → deny, reason 'approval_denied'
```

A `deny`, an expiry, or a cancellation all produce `{ ok: false, reason: 'approval_denied' }`. The
`approvedBy` / `reason` recorded on the result keeps the shape introduced in #45.

`askUser` reaches guardrails on `executorArgs`, threaded `tasks.mjs → run-loop.mjs → strategies →
executorArgs` — the same path `traceId` already takes.

---

## 7. Budgets

`createBudgets()` gains `pause()`, `resume()`, `paused()`. `snapshot().elapsedMs` and the
`timeoutMs` check both exclude paused time. Tokens and cost need nothing — nothing is consumed while
waiting.

**The pause is called from `host/tasks.mjs`, not from the jobs backend.** The backend has no budget
to pause; calling it there silently does nothing while the budget expires anyway. A regression test
covers the wired path end to end rather than the module in isolation, because unit-testing
`createBudgets` alone does not catch this.

Across a pause the elapsed clock is reconstructed from the snapshot, so budget survives the restart.

---

## 8. Reversal

### Declaration — additive, non-breaking

Two optional fields on a tool definition:

```js
{
  name: 'logbook_create',
  reversible: false,
  undo: {
    mandatory: false,                 // true → reversed automatically, person told after
    run: async ({ result, args, fleetApi }) => { /* the reverse action */ },
    describe: ({ result }) => 'the logbook entry I created',   // plain language
  },
}
```

**A tool that declares no `undo` cannot be undone.** Silence means no. Every existing tool definition
keeps working unchanged, and read-only tools need nothing.

### Groups

| Group | On correction |
|---|---|
| Read-only | nothing |
| `undo.mandatory: true` | reversed automatically; the person is told after |
| `undo` present, not mandatory | the person chooses (default) — see the setting |
| no `undo` | disclosed in plain language, never reversed |

### Execution

Reverse order, last first. Each step appends `reversal_step`. On failure: retry (default 3, backoff),
then **stop, pause, and report** — plus raise an operator-facing flag in logs and in the chat, because
this is the case where the people who own the code need to know. A half-reversed system is worse than
either end state and is never swallowed.

Reversal is **exempt from the task budget** — refusing to clean up because the meter ran out is the
worst available outcome. Selecting the steps **is** the approval; reversals are not separately gated.

Reversal undoes *what this task did*. It does not restore a pristine earlier state, and concurrent
changes by others are neither detected nor corrected. The report states what was attempted.

### Who decides on optional reversals

```js
humanInput: { optionalReversal: 'ask' | 'agent' }   // default 'ask'
```

`agent` mode is bounded by four rules: it always reports what it did and why; the reasoning is
appended to history; it may only choose among steps already declared optional-reversible; and if its
decision would reverse **everything**, it asks anyway regardless of the setting.

**Ships without consumers.** All current tools are read-only, so the executor has nothing to reverse
on day one. The framework ships now because the history model supports it cleanly and retrofitting
`step_completed.undo` later would mean losing it for every run written before.

---

## 9. Timeouts

Two thresholds, because they answer different concerns.

| | Default | Meaning |
|---|---|---|
| `staleAfter` | 24h | **Soft.** On resume past this, warn the person that the situation may have changed and confirm before continuing. |
| `expiresAt` | 7d | **Hard.** The batch expires, the pending action is treated as refused, the run settles, history is kept. |

The hard stop exists because *resuming stale work has a real cost*: the model is re-fed the whole
history, the world may have moved, and a cold resume can be worse than a fresh start. Compute while
waiting is free; **quality on resume is not**.

Both are configurable. The staleness sweep runs on a schedule and reads only the `pending`
collection.

### Cancel while waiting

Straightforward precisely because nothing is running: transition to `cancelled`, discard the batch,
delete the `pending` row, emit `input_resolved` with `resolution: 'cancelled'`. No abort signal, no
force-settle timer, no grace period.

---

## 10. HTTP, events and MCP

### Routes

```
POST /jobs/:id/input
  { batchId, answers: { <fieldId>: <value>, … } }
  → 200  { ok: true, status: 'processing' }
  → 400  validation_failed   { fields: { <fieldId>: <reason> } }
  → 404  not_found
  → 409  not_waiting | batch_mismatch | already_answered
  → 410  batch_expired

GET /jobs/:id
  → 200  { …record, pendingInput: <batch> | null, stale: true|false }
```

### Events

```js
{ type: 'input_required', jobId, batchId, questions, askedBy, staleAfter, expiresAt, at, seq }
{ type: 'input_resolved', jobId, batchId, resolution: 'answered'|'timeout'|'cancelled', at, seq }
```

Delivered over the existing notifier, so SSE and webhook both carry them with no transport change.

### MCP tool

`job-input` — `{ jobId, batchId, answers }`, mirroring the route exactly. `reversible: true`:
answering is not itself a mutation, and marking it otherwise would mean an approval needing its own
approval.

### Authorization

The answer is accepted only from the person who started the task (`identity.personId`). Trivially
satisfied by today's single-user chats; the check exists so that stays true if chats are ever shared.
A batch id is not a capability.

---

## 11. Configuration

```js
modules: {
  humanInput: {
    enabled: false,
    maxInterruptions: 10,
    staleAfterMs: 86_400_000,        // 24h — warn on resume
    expiresAfterMs: 604_800_000,     // 7d  — hard expiry, treated as refused
    optionalReversal: 'ask',         // 'ask' | 'agent'
    reversalRetries: 3,
    sweepIntervalMs: 300_000,        // staleness/expiry sweep
  },
},
dispatch: {
  store: { kind: 'sqlite' | 'memory' | 'cosmos', /* cosmos: endpoint, database, containers */ },
},
```

**Dependency rules:** `humanInput` requires `dispatch.enabled` — there is nowhere to park a run on
the synchronous `/task?wait=true` path, so enabling one without the other logs a warning and leaves
guardrails behaving exactly as they do today.

---

## 12. Directory structure (new files)

```
host/human-input/
  batch.mjs            ← batch + question shapes, validation, newBatchId()
  questions.mjs        ← the five kinds, per-kind answer validation
  ask.mjs              ← createAskUser() — raise a batch, persist, signal pause
  resume.mjs           ← validate an answer, rebuild state, produce the resume
  snapshot.mjs         ← capture / restore / rebuild-from-history
  sweep.mjs            ← staleness warning + hard expiry
  reversal/
    plan.mjs           ← classify executed steps into the four groups
    execute.mjs        ← reverse order, retries, operator flag on failure
    describe.mjs       ← plain-language rendering of what can and cannot be undone
  index.mjs            ← createHumanInput() wires the enabled pieces

host/jobs/store/
  cosmos.mjs           ← third implementation of STORE_METHODS
```

## 13. Changes to existing files

| File | Change |
|---|---|
| `host/jobs/record.mjs` | `waiting_input` in `STATUSES`; transitions; `pendingInput` and `snapshot` on the record; `inputRequiredEvent` / `inputResolvedEvent`; history entry builders |
| `host/jobs/in-process.mjs` | handle a `paused` outcome: persist, transition, **release the lease**; `provideInput()`; enqueue a resume; release waiters on `stop()` |
| `host/jobs/durable.mjs` | `provideInput()` starts a **new** orchestration; `pendingInput()` reads the record |
| `comm/azure-functions/orchestrator.mjs` | complete the orchestration on a `paused` activity outcome — **no `waitForExternalEvent`, no `Task.any`** |
| `comm/azure-functions/activity.mjs` | return `paused` rather than blocking |
| `host/jobs/config.mjs` | `humanInput` block, defaults, dependency warnings; `cosmos` store kind |
| `host/tasks.mjs` | inject `askUser`; wrap it in budget `pause`/`resume`; handle the `paused` return |
| `host/run-loop.mjs` | thread `askUser`; return `{ status: 'paused', … }` instead of blocking |
| `host/strategies/*.mjs` | pass `askUser` on `executorArgs`; propagate a pause; accept an answer as an observation and allow a replan |
| `host/guardrails.mjs` | prefer `approvalCallback`, fall back to `askUser`; unchanged when neither is present |
| `host/budgets.mjs` | `pause()` / `resume()` / `paused()`; elapsed excludes paused time; restore from snapshot |
| `host/routes.mjs` | `POST /jobs/:id/input`; `pendingInput` and `stale` on `GET /jobs/:id` |
| `host/tools/jobs-tools.mjs` | `job-input` tool |
| `host/tools/registry.mjs` | `undo` passes through `extendRegistry` untouched |
| `host/index.mjs` | wire `createHumanInput()`; start the sweep; `.humanInput()` on the builder |

---

## 14. Testing

### Unit

| Area | Covers |
|---|---|
| `batch.mjs` / `questions.mjs` | each of the five kinds; required-field validation; unknown keys rejected; `pick_many` empty vs missing; `pick_one_or_text` with and without Other |
| `snapshot.mjs` | round-trip capture/restore; **rebuild from history with the snapshot deleted produces an identical run**; incompatible `version` refuses rather than guesses; no credential field survives capture |
| `record.mjs` | transition table including every illegal edge; history entry shapes; `ringEvents` never applied to stored history |
| `budgets.mjs` | elapsed excludes paused time; `timeoutMs` does not trip while paused; pause/resume idempotent; restore from snapshot |
| `reversal/plan.mjs` | classification into the four groups; a tool with no `undo` lands in *cannot* |
| `reversal/execute.mjs` | reverse order; retry then stop; operator flag raised; partial selection honoured |
| `reversal/describe.mjs` | rendering contains no identifier, tool name or parameter name |
| `guardrails.mjs` | `approvalCallback` keeps precedence; `askUser` used only when absent; deny/expiry/cancel all refuse; neither present behaves exactly as today |
| `sweep.mjs` | staleness marks without settling; expiry settles as refused |
| `cosmos.mjs` | the shared store-contract suite, against an emulator |

The existing `tests/helpers/store-contract.mjs` runs unchanged against all three backends — the
strongest evidence that Cosmos is a drop-in.

### Integration

Each of these is a success criterion, written as a test:

| Test | Asserts |
|---|---|
| Pause, **restart the host**, answer, complete | the core promise — state survives a process death |
| Pause, answer **on a second instance** | any machine can accept an answer |
| Two jobs, one paused | the other is unaffected — no stall at `concurrency: 1` |
| Worker released while waiting | pool reports a free slot during the pause |
| Two answers race | first wins, second gets `409`, run resumes once |
| Answer a cancelled job | `409`, no resume |
| Answer past `expiresAt` | `410`, run settled refused |
| Resume past `staleAfter` | warning surfaced before continuing |
| Storage unreachable at pause | run settles `failed` — never silently continues as refused |
| Snapshot deleted mid-pause | rebuild from history, identical resume |
| Batch of five mixed kinds | one interruption, one answer, correct resumption |
| Answer triggers a replan | revised plan executes; history records `replanOf` |
| Reversal with a mix of groups | mandatory undone, optional per selection, irreversible disclosed |
| Reversal failure | stops, reports, raises the operator flag |
| Azure: pause ends the orchestration | no orchestration alive during the wait |
| Azure: answer starts a new orchestration | resumes correctly; no replay growth |

**Existing suites must keep passing unchanged** — `test:host`, `test:phase2`, `test:phase4`,
`test:unit`, `test:integration` — and the durable-human-input tests join `test:host`.

---

## What this spec does not cover

- **The interface.** This defines what the service exposes; building the screen that renders a batch
  and collects answers is separate work.
- **Notifying someone who is not watching** — email, chat, push. Out of scope, tracked separately.
  The `pending` collection is the attachment point; nothing here builds on it.
- **Automatic approval rules** — "always allow this for this person". Every question reaches a human.
- **Live/no-persistence mode and WebSocket transport** — tracked in #57.
- **The existing durable `cancel` defect** — `cancelRequested` is never set, so cancel does nothing
  to a running activity. Real and worth fixing, but independent: this design never needs an external
  event delivered to a live activity.
- **Retention.** Histories and snapshots hold full conversations and accumulate. Needs an owner.
