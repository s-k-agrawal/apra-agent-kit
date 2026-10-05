# Durable Human Input — Implementation Plan

*"Memory" is not used loosely in this plan. `memory` names an existing store backend only; the
approach being replaced is called *in-process*. Neither relates to the kit's memory module in
`docs/specs/phase3-memory-eval-spec.md`.*

*"Expiry" means two different things in this work, and they are named apart throughout. **Question
expiry** is a batch nobody answered (default 7d, §9 of the spec) — it settles the run as refused.
**Record retention** is clearing settled job records from storage (default 30d, §4.4) — it is
housekeeping. A task that says "retention" never means a question.*

**Goal:** A run that needs something from a person saves its state, releases its worker and stops;
when the answer arrives — on any machine, after any restart — a fresh worker rebuilds it and
continues. Five question kinds, asked in batches, by the safety layer, the agent or a capability.
Answers may revise the plan and may reverse completed work. Both deployment targets in one go.

**Spec:** `docs/specs/2026-09-24-durable-human-input-spec.md`

**Architecture:** No new persistence layer and no new storage service. The Phase 4 job store already
provides history (`appendEvent`/`events`), snapshot and pending question (fields on the record, via
`update`), and "find everything paused" (`listByStatus`). On Azure the **task hub stays the store**,
exactly as the durable jobs spec already says: the paused orchestration's *output* carries history
and snapshot, and a small `customStatus` marker makes it findable. The run loop gains a `paused`
outcome so a pause unwinds out of it rather than blocking inside it — which is what allows the lease
to be released.

**Retention** is separate and configurable: `store.kind: 'auto'` picks sqlite on a VM and the task
hub on Functions; an optional archive copies settled runs to a long-term store before expiry clears
the primary; record retention runs on a timer, by an API call, or both. Purging is load-bearing —
the sweep that expires unanswered questions scans completed instances, so an un-purged store
degrades it until it stops working — which is why the paused-run skip is bounded rather than
absolute.

**Tech Stack:** Node 22 (≥ 22.16), ESM, `node:test`, `node:sqlite`, Zod v4, Express 5,
`@azure/functions` v4 + `durable-functions` v3 (optional, lazy-loaded), Azurite for tests.
The only new package is `@azure/cosmos`, optional and required by no shipped deployment.

## Global constraints

- Node `>=22.16`. `node:sqlite` via `DatabaseSync` only.
- `@azure/cosmos` is **optional** and lazily imported. It is never loaded unless a Cosmos store is
  actually selected. No shipped deployment selects it.
- Errors are values inside tools and the run loop. Only `AbortSignal` cancellation throws.
- With `humanInput.enabled: false`, behaviour is byte-for-byte what it is today. Every task must
  leave that true.
- `TERMINAL_STATUSES` does not change. `waiting_input` is non-terminal.
- History is never ring-buffered. `ringEvents()` stays confined to the Azure `customStatus` view.
- No credential is ever written to a snapshot or a history entry.
- **Never purge what failed to archive.** When archiving is enabled, a failed copy blocks the purge
  for that record.
- Sync `POST /task?wait=true` keeps its exact response shape.
- `test:host`, `test:phase2`, `test:phase4`, `test:unit`, `test:integration` keep passing after
  every task.
- Work happens on `feature/durable-human-input`, cut from `main`.
- **Commits:** no AI attribution lines, ever. Each "Commit" step means stage the listed files, show
  `git status`, and commit **only after the user approves**. Never push to `main`.
- **No implementation begins until the spec is approved.** This plan is written ahead of that
  approval so the shape is reviewable, not so work can start.

---

## Task dependency graph

```
Task 0   branch                                   (first)

  core ─────────────────────────────────────────────────────
Task 1   question batch + validation              (independent)
Task 2   history entries + status model           (independent)
Task 3   snapshot capture / restore / rebuild     (needs 2)
Task 4   budgets pause/resume                     (independent)
Task 5   run-loop 'paused' outcome                (needs 1, 3)
Task 6   askUser + strategies threading           (needs 5)
Task 7   guardrails fallback                      (needs 6)
Task 8   in-process pause/resume + lease release  (needs 3, 5)
Task 9   routes + MCP tool                        (needs 8)
Task 10  question sweep: stale + expired          (needs 8)

  azure ────────────────────────────────────────────────────
Task 11  pause/resume via the task hub            (needs 2, 3, 8)
Task 12  purge safety                             (needs 11)

  storage + retention ──────────────────────────────────────
Task 13  optional cosmos store                    (independent)
Task 14  store.kind 'auto' resolution             (needs 13)
Task 15  retention: archive                       (needs 14)
Task 16  retention: record expiry + purge route   (needs 15)

  behaviour ────────────────────────────────────────────────
Task 17  reversal: classify + describe            (needs 2)
Task 18  reversal: execute + operator flag        (needs 17)
Task 19  replan on answer                         (needs 6)

  finish ───────────────────────────────────────────────────
Task 20  config + wiring + builder                (needs all)
Task 21  integration suite                        (needs 20)
Task 22  docs                                     (needs 20)
```

Tasks 1–4 are independent and can run in parallel. Task 13 is independent of everything and can
proceed alongside the core work. The azure group (11–12) and the retention group (13–16) do not
depend on each other.

---

## Tasks

### Task 0 — Branch
- [ ] Branch `feature/durable-human-input` from `main` *(already created)*
- [ ] Add `@azure/cosmos` to `optionalDependencies`; confirm nothing imports it at module load
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
- [ ] Interruption counter, **persisted in the snapshot**; `too_many_interruptions` on exceeding
      `maxInterruptions`. A counter that lives only in memory resets on every resume and never trips
- [ ] Unit tests with a mock fleet: a pause unwinds cleanly; the counter trips at the limit
- [ ] **Commit**

### Task 6 — `askUser` and strategy threading
- [ ] `host/human-input/ask.mjs` — `createAskUser()`
- [ ] `host/tasks.mjs` — inject; wrap in budget pause/resume (**here, not in the jobs backend**);
      handle the `paused` return
- [ ] Both strategies — `askUser` on `executorArgs`; propagate a pause; an optional `resumeFrom`
      seeds observations, plan and cursor (absent = today's behaviour)
- [ ] Unit tests: reaches `executorArgs`; a regression test proving the **wired** budget pause fires
      end to end, not just `createBudgets` in isolation
- [ ] **Commit**

### Task 7 — Guardrails fallback
- [ ] `host/guardrails.mjs` — `approvalCallback` keeps precedence; `askUser` used only when absent;
      deny, question expiry and cancel all refuse
- [ ] Unit tests including: with neither present, behaviour is exactly today's
- [ ] **Commit**

### Task 8 — In-process pause, resume, lease release
- [ ] `host/human-input/resume.mjs` — validate an answer against its batch, rebuild state from the
      snapshot (or history), append the answer as an observation, produce the resume. **Backend
      agnostic** — Azure reuses it in Task 11
- [ ] `host/jobs/in-process.mjs` — handle `paused`: persist, transition, **release the lease**;
      `provideInput()` guarded by the status transition (`waiting_input` + matching batch, else 409);
      enqueue a resume; `pendingInput()`
- [ ] Cancel while waiting; release waiters on `stop()`
- [ ] Unit tests: full cycle; worker released during the pause; two answers race; cancel while
      waiting; answer for a terminal job
- [ ] **Commit**

### Task 9 — Routes and MCP tool
- [ ] `host/routes.mjs` — `POST /jobs/:id/input`; `pendingInput` + `stale` on `GET /jobs/:id`
- [ ] `host/tools/jobs-tools.mjs` — `job-input`
- [ ] `host/tools/registry.mjs` — confirm `undo` passes through `extendRegistry` untouched
- [ ] Authorization: an answer is accepted only from `identity.personId`
- [ ] Unit tests: 200/400/404/409/410; field-level validation errors; route inventory updated;
      an answer from the wrong person is refused
- [ ] **Commit**

### Task 10 — Question sweep: stale and expired
*Questions, not records. Record retention is Task 16.*
- [ ] `host/human-input/sweep.mjs` — mark a batch stale past `staleAfter`; settle the run as refused
      past `expiresAt`
- [ ] Unit tests: stale marks without settling; question expiry settles refused; a batch answered
      meanwhile is left alone
- [ ] **Commit**

### Task 11 — Azure: pause and resume through the task hub
- [ ] `comm/azure-functions/activity.mjs` — return `paused` rather than blocking
- [ ] `comm/azure-functions/orchestrator.mjs` — on a `paused` outcome, set the small `customStatus`
      marker and **complete** with history + snapshot as the orchestration output. **No
      `waitForExternalEvent`, no `Task.any`** — the replay bug documented in that file must not return
- [ ] `host/jobs/durable.mjs` — `provideInput()` reads the previous output via `getStatus` and starts
      a **new** orchestration with it as input; `pendingInput()` reads `customStatus`
- [ ] Unit tests with the existing mocks: nothing alive during a wait; a new orchestration starts on
      answer; replay history does not grow across a pause; history survives output → input
- [ ] **Commit**

### Task 12 — Azure: purge safety
- [ ] `host/jobs/durable.mjs` — `purgeInstanceHistory` skips `waiting_input` instances **younger than
      `expiresAt + graceDays`**. A paused run is a *completed* instance, so the existing purge would
      otherwise destroy the only copy of its state
- [ ] The skip is bounded, not absolute — a broken question sweep must not shield records forever
- [ ] Finding paused runs: `getStatusBy({ runtimeStatus: ['Completed'] })` filtered on
      `customStatus.status`
- [ ] Unit tests: a purge leaves a live paused instance intact; **a paused instance past
      `expiresAt + graceDays` is cleared**; a settled instance is purged normally
- [ ] **Commit**

### Task 13 — Optional Cosmos store
- [ ] `host/jobs/store/cosmos.mjs` — the unchanged `STORE_METHODS`, lazily imported
- [ ] Run the **existing shared store-contract suite** against it with no edits to the suite
- [ ] Skip cleanly when no emulator is present, so CI without Cosmos stays green
- [ ] **Commit**

### Task 14 — `store.kind: 'auto'`
- [ ] `host/jobs/store/resolve.mjs` — `auto` → `sqlite` for in-process, `taskhub` for durable
- [ ] An explicit kind always wins, including `cosmos` on Functions
- [ ] Unit tests: each backend's resolution; explicit override; unknown kind fails with a clear
      message naming the valid kinds
- [ ] **Commit**

### Task 15 — Retention: archive
- [ ] `host/retention/archive.mjs` — copy a settled run's history and final record to the archive
      store
- [ ] **A failed archive blocks the purge for that record**, is flagged to operators, and retries on
      the next pass
- [ ] Unit tests: copied before clearing; an unreachable archive store blocks the clear; a retry
      succeeds; a disabled archive is a no-op that costs nothing
- [ ] **Commit**

### Task 16 — Retention: record expiry and the purge route
*Records, not questions. Question expiry is Task 10.*
- [ ] `host/retention/expiry.mjs` — eligibility: settled, older than `afterDays`, archived if
      archiving is enabled
- [ ] The bounded paused-run skip, shared with Task 12
- [ ] `host/retention/routes.mjs` — `POST /jobs/purge` with `dryRun`, mounted only when `mode` is
      `manual` or `both`
- [ ] `host/retention/index.mjs` — `createRetention()` wires archive + expiry
- [ ] Unit tests: each eligibility rule; `manual` mode clears nothing on a timer; `dryRun` clears
      nothing but reports; the route is absent under `auto`; the response separates *skipped
      because active* from *skipped because unarchived*
- [ ] **Commit**

### Task 17 — Reversal: classify and describe
- [ ] `host/human-input/reversal/plan.mjs` — the four groups; no `undo` ⇒ *cannot be undone*
- [ ] `host/human-input/reversal/describe.mjs` — plain-language rendering
- [ ] Unit tests: classification; **rendering contains no identifier, tool name or parameter name**
- [ ] **Commit**

### Task 18 — Reversal: execute
- [ ] `host/human-input/reversal/execute.mjs` — reverse order; retries; stop-and-pause on failure;
      operator flag in logs **and** chat; exempt from the task budget
- [ ] `optionalReversal: 'ask' | 'agent'`, with the four `agent`-mode safeguards
- [ ] Unit tests: order; partial selection; retry then stop; flag raised; agent mode asks anyway when
      it would reverse everything
- [ ] **Commit**

### Task 19 — Replan on answer
- [ ] Strategies accept an answer as an observation and may revise the remaining plan
- [ ] History records `planned` with `replanOf`
- [ ] Unit tests: the revised plan executes; the original plan is recorded alongside the revision
- [ ] **Commit**

### Task 20 — Config and wiring
- [ ] `host/jobs/config.mjs` — the `humanInput` block; `store.kind: 'auto'` resolution; the
      `retention` block; dependency warning when `humanInput` is enabled without `dispatch`
- [ ] `host/human-input/index.mjs` — `createHumanInput()`
- [ ] `host/index.mjs` — wire human input and retention; start both sweeps; `.humanInput()` on the
      builder; mount the purge route when enabled
- [ ] Unit tests: defaults for every new key; warnings; disabled leaves today's behaviour exactly
- [ ] **Commit**

### Task 21 — Integration suite
- [ ] `tests/host-human-input-e2e.test.mjs` — every row of spec §14 *Integration*
- [ ] Add to `test:host`
- [ ] Confirm the full baseline is unchanged: run each existing suite before and after and diff the
      failing test **names**, not the counts
- [ ] **Commit**

### Task 22 — Documentation
- [ ] `docs/CONTRACT.md` — the built-in transport beside the hand-written callback
- [ ] `docs/kit-adoption-gaps.md` — close the human-in-the-loop row
- [ ] `docs/jobs.md` — `waiting_input`, the input route, retention and the purge route
- [ ] `docs/README.md` / `docs/architecture.md` — the pause/resume model
- [ ] **Commit**

---

## Testing strategy

**Unit** — every module in spec §14. Five carry more weight than the rest:

- **Snapshot rebuild.** Deleting the snapshot and requiring an identical resume from history is what
  keeps the snapshot honestly disposable. Without it, the cache quietly becomes the source of truth.
- **Wired budget pause.** Testing `createBudgets` alone does not prove the pause is called from the
  right layer. An earlier attempt placed it in the jobs backend, where no budget exists — it silently
  did nothing while the budget expired anyway. The test must exercise
  `executeHostedTask → askUser → guardrails`.
- **Bounded purge skip.** Two tests, not one: a live paused instance survives a purge, *and* one past
  `expiresAt + graceDays` is cleared. Only the second catches the unbounded-skip bug.
- **Archive blocks purge.** An unreachable archive store must leave the record intact. This is the
  only path that loses data permanently if it is wrong.
- **Disabled-path equivalence.** With `humanInput.enabled: false`, guardrails and the run loop must
  behave exactly as today.

**Integration** — the success criteria as tests, listed in spec §14. The three that matter most are
*pause → restart the host → answer → complete*, *answer on a second instance*, and *worker released
while waiting*, because those are the three things the current in-process design cannot do. On Azure,
*purge while paused* matters as much: a one-line condition that is easy to omit and destroys state
when it is.

**Regression discipline** — before and after each task, run the existing suites and compare failing
test **names**. Counts hide a swap of one failure for another. Known pre-existing failures on Windows
(chat e2e, azure adapter) are excluded by name, not by count.

---

## Open questions carried from the spec

These do not block starting, but each needs an answer before the relevant task:

1. **Sweep scan cost** (Task 12) — finding paused runs scans completed instances. Fine at modest
   volume; the escape is a small Azure Table index in the storage account the task hub already uses.
   Not built now — confirm that is acceptable for a first version.
2. **Question expiry default** (Task 10) — 7d proposed, 72h a reasonable alternative.
3. **Record retention default** (Task 16) — 30 days proposed. It is a *loss* by default, since
   archiving is off; confirm that is the right default for a kit.
4. **How long an archive is kept** (not scheduled) — §4.4 defines how to archive, not a policy for
   the archive itself. Deliberately an adopter decision.
