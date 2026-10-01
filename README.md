<p align="center">
  <img src="docs/apra-agent-kit-banner.png" alt="apra-agent-kit" />
</p>

<h3 align="center">A modular toolkit for building autonomous AI agents on <a href="https://github.com/Apra-Labs/apra-fleet">Apra Fleet</a></h3>

<p align="center">
  <a href="https://github.com/Apra-Labs/apra-agent-kit/actions/workflows/ci.yml"><img src="https://github.com/Apra-Labs/apra-agent-kit/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.16-brightgreen" alt="Node.js >= 22.16" />
  <img src="https://img.shields.io/badge/platform-Fleet-blue" alt="Platform: Apra Fleet" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" />
  <img src="https://img.shields.io/badge/PRs-welcome-orange" alt="PRs welcome" />
</p>

<p align="center">
  <a href="#write-your-own-agent"><strong>Write Your Own Agent</strong></a> · 
  <a href="#contributing"><strong>Contribute</strong></a> · 
  <a href="docs/architecture.md"><strong>Architecture</strong></a> · 
  <a href="docs/roadmap.md"><strong>Roadmap</strong></a> · 
  <a href="docs/scheduled-workflows.md"><strong>Scheduled Workflows</strong></a>
</p>

---

## Write Your Own Agent

### Quick Start

**Step 1 — Scaffold a new project:**

```bash
npm create @apralabs/agent-kit my-agent
cd my-agent
```

The command copies the kit, installs dependencies, writes a starter workflow,
and shows you what's enabled. It explains each step before it asks.

**Step 2 — Verify your environment:**

```bash
npm run doctor     # check prerequisites
npm test           # mock tests — no Fleet, no token needed
```

**Step 3 — Run the starter workflow:**

```bash
# Linux / macOS
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
npm run hello

# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token)
npm run hello
```

**Step 4 — Start the full agent (pick one):**

| Mode | Command | Chat URL |
|---|---|---|
| **Local** (no Docker) | `npm run host` | http://localhost:3000/chat |
| **Docker VM** | `docker compose up --build` | http://localhost:3000/chat |
| **Docker Azure** | `docker compose -f docker-compose.azure.yml up --build` | http://localhost:7071/api/chat |

For Docker modes, pass the token first:

```bash
# Linux / macOS
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) docker compose up --build

# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token); docker compose up --build
```

#### Compare the two Docker modes

| | `docker-compose.yml` (VM) | `docker-compose.azure.yml` (Azure) |
|---|---|---|
| Chat URL | `localhost:3000/chat` | `localhost:7071/api/chat` |
| Jobs backend | SQLite (in-process) | Durable Functions (Azurite) |
| Scaling | Single process | Horizontal (shared task hub) |
| Scheduler | In-process (croner) | Azure Timer Triggers |
| Production target | VM / Docker host | Azure Functions Premium |

The token is passed from your shell — no `.env` file needed.

#### Connect via MCP

```bash
# VM mode
claude mcp add --transport http my-agent http://127.0.0.1:3000/mcp

# Azure Functions mode
claude mcp add --transport http my-agent http://127.0.0.1:7071/api/mcp
```

Run `npm run doctor` in your project at any time to see what is missing.

---

### The Agent Builder Skill

The fastest way to go from an idea to a running agent. Instead of manually
writing config, tools, and registry entries, the **agent-builder** skill walks
you through the entire process interactively.

In Claude Code, type:

```
/agent-builder
```

The skill runs four phases:

| Phase | What happens |
|-------|-------------|
| **Interview** | 4 rounds of structured questions about what your agent does, its domain, tools, workflow shape, and Fleet members. Then a Socratic grilling phase probes edge cases and failure modes. |
| **Spec** | A complete agent specification is written to `docs/specs/`. Every section is filled — no TODOs or blanks. |
| **Plan** | A task-by-task implementation plan is written to `docs/plans/`, covering tools, workflows, registry, host config, system prompt, tests, and deployment — in the correct build order. |
| **Build** | Choose how to execute: subagent-driven development (current session), Fleet Sprint (parallel agents), or build it yourself from the plan. |

The guided path handles things that are easy to forget when building manually:

- **Host configuration** — sets up `host.config.mjs` with the right strategy,
  modules, and an `agentDescription` that steers the LLM to use your tools
- **Memory configuration** — if the agent needs memory, configures the right
  tiers and coaches the LLM to use memory tools via `agentDescription`
- **API key propagation** — `executeCommand` doesn't inherit env vars from the
  parent shell; the plan shows how to pass keys through
- **Session cleanup** — clears stale Fleet worker sessions before integration
  testing so the agent starts fresh

After the build completes, your agent is ready to run.

---

### Configuration

Your agent's identity and behavior are defined in a single file: `host.config.mjs`.

```js
export default {
  name: 'my-agent',
  description: 'Short label for logs and the chat header.',
  agentDescription: `You are a helpful assistant that...
This is the system prompt the LLM sees. Be specific about what the agent
knows, what tools to use, and any domain-specific rules.`,

  fleet: {},

  comm: {
    adapter: 'express',       // 'express' for local/VM, 'azure-functions' for Azure
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',   // or 'open-ended'
      maxReplanAttempts: 3,
      maxReviewAttempts: 2,
      maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible',
      maxNoActionTurns: 3,
    },
    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,         // 10 minutes
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,          // set true to test without executing
    },
    dispatch: {
      enabled: true,
      store: { kind: 'sqlite', dbPath: './jobs.db' },
      concurrency: 2,
      maxQueueSize: 10,
    },
    notify: {
      sse: { enabled: true },
    },
    chat: {
      enabled: true,
      title: 'My Agent',
      themes: ['blue'],           // 'apra', 'blue', or both for a toggle
    },

    // Scheduler — run workflows on a cron schedule
    scheduler: {
      enabled: true,
      schedules: [
        {
          name: 'morning-briefing',     // unique name for this schedule
          workflow: 'hello',            // must match a registered workflow
          args: {},                     // arguments passed to the workflow
          cron: '0 9 * * *',           // standard cron: 9am daily
          timezone: 'UTC',             // IANA timezone
          overlap: 'skip',             // 'skip' (drop if previous still running) or 'queue'
        },
      ],
    },

    // Memory (all tiers optional — uncomment what you need)
    // memory: {
    //   conversationContext: { enabled: true, mode: 'store', store: 'sqlite', dbPath: './memory/conversation.db' },
    //   checkpoint: { enabled: true, store: 'sqlite', dbPath: './memory/checkpoint.db' },
    //   longTerm: { enabled: true, store: 'sqlite', dbPath: './memory/memory.db', autoLearn: true },
    // },
  },
};
```

#### Key configuration fields

| Field | What it does |
|---|---|
| `name` | Agent identity — shown in logs, chat header, and system prompt |
| `description` | Short label for the chat UI title and log output |
| `agentDescription` | **The agent's personality and domain knowledge.** Injected into the system prompt. Multi-line template literal. |
| `comm.adapter` | `'express'` (local/Docker) or `'azure-functions'` |
| `modules.runLoop.strategy` | `'plan-execute'` (multi-step, reviewed) or `'open-ended'` (simple lookup agents) |
| `modules.budgets.*` | Cost and safety limits per task |
| `modules.guardrails.defaultPolicy` | `'allow'`, `'deny'`, or `'approve'` (human-in-the-loop) |
| `modules.dispatch.concurrency` | Max parallel tasks |
| `modules.chat.themes` | `['blue']`, `['apra']`, or `['blue', 'apra']` for a toggle |
| `modules.scheduler` | Run workflows on cron schedules. Timezone-aware, `skip` or `queue` overlap. See [docs/scheduled-workflows.md](docs/scheduled-workflows.md) |
| `modules.memory.*` | Three-tier memory: conversation context, run state, long-term. See [docs/memory.md](docs/memory.md) |

#### Choosing a strategy

| Strategy | When to use |
|---|---|
| `plan-execute` | Most agents. The LLM creates a plan, a reviewer approves it, then steps execute one at a time. Replans on failure. Safer and auditable. |
| `open-ended` | Simple lookup agents. Act → observe → repeat with no upfront plan. Faster for single-tool tasks, less control. |

#### Adding tools

A tool is a script (Python, Node, or any executable) plus a registry entry:

1. Write the implementation in `tools/your-tool/your_tool.py`
2. Register it in `mcp/registry.mjs` with a name, description, input schema, and `run()` function
3. Restart the host

See the full **[Getting Started guide](docs/getting-started.md)** for tool patterns,
authentication, MCP integration, Azure Functions deployment, and environment variables.

#### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (required) | Fleet worker authentication |
| `PORT` | `3000` | HTTP listen port |
| `WORKER_POOL_SIZE` | `4` | Persistent worker count |
| `WORKER_EPHEMERAL_MAX` | `10` | Max ephemeral workers for burst |
| `CHAT_ENABLED` | from config | Override chat on/off (`true`/`false`) |

---

## What is the Agent Kit?

An agent takes in a task and gets it over the finish line. Everything else — chat, MCP,
schedules, queues — is a door into that one function.

This kit gives you that function, pre-wired with everything a production agent needs:

<p align="center">
  <img src="docs/architecture-diagram.svg" alt="Architecture component diagram" />
</p>

**Three operating modes:**

- **Full Agent** — receives a task at `POST /task`, plans, executes tools, observes results,
  replans on failure, returns autonomously
- **Tool Server** — external AI (Claude Code, Cursor, another agent) drives reasoning,
  calls tools via MCP at `POST /mcp`
- **Custom** — enable only the modules you need

One container runs one agent. Scaling is horizontal: more containers, each with its own agent.

<table align="center"><tr>
<td><img src="docs/chat-plan-steps.png" alt="Chat UI — plan with 9 tool steps" width="400" /></td>
<td><img src="docs/chat-answer.png" alt="Chat UI — final travel itinerary" width="400" /></td>
</tr><tr>
<td align="center"><em>9-step travel plan</em></td>
<td align="center"><em>Final itinerary</em></td>
</tr></table>

---

## What an agent is made of

A task goes in, a result comes out. Six parts inside the boundary make that happen.

<p align="center">
  <img src="docs/agent-anatomy.svg" alt="Agent anatomy — 6 parts inside the boundary" />
</p>

| # | Part | What it does | Status |
|---|------|-------------|--------|
| 1 | **Run Loop** | The core. Decides the next step and calls tools until done. Two strategies: **ReAct** (decide each turn) and **Plan-Execute** (plan upfront, replan on failure). | Shipped |
| 2 | **Memory** | Three tiers: conversation context (prior chat turns within a session), run state (crash recovery), long-term (cross-session facts with FSRS-6 decay). Four LLM tools: remember, recall, forget, promote. | Shipped |
| 3 | **Workflows** | Known sequences written as plain code and exposed as tools. If you already know the steps, don't make the agent figure them out. | Shipped |
| 4 | **Tools** | Typed schemas, model-facing descriptions. Errors are returned, not thrown. 15 Python tools ship out of the box. | Shipped |
| 5 | **Budgets & Stops** | Iteration cap (25), cost ceiling ($5), token limit (500K), wall-clock timeout (10 min), explicit definition of done. | Shipped |
| 6 | **Guardrails** | Per-tool allow/deny policies, reversibility classification, filesystem sandboxing, input validation, dry-run mode. | Shipped |
| — | **Evals** | Sits outside the boundary — a harness that calls the whole box and grades what comes out. 20-50 real tasks with graded outcomes. | Planned |

---

## How the System Works

A task enters through one of four doors (the communication layer), hits the agent's run
loop, and comes out as a result. See the full
**[Architecture Guide](docs/architecture.md)** for details.

**The run loop** picks a strategy:
- **Plan-Execute** — doer writes a plan, reviewer approves it, steps execute one by one.
  If a step fails, it replans. Best for multi-step tasks.
- **ReAct (Open-Ended)** — decides what to do next each turn based on what just happened.
  Handles surprises. Costs more.

**The worker pool** manages Claude Code instances in three tiers: 4 pre-provisioned pairs,
up to 10 ephemeral overflow pairs, then a wait queue.

**The job queue** handles async tasks with real-time progress via SSE and webhook callbacks.
Two backends: SQLite (local/Docker) or Azure Durable Functions (cloud).

- **Scheduled workflows** — fire named workflows on cron schedules with timezone support and overlap policies. Config-driven, works on VM/Docker and Azure Functions. See [docs/scheduled-workflows.md](docs/scheduled-workflows.md).

**Memory** gives the agent context across turns and sessions. Three independent tiers:
- **Conversation context** — prior chat turns within a session, with LLM summarisation
  compaction and FSRS-6 decay. The agent can reference earlier results.
- **Run state** — crash recovery checkpoints so interrupted tasks resume from the last step.
- **Long-term memory** — cross-session facts (domain knowledge, user preferences, patterns)
  with spaced-repetition decay. The agent gets `remember`, `recall`, `forget`, and `promote`
  tools, plus an auto-learner that extracts reusable facts after each task.

| Document | Covers |
|---|---|
| **[docs/architecture.md](docs/architecture.md)** | Component diagram, layers, data flow, design decisions |
| [docs/run-loop.md](docs/run-loop.md) | Strategies, budgets, guardrails, `/task` API |
| [docs/memory.md](docs/memory.md) | Memory system: conversation context, long-term facts, decay, tools, REST API |
| [docs/jobs.md](docs/jobs.md) | Async jobs: submit, poll, SSE, webhooks, cancellation |
| [docs/concurrency.md](docs/concurrency.md) | Worker pool, job queue, dispatch config |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP tool catalog, registry contract |
| [docs/chat-ui.md](docs/chat-ui.md) | Chat page: theming, events, status pipeline |
| [docs/deploy-azure-functions.md](docs/deploy-azure-functions.md) | Azure Functions deployment |

---

## Contributing

We welcome contributions. Here's how:

### Working on the kit itself

Clone this repository instead of scaffolding:

```bash
git clone https://github.com/Apra-Labs/apra-agent-kit.git
cd apra-agent-kit && npm install
```

### Fork and PR workflow

1. **Fork** the repo on GitHub
2. **Clone** your fork: `git clone https://github.com/<you>/apra-agent-kit.git`
3. **Create a branch**: `git checkout -b feature/your-feature`
4. **Make your changes** — follow the conventions in [docs/development.md](docs/development.md)
5. **Run tests**: `npm test` (mock tests — no Fleet binary or tokens needed)
6. **Push** to your fork: `git push origin feature/your-feature`
7. **Open a PR** against `main`

### What to contribute

- **New tools** — write a Python script, register it in the catalog
- **Bug fixes** — especially around edge cases in the run loop or job queue
- **Documentation** — improvements, examples, tutorials
- **Tests** — more mock tests for strategies, guardrails, budgets
- **New strategies** — implement a different planning/execution approach

See [docs/development.md](docs/development.md) for the full setup, testing guide, and conventions.

---

## Roadmap

See the full **[Roadmap](docs/roadmap.md)** for what's shipped, in progress, and planned.

**Recently shipped:**
- Three-tier memory system — conversation context, run state, long-term with FSRS-6 decay
- Strategy auto-router — classifies tasks and routes to the right strategy automatically
- `npm create` scaffolding CLI — scaffold a new agent project in one command
- Agent-builder skill (`/agent-builder`) — interview → spec → plan → build
- Trace IDs and kill switch — end-to-end correlation and emergency write disable

**Next up:**
- Eval harness: 20-50 real tasks with graded outcomes, runs on every prompt/model change

---

## FAQ

**Q: Do I need Apra Fleet installed to run tests?**
No. `npm test` uses mock Fleet clients — no binary, no members, no OAuth token required.
You only need Fleet installed to run the agent live.

**Q: What's the difference between `/mcp` and `/task`?**
`/mcp` is for external AI that brings its own brain — it picks tools from the catalog and
calls them. `/task` is for callers that want this agent's brain — it plans and executes
autonomously. Both share the same tools, worker pool, and guardrails.

**Q: Can I use OpenAI or other providers instead of Claude?**
Fleet supports registering members with different LLM providers. The kit's architecture
doesn't lock you into Claude — though today the worker pool provisions Claude Code instances.
Multi-provider support is on the roadmap.

**Q: How much does a task cost?**
Depends on the task complexity and strategy. Budget defaults cap at $5 per task, 500K tokens,
and 25 LLM iterations. You can override these per-request or in config. A typical 5-tool
travel briefing costs around $0.50-1.00.

**Q: What happens if the agent crashes mid-task?**
With checkpoint memory enabled, the agent resumes from the last checkpoint on restart. The
in-process job backend also re-queues any `queued` jobs and fails stale `processing` jobs.

**Q: Can I run multiple agents?**
Yes. One container runs one agent. Scale horizontally with more containers, each configured
for a different domain (travel agent, data agent, etc.) or as replicas of the same agent.

**Q: Why Python for tools instead of JavaScript?**
Tools run via `fleetApi.executeCommand()` on a Fleet member's machine — they're shell commands,
not imported modules. Python was chosen because most data/API scripts are simpler in Python
with stdlib (`urllib`, `json`, `sys`). You can write tools in any language that reads args
from `sys.argv` and prints JSON to stdout.

**Q: How do I deploy to production?**
Two paths: `docker compose up` on a VM (uses Express + SQLite backend), or
`docker compose -f docker-compose.azure.yml up` for Azure Functions (uses Durable Functions
for managed scaling). Both ship with the scaffold. For Azure production with Key Vault and
horizontal scaling, see [docs/deploy-azure-functions.md](docs/deploy-azure-functions.md).

**Q: What's the difference between workflows and agent reasoning?**
If you already know the steps, write a workflow (plain code, exposed as a tool). It's faster,
cheaper, and predictable. Use the agent for tasks where the path is unknown — it decides each
step from what happened. Bad pattern: an agent walking a fixed sequence you already knew.

---

## License

MIT
