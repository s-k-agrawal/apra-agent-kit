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

The callback may return either form:

```js
'approve' | 'deny'                    // original contract
{ decision, approvedBy, reason }      // also records who decided, and why
```

Anything other than `'approve'` — or `{ decision: 'approve' }` — denies, including a malformed
response. On approval the result carries `approval: { approvedBy, reason, at }`; the kit returns that
record and does nothing else with it, because only you know where it belongs.

**The kit does not yet ship a way to reach a human.** There is no built-in transport that puts the
question in front of someone, so `approvalCallback` is whatever you write. Until you write one, the
`approve` policy denies and `approvedBy` is null. Wiring is the whole job:

```js
guardrails: {
  approvalCallback: async ({ tool, args, context }) => {
    const answer = await yourApprovalUi.ask({
      tool: tool.name,
      args,
      traceId: context.traceId,      // correlates back to the run
    });
    return answer.ok
      ? { decision: 'approve', approvedBy: answer.user, reason: answer.note }
      : { decision: 'deny', approvedBy: answer.user, reason: answer.note };
  },
}
```

A first-class transport — `waiting_input` job status, `POST /jobs/:id/input`, SSE delivery, budget
pause while waiting, and a timeout — is tracked in issue #30. Until it lands, the callback above is
the supported route.

**Must hold:** the callback receives `tool` and `args`; only `'approve'` permits.

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

- **Provenance** — marking records an agent wrote. **Decide before your first write.** The kit takes
  no position on how you mark agent-created data, but records written before you decide are
  permanently indistinguishable from human-created ones — there is no migration that can tell them
  apart afterwards. The mechanism is already here: `traceId` reaches every tool (§6), so a tool can
  stamp it onto whatever it writes.
- **Tenant isolation** — the kit has no tenant concept.
- **Rate limiting** — budgets cap a single run, not a consumer.
- **Secret distribution** — each clone handles its own.
- **Authentication of the approver** — the callback may now report an identity, but the kit does not
  verify it. Whoever writes the callback vouches for `approvedBy`.
- **Reaching the approver** — there is no shipped transport that puts an approval request in front of
  a human; see §4 and issue #30.

See `docs/kit-adoption-gaps.md` for the full list.
