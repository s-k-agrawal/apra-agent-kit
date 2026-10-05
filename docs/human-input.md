# Durable human input

A run that needs something from a person writes down where it had got to, releases its worker and
stops. When the answer arrives — after a restart, on another machine — a fresh worker rebuilds the
run and carries on. Completed work is never re-executed.

Off by default. With `modules.humanInput.enabled: false`, a clone behaves exactly as it did before
this existed: an irreversible tool with no `approvalCallback` is denied, as always.

---

## Why a run has to stop rather than wait

The obvious implementation is to block: the tool `await`s an answer and the run stays alive. That
holds a worker lease for as long as the person takes. At `dispatch.concurrency: 1` — the default —
one unanswered question stops the agent dead until somebody notices.

So a pause **unwinds**. `askUser` throws, the throw propagates out of the strategy and the run loop,
the jobs backend writes the state down and releases the lease like any settled job. Nothing is alive
between the question and the answer.

That is also why answering starts a *new* run rather than reviving an old one. There is no old one.

---

## Turning it on

```js
modules: {
  dispatch:   { enabled: true, ... },   // required: there is nowhere to park a sync run
  humanInput: {
    enabled: true,
    maxInterruptions: 10,        // per run, counted in interruptions not questions
    staleAfterMs: 86_400_000,    // 24h — soft: the answer still counts, the person is warned
    expiresAfterMs: 604_800_000, // 7d  — hard: treated as refused, the run settles
    sweepIntervalMs: 300_000,
  },
}
```

`HUMAN_INPUT_ENABLED=true|false` overrides the file.

Enabling `humanInput` without `dispatch` logs a warning and changes nothing: `POST /task?wait=true`
has nowhere to park a run, so guardrails keep behaving as they do today.

---

## The five kinds of question

| Kind | Answer |
|---|---|
| `approval` | `'approve'` or `'deny'` |
| `pick_one` | one option value |
| `pick_many` | an array of option values — `[]` is a real answer, meaning "none of these" |
| `text` | a non-empty string |
| `pick_one_or_text` | an option value, or `{ other: '...' }` when `allowOther` is set |

`approval` is not a two-item `pick_one`. It carries a distinct meaning — permission — and the
guardrail has to recognise it as such rather than infer it from option labels.

One interruption carries many questions: a form, not a chat. `maxInterruptions` counts forms,
because what costs a person their attention is being stopped, not being asked. Ask everything you
need in one go.

### The plain-language rule

Normative, not stylistic. `prompt` and `options[].label` contain no identifiers, no tool names, no
parameter names.

```
good:  "Which Paris did you mean — France, or Texas?"
bad:   "geocode returned 2 candidates; select feature_id (2988507|4717560)?"
```

A question nobody understands trains people to approve reflexively, and internal structure on a
screen is an information-disclosure surface. `options[].value` may be opaque; `options[].label` may
not.

Give an irreversible tool an `approvalPrompt` so the sentence a person reads is one you wrote:

```js
{
  name: 'book_flight',
  reversible: false,
  approvalPrompt: (args) => `Book the flight to ${args.city} for ${args.priceLabel}?`,
  async run({ args }) { /* ... */ },
}
```

Without one, the kit falls back to the tool's `description`, and without that to a deliberately
vague sentence — never to the tool's name.

---

## Asking from a tool

```js
{
  name: 'pick_destination',
  async run({ args, askUser }) {
    const candidates = await geocode(args.city);
    if (candidates.length === 1) return candidates[0];

    const answer = await askUser({
      askedBy: 'tool',
      askedByDetail: 'pick_destination',
      questions: [{
        fieldId: 'destination',
        kind: 'pick_one',
        prompt: `Which ${args.city} did you mean?`,
        options: candidates.map(c => ({ value: c.id, label: c.humanName })),
        required: true,
      }],
    });

    return candidates.find(c => c.id === answer.answers.destination);
  },
}
```

`askUser` either returns `{ answers }` or throws. **Do not catch the throw.** A `try/catch` around
it turns a pause into whatever your fallback does, which is the one outcome nobody chose.

`askUser` is `undefined` when the feature is off, so a tool that can work without asking should
check for it.

---

## Answering

```
POST /jobs/:id/input
  { batchId, answers: { <fieldId>: <value> } }

  200  { ok: true, status: 'queued', stale: false, batchId }
  400  validation_failed   { fields: { <fieldId>: <reason> } }
  403  not_your_job
  404  not_found
  409  not_waiting | batch_mismatch | already_answered
  410  batch_expired
```

`GET /jobs/:id` carries `pendingInput` (the batch, or `null`) and `stale`. The `job-input` MCP tool
mirrors the route.

A submission is validated **as a set**: every required field present, every value legal, no unknown
keys. A partial or invalid submission is rejected whole and resumes nothing — half-answering a form
and having the run continue on the fields that happened to parse would be worse than a clean
rejection.

The answer is attributed to the authenticated caller, never to a body field claiming to be somebody.
A batch id is not a capability.

### `status: 'queued'`, not `'processing'`

A resumed job goes back on the queue. No worker holds it, and `store.claim()` — the existing
conditional write that stops two workers taking the same job — only claims a `queued` row. Going via
the queue reuses that unchanged, which is what let this land without a new store method.

---

## What happens to a paused run

```
processing ──askUser──▶ waiting_input ──answer──▶ queued ──▶ processing ──▶ completed
                              │
                              ├── cancel  ──▶ cancelled
                              └── expiry  ──▶ failed (input_expired)
```

`waiting_input` is **not** terminal, so every terminal check in the notifier, the SSE handler and the
store purge keeps working untouched — and a paused run stays visibly unfinished, which it is.

Two events ride the existing notifier, so SSE and webhook both carry them:

```js
{ type: 'input_required', jobId, batchId, questions, askedBy, staleAfter, expiresAt, at, seq }
{ type: 'input_resolved', jobId, batchId, resolution: 'answered'|'timeout'|'cancelled', at, seq }
```

---

## How a resume rebuilds the run

Two records, and only one of them is the truth.

**History** is append-only and never edited: what was planned, which steps ran and what they
returned, what was asked, what was answered. It is the only thing a resume genuinely needs.

**The checkpoint** is a cache written as the run goes and again at each pause, so a normal resume is
one read rather than a full replay. If it is absent, unreadable, or written at an incompatible
`version`, it is rebuilt from history and the run continues. An incompatible version is refused
rather than coerced: a different build may have meant something different by the same field name,
and resuming on a misread plan cursor re-executes work that already happened.

There is one checkpoint, not a separate crash-recovery record and pause snapshot. A crash and a
question leave the run in the same place — part-way through, with work already done that must not be
done twice — so they are one record with one writer.

Nothing may exist only in the checkpoint. A test deletes it and requires an identical resume.

Credentials are never written. `identity` records *who* the work is for, never the bearer that proves
it — these records live for days, and a resumed run re-acquires authority the same way a fresh one
does.

### `humanInput` requires `memory`

The checkpoint is stored through the memory module, so a host with `humanInput` enabled and `memory`
disabled cannot pause. That combination is **refused at startup** rather than failing at the first
question, hours in, with the run already part-way through. A memory store that is configured but
cannot be opened is refused the same way — the error names the failure but never the connection
string or any other environment value.

### Answers replay in order

The resumed run is driven from the same observations, so it reaches the same questions in the same
order. `askUser` hands back the answers already given, in order, and pauses again only once they run
out. That is what lets a guardrail approval survive a resume: the model proposes the booking again,
the guardrail asks again, and the answer is already there.

### The budget continues

Time spent waiting on a person is not time the run spent working, so paused time never counts
against `timeoutMs` — otherwise a question asked near the end of a budget would guarantee a timeout
on resume, punishing the run for having asked. Tokens and iterations already spent stay spent: a
resumed run continues its budget rather than starting a fresh one, or it could pause and resume
forever and never exhaust anything.

---

## The two deadlines

| | Default | Meaning |
|---|---|---|
| `staleAfter` | 24h | **Soft.** The answer still counts; the person is told the situation may have moved. |
| `expiresAt` | 7d | **Hard.** Treated as refused. The run settles `failed` with `input_expired`; history is kept. |

The hard stop exists because resuming stale work has a real cost: the model is re-fed the whole
history, the world may have moved, and a cold resume of week-old work can be worse than a fresh
start. Compute while waiting is free; quality on resume is not.

Both deadlines are stamped on the batch when it is raised, so a batch that crosses a restart, a store
or a machine carries its own deadlines with it.

The sweep enforces them on `sweepIntervalMs`. An expiry is **not** an answer: nothing was approved,
so anything gated on the question stays ungated.

---

## Limits and what is not here

**One answerer.** Read-then-write is not atomic across processes, so two instances answering the same
batch in the same millisecond could both proceed. That cannot happen in the shipped configuration —
one chat has one user, and `dispatch.concurrency` defaults to 1 — and the realistic races (a
double-click, a client retry) are single-process and caught by the status check. Running several
instances that answer concurrently would need a conditional write modelled on the existing `claim`.

**Nothing is reversed automatically on a denial.** A denial stops the gated tool from running. Steps
that already completed stay completed unless something asks for a reversal — see *Reversing work
after a correction* below. The classification, description and execution all ship; what does not
ship is a caller that runs them on every denial, because no tool in the kit declares an `undo`.

**Azure resume has not been run against a live task hub.** The orchestrator, the activity, the
new-orchestration resume and the purge skip are covered by unit tests against the existing mocks,
not against Azurite or a real hub.

See `docs/specs/2026-09-24-durable-human-input-spec.md` for the full design, and `docs/CONTRACT.md`
§4a–4e for the properties a clone must not break.

---

## Seeing it work without Fleet

The travel agent normally needs Fleet and a model. To see human input work
without either:

```bash
node deploy/demo-scripts/human-input-demo.mjs
# → http://127.0.0.1:3000/chat
```

A stand-in model drives two demo tools. Try:

| Say | What happens |
|---|---|
| `plan me a trip to Paris` | `choose-destination` asks which Paris — `pick_one_or_text`, with an Other box |
| `plan and save a Kerala trip` | `confirm-itinerary` is irreversible, so the guardrail asks for approval |
| `plan and save a trip to Paris` | both, one after the other — two interruptions on one run |

Both tools and the demo script are scaffolding: `mcp/human-input-tools.mjs` and
`deploy/demo-scripts/`. Delete them when adopting the kit. Every other tool in
the registry is read-only, which is why they exist — without something
irreversible there is nothing for the guardrail to stop.

## Azure Durable Functions

The orchestration **ends at the pause**. It does not wait.

```
activity saves the checkpoint, returns { status: 'paused', batch, checkpointKey }
  → orchestrator sets a small customStatus marker
  → orchestration COMPLETES, output carries the key
  → POST /jobs/:id/input reads the checkpoint back through that key
  → and starts a NEW orchestration seeded with what it found
```

`waitForExternalEvent` is the obvious alternative and is wrong twice over. The
replay bug documented in `orchestrator.mjs` returns the moment that generator
yields more than once, and an orchestration parked on an event is billed and
replayed for as long as the person takes. *We do not resume an orchestration,
we start another one.*

Two consequences worth knowing:

**A paused run is a `Completed` instance.** Anything that purges completed
orchestrations will destroy it, and its output is the only copy of its state.
`purgeStaleOrchestrations` now skips paused instances — but only while they are
younger than `expiresAt + graceDays`, so a broken question sweep cannot shield
records forever.

**Durable caps an output at 16 KB.** This used to bound how long a run could get
before it became unable to pause, because the whole snapshot travelled in the
orchestration output. It no longer does: the state goes to the memory store and
the output carries only a key, so the cap is not a limit an adopter can reach.
The `pause_too_large` guard remains as an assertion — if it ever fires,
something has started putting state back in the output, and failing loudly
beats truncating a pointer into nonsense.

On Functions the state lives in the **task hub itself**, as Durable Entities:
one per run for the checkpoint, one per session for chat history, one per person
for long-term facts. A Functions host has ephemeral, per-instance local disk, so
sqlite there meant a checkpoint that did not survive between invocations — and
the task hub is already provisioned, so this costs an adopter nothing.

**No Cosmos account and no SQL server are required.** Both remain selectable:
set `memory.*.store` to `cosmos` or `mssql` if you want them.

Entities are why the orchestrator, not the activity, drives the run loop:
`callEntity` is a confirmed write and is reachable only from the orchestrator
generator, while an activity has `signalEntity`, which is fire-and-forget. A
checkpoint nobody confirmed is one the run may lose.

### What is covered end to end

`tests/e2e/scenarios/s20-human-input.json` is black-box HTTP against `BASE_URL`,
so the same scenario proves both deployments: a run parks on a guardrail
approval, is answered over `POST /jobs/:id/input`, resumes, and the irreversible
tool runs **once** across the pause.

```bash
npm run e2e:vm        # Express + in-process jobs — passing
npm run e2e:durable   # Azure Functions + Durable against Azurite — NOT YET RUN
```

**Only the vm leg has actually been run.** `e2e:durable` needs Docker and has
never had a real task hub behind it. #63 and the checkpoint change were both
unit-tested against mocks, which prove the orchestrator's *shape* but not that
a pause survives a genuinely completed orchestration and is picked up by the
next one. Until that command has been run and passed, treat the Azure
pause/resume path as unverified. The scenario is target-agnostic and the
Azurite compose profile is ready, so it needs a machine with Docker, or CI.

## Storage and retention

```js
dispatch: {
  store: { kind: 'auto' },   // sqlite on a VM, task hub on Functions
  retention: {
    archive: { enabled: false, store: 'cosmos', when: 'on_settle' },
    expiry:  { afterDays: 30, mode: 'auto', graceDays: 1 },
  },
}
```

`auto` exists so the common case needs no decision. Set `kind` explicitly to
override — including `cosmos` on Functions, which is what you want if job state
must outlive the task hub or exceed its size cap.

Retention is two independent things:

- **Archive** — a long-term copy of a settled run, off by default. **Never
  purge what failed to archive**: if the copy fails, the purge for that record
  does not run, the failure is flagged, and the next pass retries. A purge that
  silently outruns a broken archive is the one way to lose data permanently.
- **Expiry** — clearing settled records. `mode: 'manual'` gives an operator
  `POST /jobs/purge` (with `dryRun`) and no timer, for deployments obliged to
  control deletion explicitly.

Purging is load-bearing, not housekeeping: the sweep that expires unanswered
questions scans the store, so an un-purged store degrades it until it stops
working.

## Reversing work after a correction

A tool declares how to undo itself. **Silence means no** — a tool with no
`undo` cannot be undone, and every tool written before this feature existed is
silent.

```js
{
  name: 'confirm-itinerary',
  reversible: false,
  undo: {
    mandatory: false,                                  // true → reversed automatically
    describe: ({ result }) => `the ${result.destination} itinerary I saved`,
    run: async ({ result, args }) => { /* the reverse action */ },
  },
}
```

Steps sort into four groups: read-only (nothing to do), mandatory (reversed
whatever the person says), optional (their choice, presented as one `pick_many`
question), and not-undoable (disclosed in plain language, never reversed).

Execution is **last done, first undone**; on failure it retries, then **stops
and reports** rather than pressing on, and raises an operator flag in the logs
and the chat. A half-reversed system is worse than either end state. Reversal
is **exempt from the task budget** — refusing to clean up because the meter ran
out is the worst available outcome.

`optionalReversal: 'agent'` lets the model choose instead of asking, bounded by
four rules. The one that matters: **if its choice would reverse everything, it
asks anyway.** That is the decision most likely to be wrong, least likely to be
recoverable, and exactly what an under-informed model reaches for.
