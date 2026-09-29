# Clone Contract

What a clone of this kit must not change.

## Why this exists

The adoption flow is: clone, delete the demo agents and tools, drop the git link, first commit. From
that point the clone is yours and almost everything in it is meant to be edited — that is the point
of a kit.

A few properties are not. They are the ones that fail silently: a clone keeps working, tests keep
passing, and the difference only shows up as an action nobody approved. This document lists them, and
`tests/kit-conformance.test.mjs` enforces them.

**If you change something in this document, you are taking on the safety property yourself.** That is
allowed. Doing it by accident is not.

---

## 1. Irreversible tools stay gated

A tool declaring `reversible: false` resolves to the `approve` policy, and `approve` with no
`approvalCallback` denies.

```js
// host/guardrails.mjs — resolution order
freeze (if on, and tool is irreversible)  → deny
config.policies[tool.name]                → explicit override
tool.reversible === false                 → approve
config.defaultPolicy                      → default 'allow'
```

**Must hold:**

- `defaultPolicy: 'allow'` must not un-gate an irreversible tool.
- No approver configured must mean denied, never allowed.
- A tool that says nothing about reversibility is treated as reversible — so **mark your writes
  explicitly**. The default is safe for reads and wrong for writes.

**Reasonable to change:** the policy table, the approver implementation, which of your tools are
irreversible.

---

## 2. Denials are values, not exceptions

Every guardrail refusal returns `{ ok: false, error: 'guardrail_denied', reason: '...' }`. Reasons in
use: `policy_denied`, `approval_denied`, `frozen`, `dry_run`, `sandbox_violation`,
`validation_failed`.

This matters because the run loop feeds a denial back to the model as an observation. The model then
explains the refusal or plans around it. A thrown exception ends the run instead, and the user sees a
crash rather than "you do not have permission to do that".

**Must hold:** refusals do not throw.

---

## 3. The kill switch outranks policy

`guardrails.freeze: true` denies every irreversible tool regardless of the per-tool policy table.
Reversible tools keep working.

It exists so an operator can stop writes during an incident without a redeploy and without editing
policies one by one. A per-tool `allow` must not defeat it.

**Must hold:** `freeze` is checked before `policies`.

---

## 4. Approval carries enough context to decide

`approvalCallback({ tool, args, context })` receives the tool and the concrete arguments. An approver
that cannot see what is about to happen cannot approve it meaningfully, and an approval UI that shows
only a tool name trains people to click yes.

Anything other than the exact string `'approve'` denies.

**Must hold:** the callback receives `tool` and `args`; only `'approve'` permits.

---

## 4a. `approvalCallback` outranks `askUser`

When `modules.humanInput` is on, a guardrail that resolves to `approve` has two ways to ask:

```
policy resolves to 'approve'
  1. approvalCallback configured?  → call it            (unchanged behaviour)
  2. askUser available?            → raise a question and park the run
  3. neither                       → deny, reason 'approval_denied'
```

The order is the contract. An adopter who already has their own approval transport must see no
change from human input existing — silently rerouting their approvals to a screen they do not run is
worse than not offering the feature at all.

**Must hold:** with an `approvalCallback` configured, `askUser` is never consulted. With neither,
the result is exactly today's `approval_denied`.

---

## 4b. A pause is not a denial

`askUser` either returns an answer or throws `PauseRequested`. That throw is how a run unwinds out of
the strategy so its worker lease can be released.

Every layer between a tool and the run loop turns throws into `{ ok: false }` values — that is
contract 2, and it is right for failures. The three human-input signals (`PauseRequested`,
`TooManyInterruptions`, `InvalidQuestion`) carry `isHumanInputSignal: true` and must be re-thrown
instead. `host/tools/executor.mjs` does this; anything else that wraps tool execution must too.

Degrading a pause into a denial runs the opposite of what nobody agreed to. Degrading an unaskable
question into a tool error makes the model propose the same call again, and the run loops until the
process dies.

**Must hold:** a throw carrying `isHumanInputSignal` propagates to the run loop untouched.

---

## 4c. Questions are in plain language

`prompt` and `options[].label` contain no identifiers, no tool names, no parameter names.

```
good:  "Which Paris did you mean — France, or Texas?"
bad:   "geocode returned 2 candidates; select feature_id (2988507|4717560)?"
```

Two reasons, and both are load-bearing: a question nobody understands trains people to approve
reflexively, and internal structure on a screen is an information-disclosure surface. `options[].value`
may be an opaque identifier; `options[].label` may not.

A tool says how to describe itself with `approvalPrompt` (a string, or a function of the arguments).
With neither that nor a `description`, the fallback is deliberately vague rather than leaking the
tool's name.

**Must hold:** the generated approval prompt never contains the tool name.

---

## 4d. Credentials are never persisted

A paused run's snapshot records `identity` — who the work is for — and never the bearer that proves
it. These records live for days. A resumed run re-acquires authority the same way a fresh run does.

`identity` is allow-listed (`personId`, `tenantId`) rather than filtered, because a filter only
removes the credential shapes somebody thought of. Everything else written to a snapshot is passed
through a scrub that drops credential-shaped keys at every depth.

**Must hold:** no token, cookie, key or password survives `capture()`.

---

## 4e. The snapshot is a cache, and history is the truth

A resume reads the snapshot when it can and rebuilds from history when it cannot — absent,
unreadable, or written at an incompatible `version`. Nothing may exist only in the snapshot.

An incompatible version is **refused, not coerced**. A different build may have meant something
different by the same field name, and resuming on a misread plan cursor re-executes work that
already happened.

**Must hold:** deleting a snapshot and resuming from history produces the same state. History is
never ring-buffered — `ringEvents()` exists for the size-capped Azure `customStatus` view only.

---

## 5. Kit identity is recorded

`package.json` carries a `version`. `host/kit-info.mjs` reads it and the `/health` route reports it.

A clone created by a scaffold also carries `kit.version.json` with `scaffoldedFrom` — the kit version
it started from. **That file records an origin and is never updated.** It is what makes "which clones
carry this bug?" answerable.

**Must hold:** a version is reported; the scaffold stamp is written once and not overwritten.

---

## 6. Trace ids flow through

A task may carry `traceId`. The run loop threads it into every tool call and returns it with the
result; one is generated when the caller supplies none.

If your tools call other systems, **pass it on**. It is the only thing that makes a record in a
downstream system traceable back to the plan that created it, and retrofitting it after an incident
is far more work than carrying it now.

**Must hold:** `traceId` reaches tool execution and appears in the run result.

---

## Running the check

```bash
node --test tests/kit-conformance.test.mjs
```

Run it in CI. A clone that fails this file has changed something on this list — which may be
deliberate, in which case update this document and say why.

---

## Not covered here

These are adopter decisions the kit takes no position on. They are listed so nobody assumes the kit
handles them:

- **Provenance** — marking records an agent wrote. Decide before your first write; it cannot be
  retrofitted to rows already created.
- **Tenant isolation** — the kit has no tenant concept.
- **Rate limiting** — budgets cap a single run, not a consumer.
- **Secret distribution** — each clone handles its own.
- **Authentication of the approver** — `approvalCallback` returns a decision, not an identity. The
  `POST /jobs/:id/input` route does attribute an answer to the authenticated caller, but who that
  caller is remains your authentication layer's problem.

See `docs/kit-adoption-gaps.md` for the full list.
