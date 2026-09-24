# Durable Human Input — Implementation Plan

**Goal:** A run that needs something from a person saves its state, releases its worker and stops;
when the answer arrives — on any machine, after any restart — a fresh worker rebuilds it and
continues. Five question kinds, asked in batches, by the safety layer, the agent or a capability.
Answers may revise the plan and may reverse completed work. Both deployment targets in one go.

**Spec:** `docs/specs/2026-09-24-durable-human-input-spec.md`

**Architecture:** No new persistence layer. The Phase 4 job store already provides history
(`appendEvent`/`events`), snapshot and pending question (fields on the record, via `update`), and
"find everything paused" (`listByStatus`). Cosmos becomes a third implementation of the unchanged
`STORE_METHODS`. The run loop gains a `paused` outcome so a pause unwinds out of it rather than
blocking inside it — which is what allows the lease to be released.

**Tech Stack:** Node 22 (≥ 22.16), ESM, `node:test`, `node:sqlite`, Zod v4, Express 5,
`@azure/functions` v4 + `durable-functions` v3 (optional, lazy-loaded), `@azure/cosmos` (new,
optional, lazy-loaded), Azurite + Cosmos emulator for tests.

## Global constraints

- Node `>=22.16`. `node:sqlite` via `DatabaseSync` only.
- `@azure/cosmos` is an **optional** dependency, imported lazily only when `store.kind === 'cosmos'`.
  Non-Azure paths never load it.
- Errors are values inside tools and the run loop. Only `AbortSignal` cancellation throws.
- With `humanInput.enabled: false`, behaviour is byte-for-byte what it is today. Every task must
  leave that true.
- `TERMINAL_STATUSES` does not change. `waiting_input` is non-terminal.
- History is never ring-buffered. `ringEvents()` stays confined to the Azure `customStatus` view.
- No credential is ever written to a snapshot or a history entry.
- Sync `POST /task?wait=true` keeps its exact response shape.
- `test:host`, `test:phase2`, `test:phase4`, `test:unit`, `test:integration` keep passing after
  every task.
- Work happens on `feature/durable-human-input`, cut from `main`.
- **Commits:** no AI attribution lines, ever. Each "Commit" step means stage the listed files, show
  `git status`, and commit **only after the user approves**. Never push to `main`.
- **No implementation begins until Sid approves the spec.** This plan is written ahead of that
  approval so the shape is reviewable, not so work can start.

---

## Task dependency graph

```
Task 0   branch + optional dep                    (first)
Task 1   question batch + validation              (independent)
Task 2   history entry builders + status model    (independent)
Task 3   snapshot capture / restore / rebuild     (needs 2)
Task 4   budgets pause/resume                     (independent)
Task 5   run-loop 'paused' outcome                (needs 1, 3)
Task 6   askUser + strategies threading           (needs 5)
Task 7   guardrails fallback                      (needs 6)
Task 8   in-process pause/resume + lease release  (needs 3, 5)
Task 9   routes + MCP tool                        (needs 8)
Task 10  sweep: staleness + expiry                (needs 8)
Task 11  cosmos store                             (needs 2, 3)
Task 12  azure: pause ends orchestration          (needs 8, 11)
Task 13  reversal: classify + describe            (needs 2)
Task 14  reversal: execute + operator flag        (needs 13)
Task 15  replan on answer                         (needs 6)
Task 16  config + wiring + builder                (needs all)
Task 17  integration suite                        (needs 16)
Task 18  docs                                     (needs 16)
```

Tasks 1–4 are independent and can run in parallel. Task 11 (Cosmos) is independent of 5–10 and can
proceed alongside them.

---

## Tasks

### Task 0 — Branch and optional dependency
- [ ] Branch `feature/durable-human-input` from `main` *(already created)*
- [ ] Add `@azure/cosmos` to `optionalDependencies`
- [ ] Verify it is never imported at module load on a non-Cosmos path
- [ ] **Commit**

### Task 1 — Question batch and validation
- [ ] `host/human-input/questions.mjs` — the five kinds, per-kind answer validation
- [ ] `host/human-input/batch.mjs` — batch shape, `newBatchId()`, whole-set validation
- [ ] Unit tests: each kind; required missing; unknown key; `pick_many` empty vs absent;
      `pick_one_or_text` with and without Other; a batch validating atomically
- [ ] **Commit**

### Task 2 — History entries and status model
- [ ] `host/jobs/record.mjs` — `waiting_input` in `STATUSES`; transitions; `pendingInput` and
      `snapshot` on `createRecord`; `inputRequiredEvent` / `inputResolvedEvent`; the history entry
      builders from spec §2
- [ ] Unit tests: every legal and illegal transition; entry shapes; `TERMINAL_STATUSES` unchanged;
      a test asserting `ringEvents` is not applied to stored history
- [ ] **Commit**

### Task 3 — Snapshot
- [ ] `host/human-input/snapshot.mjs` — `capture()`, `restore()`, `rebuildFromHistory()`
- [ ] Version field; refuse an incompatible version rather than guessing
- [ ] Unit tests: round trip; **delete the snapshot and require an identical resume from history**;
      incompatible version refuses; no credential field survives capture
- [ ] **Commit**

### Task 4 — Budget pause
- [ ] `host/budgets.mjs` — `pause()`, `resume()`, `paused()`; elapsed and `timeoutMs` exclude paused
      time; restore elapsed from a snapshot
- [ ] Unit tests: elapsed excludes paused; `timeoutMs` does not trip while paused; idempotent;
      restored elapsed continues correctly
- [ ] **Commit**

### Task 5 — Run loop returns `paused`
- [ ] `host/run-loop.mjs` — `{ status: 'paused', batchId, snapshot, history }` instead of blocking
- [ ] Interruption counter; `too_many_interruptions` on exceeding `maxInterruptions`
- [ ] Unit tests with a mock fleet: a pause unwinds cleanly; the counter trips at the limit
- [ ] **Commit**

### Task 6 — `askUser` and strategy threading
- [ ] `host/human-input/ask.mjs` — `createAskUser()`
- [ ] `host/tasks.mjs` — inject; wrap in budget pause/resume (**here, not in the jobs backend**);
      handle the `paused` return
- [ ] Both strategies — `askUser` on `executorArgs`; propagate a pause
- [ ] Unit tests: reaches `executorArgs`; a regression test proving the **wired** budget pause fires
      end to end, not just `createBudgets` in isolation
- [ ] **Commit**

### Task 7 — Guardrails fallback
- [ ] `host/guardrails.mjs` — `approvalCallback` keeps precedence; `askUser` used only when absent;
      deny, expiry and cancel all refuse
- [ ] Unit tests including: with neither present, behaviour is exactly today's
- [ ] **Commit**

### Task 8 — In-process pause, resume, lease release
- [ ] `host/jobs/in-process.mjs` — handle `paused`: persist, transition, **release the lease**;
      `provideInput()` with conditional first-writer-wins; enqueue a resume; `pendingInput()`
- [ ] Cancel while waiting; release waiters on `stop()`
- [ ] Unit tests: full cycle; worker released during the pause; two answers race; cancel while
      waiting; answer for a terminal job
- [ ] **Commit**

### Task 9 — Routes and MCP tool
- [ ] `host/routes.mjs` — `POST /jobs/:id/input`; `pendingInput` + `stale` on `GET /jobs/:id`
- [ ] `host/tools/jobs-tools.mjs` — `job-input`
- [ ] Authorization: answer accepted only from `identity.personId`
- [ ] Unit tests: 200/400/404/409/410; field-level validation errors; route inventory updated;
      an answer from the wrong person is refused
- [ ] **Commit**

### Task 10 — Staleness and expiry sweep
- [ ] `host/human-input/sweep.mjs` — mark stale, settle expired as refused
- [ ] Unit tests: stale marks without settling; expiry settles refused; a job answered meanwhile is
      left alone
- [ ] **Commit**

### Task 11 — Cosmos store
- [ ] `host/jobs/store/cosmos.mjs` — `STORE_METHODS`, lazy `@azure/cosmos`
- [ ] Secondary `pending` collection per spec §4, written on pause and deleted on resume/settle
- [ ] Run the **existing shared store-contract suite** unchanged against it
- [ ] Unit tests against the Cosmos emulator; the sweep reads only `pending`
- [ ] **Commit**

### Task 12 — Azure: the pause ends the orchestration
- [ ] `comm/azure-functions/activity.mjs` — return `paused` rather than blocking
- [ ] `comm/azure-functions/orchestrator.mjs` — complete on a `paused` outcome. **No
      `waitForExternalEvent`, no `Task.any`** — the replay bug documented in that file must not
      return
- [ ] `host/jobs/durable.mjs` — `provideInput()` starts a **new** orchestration
- [ ] Unit tests with the existing mocks: no orchestration alive during a wait; a new one starts on
      answer; replay history does not grow across a pause
- [ ] **Commit**

### Task 13 — Reversal: classify and describe
- [ ] `host/human-input/reversal/plan.mjs` — the four groups; no `undo` ⇒ *cannot*
- [ ] `host/human-input/reversal/describe.mjs` — plain-language rendering
- [ ] Unit tests: classification; **rendering contains no identifier, tool name or parameter name**
- [ ] **Commit**

### Task 14 — Reversal: execute
- [ ] `host/human-input/reversal/execute.mjs` — reverse order; retries; stop-and-pause on failure;
      operator flag in logs **and** chat; exempt from the task budget
- [ ] `optionalReversal: 'ask' | 'agent'`, with the four `agent`-mode safeguards
- [ ] Unit tests: order; partial selection; retry then stop; flag raised; agent mode asks anyway when
      it would reverse everything
- [ ] **Commit**

### Task 15 — Replan on answer
- [ ] Strategies accept an answer as an observation and may revise the remaining plan
- [ ] History records `planned` with `replanOf`
- [ ] Unit tests: revised plan executes; original plan recorded alongside the revision
- [ ] **Commit**

### Task 16 — Config and wiring
- [ ] `host/jobs/config.mjs` — `humanInput` block, defaults, `cosmos` kind, dependency warning when
      `humanInput` is enabled without `dispatch`
- [ ] `host/human-input/index.mjs` — `createHumanInput()`
- [ ] `host/index.mjs` — wire, start the sweep, `.humanInput()` on the builder
- [ ] Unit tests: defaults; warnings; disabled leaves today's behaviour exactly
- [ ] **Commit**

### Task 17 — Integration suite
- [ ] `tests/host-human-input-e2e.test.mjs` — every row of spec §14 *Integration*
- [ ] Add to `test:host`
- [ ] Confirm the full baseline is unchanged: run each existing suite before and after and diff the
      failing test **names**, not the counts
- [ ] **Commit**

### Task 18 — Documentation
- [ ] `docs/CONTRACT.md` — the built-in transport beside the hand-written callback
- [ ] `docs/kit-adoption-gaps.md` — close the human-in-the-loop row
- [ ] `docs/README.md` / `docs/architecture.md` — the pause/resume model
- [ ] **Commit**

---

## Testing strategy

**Unit** — every module in spec §14. Three carry more weight than the rest:

- **Snapshot rebuild.** Deleting the snapshot and requiring an identical resume from history is what
  keeps the snapshot honestly disposable. Without it, the cache quietly becomes the source of truth.
- **Wired budget pause.** Testing `createBudgets` alone does not prove the pause is called from the
  right layer. An earlier attempt placed it in the jobs backend, where no budget exists — it silently
  did nothing while the budget expired anyway. The test must exercise
  `executeHostedTask → askUser → guardrails`.
- **Disabled-path equivalence.** With `humanInput.enabled: false`, guardrails and the run loop must
  behave exactly as today.

**Integration** — the success criteria as tests, listed in spec §14. The three that matter most are
*pause → restart the host → answer → complete*, *answer on a second instance*, and *worker released
while waiting*, because those are the three things the current in-memory design cannot do.

**Regression discipline** — before and after each task, run the existing suites and compare failing
test **names**. Counts hide a swap of one failure for another. Known pre-existing failures on Windows
(chat e2e, azure adapter) are excluded by name, not by count.

---

## Open questions carried from the spec

These do not block starting, but each needs an answer before the relevant task:

1. **Cosmos partitioning** (Task 11) — the spec chooses a secondary `pending` collection over a
   synthetic status partition key. Confirm before building.
2. **Hard expiry default** (Task 10) — 7d proposed, 72h a reasonable alternative.
3. **Retention** (not scheduled) — histories and snapshots hold full conversations and accumulate.
   Needs an owner; out of scope here.
