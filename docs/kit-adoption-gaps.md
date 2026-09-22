# Kit Adoption — Open Gaps

Status: notes, not commitments. Nothing here is scheduled.

## What this is

The kit is designed to be **cloned** — per module, per product, or per client. That changes the cost
of a gap: a weakness in the kit is not one bug, it is one bug per clone, discovered at different
times by different teams.

This document collects the gaps that show up when you adopt the kit rather than when you build it.
They came out of a first real adoption (an agent writing records into an existing permission-scoped
line-of-business system) but none of them are specific to that system — they are the questions any
adopter hits.

Several will turn out not to matter. Saying so explicitly is a valid outcome. The point of writing
them down while there is one clone is that a few get much more expensive once there are six.

**Reading the tables:** *now* is roughly what it costs while the kit is still soft; *later* is what
it costs once several clones exist and one is in production.

---

## 1. Clone lifecycle

The `git clone` → delete demos → first commit flow gives an adopter a copy. It does not give them a
boundary, a version, or a way back.

| # | Gap | Why it matters | now → later |
|---|---|---|---|
| 1.1 | **No stated boundary between kit-generic and adopter-specific code.** After the demos are stripped, everything looks equally editable | When the kit improves, every clone has already diverged in unknown places. There is no upgrade path | low → very high |
| 1.2 | **No version stamp.** Once git history is dropped, a clone cannot say which kit revision it came from | "Which clones have the guardrail bug?" is unanswerable | low → high |
| 1.3 | **Guardrail defaults are per-clone.** `defaultPolicy` is adopter config, and `reversible` defaults to `true` in the registry | A clone that ships with `defaultPolicy: 'allow'` and no `reversible` flags has no safety net at all, and nothing warns them | low → high |
| 1.4 | **No shared tool library across clones.** Every clone rewrites the same shapes — a paged search tool, a detail-fetch tool, an auth-carrying HTTP client | Duplication is the thing the kit exists to prevent, reappearing one level up | medium → high |
| 1.5 | **No conformance test.** Nothing checks that a modified clone still honours the guardrail or tool contract | Divergence is silent until something is approved that should not have been | medium → high |

**Cheapest useful step:** write `kit.version` at scaffold time, and ship a short `CONTRACT.md`
listing what a clone must not change. Neither blocks anything else.

---

## 2. Consumer and tenant isolation

The kit does not take a position on multi-tenancy. For a single-tenant internal agent that is
correct. For a cloned-per-client deployment it leaves several things undefined.

| # | Gap | Note |
|---|---|---|
| 2.1 | **No tenant concept in the tool contract.** Tools receive whatever identifiers the adopter passes; nothing structurally prevents one tenant's identifier reaching another tenant's data | Usually the adopter's own authorization layer catches this. That is one layer, and often the only one |
| 2.2 | **Budgets are per-run, not per-consumer.** `budgets.mjs` counts iterations, tokens, cost and time for a single task | "Which client spent the model budget this month" cannot be answered |
| 2.3 | **No rate limiting** at any layer | One chatty consumer degrades every other consumer of the same deployment |
| 2.4 | **Secret distribution is per-clone and unspecified.** Each clone needs its own credentials for whatever it calls | Key rotation across N clones becomes a coordinated outage |
| 2.5 | **No data-residency position.** Where a clone may run, and where its traces may land, is left to the adopter | Fine, as long as it is a decision rather than a default |

---

## 3. Observability

Nothing in the chain carries a correlation identifier today. This is the item worth doing earliest,
because retrofitting tracing across a multi-hop chain is painful and the cost lands on whoever is on
call.

| # | Gap | Note |
|---|---|---|
| 3.1 | **No end-to-end correlation id** threaded from the calling application through the run loop, tool calls, and whatever the tools call | A user reporting "it did the wrong thing" cannot be traced back to a plan |
| 3.2 | **Agent decisions are not durably recorded in a queryable form.** `history` is returned with the result; nothing says where it goes | "Why did it choose that?" needs an answer weeks later, not seconds later |
| 3.3 | **Budget snapshots are per-run and discarded** | No trend, no alert on cost drift |
| 3.4 | **No SLO shape for a run**, so no way to say whether a change regressed it | |
| 3.5 | **Sampling interacts badly with agent traces.** Adopters on platforms with request sampling may lose exactly the traces they want | Worth a note in the adoption guide |

**Cheapest useful step:** accept an optional `traceId` on the task, thread it through the run loop
and into every tool call, and include it in the result. Roughly an afternoon.

---

## 4. Safety beyond the guardrail

The guardrails answer *may this tool run*. They do not answer *why did the model want to run it*.

| # | Gap | Note |
|---|---|---|
| 4.1 | **Prompt injection via stored content.** Where an agent reads data that other people wrote and may later act on it, the guardrail sees a well-formed call and allows it | The approval step is the real defence; the guardrail is the enforcement point, not the judgement |
| 4.2 | **`approvalCallback` carries no identity.** It returns `'approve'`/`'deny'` with no proof of who approved, and no record | Adequate for approval inside the same session. Not adequate if approval ever moves to another channel or another person |
| 4.3 | **No write rate limit.** Nothing caps "do this 500 times" except `maxIterations`, which is a blunt instrument that also caps legitimate long plans | |
| 4.4 | **No provenance convention for agent-written data.** The kit takes no position on marking records an agent created | **This is the one that cannot be retrofitted.** Records written before an adopter decides are permanently unattributable. Worth surfacing in the adoption guide as a decision to make *before* the first write |
| 4.5 | **No kill switch.** No documented way to disable writes across a deployment without a redeploy | Cheap to add; wanted during an incident |

---

## 5. Not yet built — and what that means for an adopter

Stated plainly so adopters can plan around these rather than discover them. What exists today is a
tool server plus an autonomous run loop with budgets and guardrails; the rest is not here yet.

| # | Missing capability | Impact while it is missing |
|---|---|---|
| 5.1 | **Platform adapters beyond Express** | An agent deploys as an Express service. An adopter who must deploy onto a specific serverless platform is blocked until an adapter for it exists |
| 5.2 | **Eval harness** | No automated quality gate. Write the fixtures anyway — a fixed question set with known-good outputs. They become the harness's input when it lands, and writing them early forces behaviour to be specified rather than improvised |
| 5.3 | **Async dispatch** (accept-then-poll) | `POST /task` is synchronous and blocks for the length of the run. Any caller that cannot hold a connection open that long is blocked |
| 5.4 | **Memory, run-state checkpoints, crash recovery** | A crashed run cannot resume. Acceptable for short plans; not for fan-out or long-running work |
| 5.5 | **Human-in-the-loop approval transport** (issue #30) | The `approvalCallback` interface exists, but how a human actually reaches it is left to the adopter. In-session chat satisfies it only for interactive use |

---

## 6. Operational unknowns

| # | Gap | Note |
|---|---|---|
| 6.1 | **No rollback story for agent-written data.** If an agent writes many wrong records, what happens is entirely the adopter's problem | Needs a product answer, not an engineering one — particularly where the target system is append-only |
| 6.2 | **No documented DR position** for a deployed agent | |
| 6.3 | **LLM provider outage behaviour is undefined.** The kit is provider-agnostic by design, but failover between providers is not configured or documented | The agnosticism is a portability property, not an availability one |
| 6.4 | **No load expectation shape.** Adopters have nothing to size against | Budgets, rate limits and hosting are all guesses without it |
| 6.5 | **Localisation.** Agent output language is not addressed | An adopter with a localised application will have a localised UI and an English agent |

---

## 7. If only three of these get done

Ranked by (cost now) × (cost later) × (likelihood of mattering):

1. **A provenance convention for agent-written data** (4.4) — the only item that is genuinely
   impossible to retrofit.
2. **Correlation id through the run loop** (3.1) — an afternoon now; a multi-day forensic exercise
   later, at the worst possible moment.
3. **Kit version stamp plus a clone contract** (1.1, 1.2) — trivial with one clone, hard with six
   that have diverged.

Everything else can reasonably wait for evidence that it matters.

---

## 8. Questions every adopter should be asked

Not blocking, but each changes the shape of an adoption:

- Is this clone **per module**, **per product**, or **per client**? The three have very different
  isolation requirements and the answer drives most of §1 and §2.
- What is the expected task volume? Most of §6 is unanswerable without it.
- Who is accountable when the agent gets it wrong, and what is the remediation path? Especially
  where the agent writes into a system of record.
- Will the agent ever act for a user who is **not** present in the conversation? If yes, §4.2
  becomes urgent and delegated-authority design arrives sooner than expected.

---

*Raised 2026-09-17 during the first adoption of the kit, from the specs in docs/specs and the
implementation in `host/`. Adopter-specific findings are kept out of this document deliberately.*
