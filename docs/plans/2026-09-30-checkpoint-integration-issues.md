# Checkpoint Integration — Issues Found While Implementing

Every defect, deviation and surprise from Tasks 1–8 of
`docs/plans/2026-09-30-memory-human-input-integration.md`, with what it would
have cost if it had shipped.

Branch: `feature/memory-human-input-integration`, cut from `feature/durable-human-input` (PR #63).

**Nothing here is outstanding.** Every item is fixed and covered by a test that
failed first. The document exists because the *pattern* across them is worth
keeping — see [What the pattern says](#what-the-pattern-says).

---

## Severity 1 — would have shipped broken

### 1.1 The authorization check silently stopped working

**Task 6.** `planResume` read the run's owner from `record.snapshot.identity`.
Task 6 made the job record pointer-only, so that field became permanently
`undefined`, `owner` became `null`, and the guard below it never ran.

```js
const owner = record.snapshot?.identity?.personId ?? null;
if (owner && identity?.personId && identity.personId !== owner) { … }
//  ^^^^^ always null → the check is a no-op
```

**Effect if shipped:** anyone holding a batch id could answer anyone's
question. PR #63's contract says in as many words that *a batch id is not a
capability*; this made it one.

**Why it nearly escaped:** nothing failed. The refusal path simply stopped
being reached, and a test asserting "the wrong person is refused" is the only
thing that can catch a guard that quietly stops guarding.

**Fix:** reads the identity from the loaded checkpoint, falling back to
`record.metadata.identity` so a run that lost its checkpoint still refuses the
wrong person. Covered by `refuse: an answer from someone else is refused — a
batch id is not a capability`.

---

### 1.2 The checkpoint could never be written to a real store

**Task 6.** The checkpoint entry carried 7 of the 19 fields a memory entry
needs. SQLite bound `undefined` to a column and rejected the insert:

```
Provided value cannot be bound to SQLite parameter 7.
```

**Effect if shipped:** **every pause fails**, in the shipped configuration, on
the one path this whole feature exists for.

**Why it nearly escaped:** the store double in the unit tests is a `Map` and
accepts any object. Fifteen tests passed against it. The failure only appeared
when the e2e suite ran the real SQLite store.

**Fix:** the full entry shape (as the retired run-state had it), plus
`the entry is accepted by the real sqlite store, not just by a double` —
a test that opens a real database and writes through it.

---

### 1.3 Long-term memory stopped starting

**Task 6.** A scripted edit to `host/memory/index.mjs` replaced the run-state
block and swallowed `let ltmStore = null;` with it, leaving an orphaned
`let rsStore = null;` behind.

```
[host] memory module failed to start — continuing without memory: ltmStore is not defined
```

**Effect if shipped:** memory silently disabled — and because it was
non-fatal at the time, the host carried on without recall or learning and only
said so in a log line.

**Why it nearly escaped:** `test:eval` passed, because it tests the memory
modules directly rather than through `createMemoryModule`. Only the e2e suite
booted a real host.

**Fix:** `ltmStore` restored, `rsStore` removed, lifecycle pointed at
`checkpointStore`.

---

## Severity 2 — would have shipped incomplete

### 2.1 The checkpoint never reached the strategies

**Task 5.** The plan threaded the checkpoint into `tasks.mjs`, but
`run-loop.mjs` sits between `tasks.mjs` and the strategies and did not forward
it. Task 4's work would never have run in production.

**Effect if shipped:** no crash recovery and no pause state, with nothing
failing — the run works and simply never checkpoints.

**Fix:** `run-loop.mjs` forwards it, plus two tests that drive `runTask` end to
end and assert the strategy actually wrote. Silent-breakage chains need a test
at the *end* of the chain, not at each link.

---

### 2.2 `taskKey` collided across concurrent runs

**Task 1, pre-existing in the code being retired.** The run-state keyed on
`task.id ?? task.goal`. Two concurrent runs of the same goal shared one
checkpoint row and clobbered each other.

**Effect if shipped (and in production today):** a run resumes from another
run's state.

**Fix:** `checkpointKey(task)` keys on the id alone and **throws** when there
is none — inventing a key would hide the same bug. Both strategies skip
checkpointing rather than crash.

---

### 2.3 Two plan defects found in the pre-flight scan

**Before Task 1.**

| Defect | Fix |
|---|---|
| `memory.checkpointStore` consumed by Tasks 7–8, produced in Task 9 | moved to Task 8; 8 runs before 7 |
| Task 5 used `checkpoint` in the `runTask` call but never added it to `executeHostedTask`'s signature | added to the signature |

Both would have been runtime `undefined`s rather than a compile error.

---

## Severity 3 — my own test mistakes

Three tests failed for test reasons, not code reasons. Recorded because each
was a *plausible* mistake, not a typo.

| # | Task | Mistake | Why it looked right |
|---|---|---|---|
| 3.1 | 4 | Mock keyed on the prompt containing `"result"` | `buildActPrompt`'s own instructions contain the word, so the model "finished" before doing anything |
| 3.2 | 4 | Mock keyed on `` `plan` `` and `## Task` | several prompt builders share both |
| 3.3 | 4 | Asserted a `plan` event on a checkpoint-restored plan | that event has never existed — see 4.1 |

**Fix in all three:** discriminate on markers taken from the prompt builders
themselves (`You are the reviewer`), or on what the mock *returned* rather than
what it was asked.

---

## 4. Pre-existing gaps found, not fixed

### 4.1 A checkpoint-restored plan is never announced

`plan-execute` yields a `plan` event for a `resumeFrom`-restored plan but not
for a checkpoint-restored one. A crash-recovery resume therefore renders **no
plan card** in the chat UI — the run continues and the person sees nothing.

Upstream behaviour, unchanged by this work. Recorded in
`tests/host-checkpoint-strategies.test.mjs` beside the test that would have
caught it.

### 4.2 A flake in `test:human-input`

One failure at 319/320 during Task 1, never reproduced across ~20 runs since.
Task 1 added a module nothing else imports, so it cannot have been the cause.
The failing test was not captured.

**This suite is in CI on PR #63.** Worth watching.

---

## 5. Deviations from the plan

| # | Deviation | Reason |
|---|---|---|
| 5.1 | Task 8's wiring folded into Task 6 | `park()` needs a checkpoint, so Task 6 alone left 30 tests failing. Task 8 became config-only |
| 5.2 | Task 7 ran after Task 8 | pre-flight ruling — Task 7 consumes `memory.checkpointStore` |
| 5.3 | Task 4 gained four plan-execute tests | the brief specified open-ended only; swapping a load-bearing path with no test is not verified |
| 5.4 | `resumeState` signature changed | it read `record.snapshot`, a field Task 6 removes |
| 5.5 | Startup message reworded | "the memory store could not be opened" names what failed better than "memory module failed to start" |
| 5.6 | `pause_too_large` kept, not deleted | unreachable by design now, but a future change putting state back in the output should fail loudly |

---

## 6. Behaviour changes an adopter will notice

- **`humanInput` now requires `memory`.** Both were independently optional.
  Enabling one without the other is a startup error.
- **Memory failing to *start* is fatal when `humanInput` is on.** It used to
  warn and continue.
- **The job record no longer carries `snapshot`.** It carries `pendingBatchId`
  and the batch the UI renders.
- **`memory.runState` is now `memory.checkpoint`.** The old name is still read,
  so existing configs keep working.

---

## What the pattern says

Two of the three Severity 1 defects, and both Severity 2s, share one shape:

> **The doubles were kinder than reality.**

- A store double accepted a 7-field entry that SQLite rejects (1.2)
- Unit tests bypassed `createMemoryModule`, so a broken one passed (1.3)
- A mock fleet answered prompts the real builders phrase differently (3.1, 3.2)
- No test spanned `tasks.mjs → run-loop → strategy`, so the gap in the middle
  was invisible (2.1)

And the one that shares nothing with them (1.1, the authorization break) failed
in the other direction: **nothing broke at all.** A guard stopped guarding, and
only a test asserting the *refusal* could see it.

Two things follow for the tasks left:

1. **Test at least one path against the real thing.** Every defect above that
   reached the code was caught by a test using a real store or a real host, and
   missed by every test using a double.
2. **Assert the refusal, not just the success.** A check that silently stops
   running looks exactly like a check that passes.
