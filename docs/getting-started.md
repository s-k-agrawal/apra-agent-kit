# Getting Started

This guide is for **agent builders** — developers who want to create their own agent
using the kit. You do not need to understand the kit's internals; you need to know
what to configure, where to put your tools, and how to run it.

If you want to **contribute to the kit itself** (fix bugs, add modules, improve the
run loop), see [development.md](development.md) and [architecture.md](architecture.md)
instead.

---

## What you get

The kit gives you an agent that can:
- Receive a goal (via API, chat UI, or MCP)
- Plan a sequence of tool calls
- Execute them autonomously with review gates
- Stream progress to a real-time chat UI
- Respect cost, token, and time budgets
- Remember prior chat turns and learn facts across sessions (optional memory)
- Run workflows on a schedule (cron-based, timezone-aware)

You supply: **the tools** and **the config**. The kit handles planning, execution,
review, error recovery, concurrency, and deployment.

---

## Two paths to build an agent

| Path | Best for | What happens |
|---|---|---|
| **Guided** (`/agent-builder`) | New agents from scratch | Interview → spec → plan → build — all automated |
| **Manual** (this guide) | Adding tools to an existing agent, or full control | You write config, tools, and registry entries by hand |

### Guided path: `/agent-builder`

The fastest way to go from idea to running agent. In Claude Code, type:

```
/agent-builder
```

The skill walks you through four rounds of questions about what your agent should
do, then generates everything:

1. **Interview** (4 rounds) — what the agent does, domain, tools, workflow shape,
   Fleet members. Then a grilling phase probes edge cases and failure modes.
2. **Spec** — a complete agent specification written to `docs/specs/`.
3. **Plan** — a task-by-task implementation plan written to `docs/plans/`, covering
   tools, workflows, registry, host config, tests, and deployment.
4. **Build** — choose to execute with subagents, launch a Fleet Sprint, or build
   it yourself from the plan.

The guided path handles things that are easy to forget when building manually:

- **Host configuration** — sets up `host.config.mjs` with the right strategy,
  modules, and an `agentDescription` that steers the LLM to use your tools
- **API key propagation** — `executeCommand` doesn't inherit env vars from the
  parent shell; the plan shows how to pass keys through
- **Session cleanup** — clears stale Fleet worker sessions before integration
  testing so the agent starts fresh
- **Memory configuration** — if the agent needs memory, sets up the right
  tiers (conversation context, long-term, run state) and coaches the LLM
  to use memory tools via `agentDescription`

After the build completes, your agent is ready to run — skip to
[Step 3: Run your agent](#step-3-run-your-agent).

---

## Prerequisites

| Requirement | Version / Notes |
|---|---|
| Node.js | **22.16+** |
| Python 3 | On `PATH` as `python3` (for tool scripts) |
| Apra Fleet | `npm install -g @apralabs/apra-fleet && apra-fleet install` |
| OAuth token | `export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"` |

**For Azure Functions deployment only:**
- Docker (to build the container image)
- Azure CLI (`az`)
- Azure Functions Core Tools (`func`) — for local dev

---

## Project structure

```
your-agent/
├── host.config.mjs          ← Your agent's identity and module config
├── mcp/
│   └── registry.mjs         ← Your tool catalog (the only file you edit here)
├── tools/
│   ├── my-tool/
│   │   └── my_tool.py       ← Tool implementation (Python, or any executable)
│   └── another-tool/
│       └── another_tool.py
├── workflows/                ← Multi-step workflows (optional, for complex tools)
├── host/                     ← Kit internals (don't edit)
├── deploy/
│   └── azure-functions/      ← Azure-specific config and Dockerfile
└── docs/
```

You work in three places:
1. **`host.config.mjs`** — agent identity, personality (`agentDescription`), and module config
2. **`mcp/registry.mjs`** — tool catalog (the only file you edit in `mcp/`)
3. **`tools/`** — tool implementations (Python scripts or any executable)

---

## Step 1: Configure your agent

Edit `host.config.mjs`. Here is a minimal config for local development:

```js
export default {
  name: 'my-agent',
  description: 'Short label for logs and the chat header.',

  // This is the agent's personality and domain knowledge. It becomes part of
  // the system prompt the LLM sees before every task. Be specific about what
  // the agent knows, what output format you expect, and any constraints.
  agentDescription: `You are a financial research assistant. You have expertise in:
- Stock market analysis and fundamentals
- Currency exchange rates
- Economic indicators

Always cite the tool that produced each data point. When data is unavailable,
say so explicitly rather than guessing.`,

  fleet: {},

  comm: {
    adapter: 'express',     // 'express' for local/VM, 'azure-functions' for Azure
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',   // or 'open-ended' for simple agents
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
      timeoutMs: 600_000,
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,        // set true to test without executing
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
      themes: ['blue'],         // 'apra', 'blue', or both for a toggle
    },
  },
};
```

### Choosing a strategy

| Strategy | When to use |
|---|---|
| `plan-execute` | Most agents. The LLM creates a plan, a reviewer approves it, then steps execute one at a time. Replans on failure. Safer, auditable. |
| `open-ended` | Simple lookup agents. Act → observe → repeat with no upfront plan. Faster for single-tool tasks, less control. |

### Memory (optional)

The kit has a three-tier memory system. All tiers are off by default — enable
what you need in `modules.memory`.

**Conversation context** — the agent remembers what was discussed earlier in
the chat session. Enable it when your agent handles multi-turn conversations
where users reference prior results ("book the cheapest one").

```js
memory: {
  conversationContext: {
    enabled: true,
    mode: 'store',         // server persists turns; client sends sessionId
    store: 'sqlite',
    dbPath: './memory/conversation.db',
  },
}
```

**Long-term memory** — the agent learns facts across sessions. When enabled,
the agent gains four tools: `remember`, `recall`, `forget`, `promote`. Coach
the agent to use them via `agentDescription`:

```js
memory: {
  longTerm: {
    enabled: true,
    store: 'sqlite',
    dbPath: './memory/memory.db',
    autoLearn: true,       // extract facts after each task
  },
}
```

```
// In agentDescription:
ALWAYS use the recall tool before planning to check for relevant
prior knowledge. Use remember to store useful facts you discover.
```

**Checkpoint** — crash recovery, and the record a paused run resumes from. If a
task is interrupted mid-execution — by a restart or by a question put to a
person — it picks up from the last checkpoint rather than starting over.

```js
memory: {
  checkpoint: {
    enabled: true,
    store: 'sqlite',
    dbPath: './memory/checkpoint.db',
  },
}
```

`memory.runState` is the former name for this block and is still read, so an
existing config keeps working.

### Scheduled Workflows

Run any registered workflow on a cron schedule. Scheduled runs create normal jobs
— they appear in `GET /jobs/:id`, stream events over SSE, and deliver results via
webhook.

```js
// host.config.mjs
modules: {
  scheduler: {
    enabled: true,
    schedules: [
      {
        name: 'morning-briefing',
        workflow: 'city-briefing',
        args: { city: 'Tokyo' },
        cron: '0 9 * * *',          // 9am daily
        timezone: 'Asia/Tokyo',
        overlap: 'queue',            // or 'skip'
      },
    ],
  },
}
```

The scheduler requires `dispatch` to be enabled (it submits jobs through the jobs
pipeline). See [scheduled-workflows.md](scheduled-workflows.md) for the full
reference.

### Config reference

| Field | What it does |
|---|---|
| `name` | Agent identity — shown in logs, chat header, and system prompt as the agent's name |
| `description` | Short label for the chat UI title and log output |
| `agentDescription` | **The agent's personality and domain knowledge.** Injected into the system prompt. This is how you tell the LLM what it is, what it knows, and how it should respond. Can be a multi-line template literal. |
| `comm.adapter` | `'express'` (local/Docker) or `'azure-functions'` |
| `dispatch.backend` | `'in-process'` (default for express) or `'durable'` (Azure only) |
| `dispatch.store.kind` | `'sqlite'` (persists jobs) or `'memory'` (testing only) |
| `dispatch.concurrency` | Max parallel tasks |
| `budgets.*` | Cost and safety limits per task |
| `chat.themes` | `['blue']`, `['apra']`, or `['blue', 'apra']` for a toggle |
| `memory.conversationContext` | Carries chat turns across tasks within a session. Mode: `store` (server persists) or `passthrough` (caller sends) |
| `memory.checkpoint` | Crash recovery and pause/resume — one record both read from. `memory.runState` is the former name and still works |
| `memory.longTerm` | Cross-session fact storage with FSRS-6 decay. Adds `remember`/`recall`/`forget`/`promote` tools |
| `modules.scheduler` | Cron schedules that fire named workflows (timezone-aware, `queue` or `skip` overlap). Requires `dispatch` enabled. See [scheduled-workflows.md](scheduled-workflows.md) |

---

## Step 2: Write your tools

A tool is two things: an **implementation** (a script that does the work) and a
**registry entry** (metadata that tells the LLM what the tool does).

### 2a. Write the implementation

Create a script in `tools/your-tool/`. Python is typical but anything that reads
argv and prints JSON to stdout works.

```python
# tools/stock-price/stock_price.py
import json, sys, urllib.request

def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    try:
        # your API call here
        url = f"https://api.example.com/quote/{symbol}"
        req = urllib.request.Request(url, headers={"User-Agent": "my-agent/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        print(json.dumps({"ok": True, "symbol": symbol, "price": data["price"]}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    main()
```

**Rules:**
- Print exactly one JSON object to stdout
- Include an `"ok": true/false` field
- Handle errors — don't let the script crash without output
- Use only stdlib or vendored dependencies (the script runs inside a Fleet worker)

### 2b. Register the tool

Add an entry to the `defaultRegistry` array in `mcp/registry.mjs`:

```js
import * as z from 'zod/v4';

// In the defaultRegistry array:
{
  name: 'stock-price',
  description:
    'Fetches the current stock price for a given ticker symbol. ' +
    'Returns the price in USD. Read-only, no LLM tokens.',
  inputSchema: z.object({
    symbol: z.string().describe('Ticker symbol (e.g. AAPL, MSFT).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run({ fleetApi, args }) {
    const symbol = shellEscape(args.symbol || 'AAPL');
    const script = path.join(toolsDir, 'stock-price', 'stock_price.py');
    const raw = await fleetApi.executeCommand({
      member_name: 'doer',
      command: `python3 "${script}" "${symbol}"`,
    });
    return parseToolOutput(raw);
  },
},
```

That's it. No changes to `server.mjs`, `routes.mjs`, or any other file. The registry
is the single source of truth for tools.

### Registry entry anatomy

| Field | Required | What it does |
|---|---|---|
| `name` | Yes | Tool identifier (kebab-case) |
| `description` | Yes | **Written for the LLM** that picks tools — be specific about what it returns and costs |
| `inputSchema` | No | Zod schema for arguments. Omit for no-arg tools. |
| `annotations` | No | `readOnlyHint`, `idempotentHint` — helps the reviewer gate decisions |
| `run()` | Yes | Receives `{ fleetApi, args, signal, reportPhase, workspace }` |

### Tool patterns

**Python script** (most common):
```js
async run({ fleetApi, args }) {
  const script = path.join(toolsDir, 'my-tool', 'my_tool.py');
  const raw = await fleetApi.executeCommand({
    member_name: 'doer',
    command: `python3 "${script}" "${shellEscape(args.input)}"`,
  });
  return parseToolOutput(raw);
},
```

**JavaScript workflow** (multi-step, uses agent reasoning):
```js
import { runMyWorkflow } from '../workflows/my-workflow/main.mjs';

async run({ fleetApi, args, signal, reportPhase, workspace }) {
  const result = await runMyWorkflow({ fleetApi, workspace, signal, reportPhase, ...args });
  return `workflow completed: ${JSON.stringify(result)}`;
},
```

**Direct HTTP call** (no Fleet worker needed):
```js
async run({ args }) {
  const res = await fetch(`https://api.example.com/data/${args.id}`);
  return await res.json();
},
```

---

## Step 3: Run your agent

There are two deployment modes and two ways to run each — pick what fits your setup:

| | **VM** | **Azure Functions** |
|---|---|---|
| **What it is** | Express server + SQLite jobs | Azure Functions host + Durable Functions |
| **Jobs backend** | `in-process` (SQLite) | `durable` (Azurite locally, Azure Storage in prod) |
| **Scaling** | Single process | Horizontal (task hub is shared state) |
| **Entry point** | `node host/index.mjs` | `comm/azure-functions/main.mjs` |
| **Config** | `host.config.mjs` (root) | `deploy/azure-functions/host.config.mjs` |
| **Chat URL** | `http://localhost:3000/chat` | `http://localhost:7071/api/chat` |

### Prerequisites (all modes)

```bash
npm install
```

Generate a token (you'll pass it to Docker or export it for local dev):

```bash
claude setup-token
```

---

### Option A: VM — without Docker

The simplest way to run. Uses the Express adapter with SQLite-backed jobs.

```bash
# Linux / macOS
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
node host/index.mjs
```

```powershell
# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token)
node host/index.mjs
```

The agent starts on `http://localhost:3000`:

| Endpoint | What it does |
|---|---|
| `GET /chat` | Chat UI |
| `POST /task` | Submit a goal `{ "goal": "..." }` |
| `GET /jobs/{id}` | Poll job status |
| `DELETE /jobs/{id}` | Cancel a job |
| `GET /jobs/{id}/events` | SSE event stream |
| `POST /mcp` | MCP tool server endpoint |
| `GET /health` | Liveness check |
| `GET /schedules` | List scheduled workflows |

---

### Option B: VM — with Docker

Same VM mode, but containerized. No Node.js install needed on the host.

```bash
# Linux / macOS
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) docker compose up -d --build
```

```powershell
# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token); docker compose up -d --build
```

Chat UI at **http://localhost:3000/chat**. Same endpoints as Option A.

Stop with:
```bash
docker compose down
```

---

### Option C: Azure Functions — without Docker

Uses Azure Functions Core Tools (`func` CLI) to run the Functions host locally
with Azurite for storage emulation. This is the closest to a real Azure deployment
without needing Docker.

**Extra prerequisites:**
- [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local) (`func`)
- [Azurite](https://www.npmjs.com/package/azurite) (`npm install -g azurite`)

Run with the included helper script:

```powershell
# Windows — real LLM, Durable backend
.\scripts\start-func-local.ps1 -Durable

# Windows — real LLM, in-process backend (avoids Durable extension issues)
.\scripts\start-func-local.ps1

# Windows — mock LLM (no API calls, for testing)
.\scripts\start-func-local.ps1 -Token mock
```

The script handles everything: starts Azurite, swaps the config to the
`azure-functions` adapter, runs `func start`, and restores everything on Ctrl+C.

Chat UI at **http://localhost:7071/api/chat**. All endpoints are prefixed with `/api`.

| Endpoint | What it does |
|---|---|
| `GET /api/chat` | Chat UI |
| `POST /api/task` | Submit a goal `{ "goal": "..." }` |
| `GET /api/jobs/{id}` | Poll job status |
| `DELETE /api/jobs/{id}` | Cancel a job |
| `GET /api/jobs/{id}/events` | SSE event stream |
| `POST /api/mcp` | MCP tool server endpoint |
| `GET /api/health` | Liveness check |
| `GET /api/schedules` | List scheduled workflows |

---

### Option D: Azure Functions — with Docker

Runs the full Azure Functions container image with Azurite — the closest to
production. This is what gets deployed to Azure.

```bash
# Linux / macOS
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) docker compose -f docker-compose.azure.yml up -d --build
```

```powershell
# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token); docker compose -f docker-compose.azure.yml up -d --build
```

The first startup takes ~60–90 seconds while the Functions host downloads its
extension bundle. Wait for the health check to pass:

```bash
docker compose -f docker-compose.azure.yml ps
```

Once `agent` shows **healthy**, open **http://localhost:7071/api/chat**.
Same `/api`-prefixed endpoints as Option C.

Stop with:
```bash
docker compose -f docker-compose.azure.yml down
```

---

### What's in each Docker compose file?

**`docker-compose.yml`** (VM):

| Container | Purpose |
|---|---|
| `agent` | Your agent (Express + SQLite) on port 3000 |

**`docker-compose.azure.yml`** (Azure Functions):

| Container | Purpose |
|---|---|
| `azurite` | Local Azure Storage emulator (queues, tables, blobs for Durable Functions) |
| `agent` | Azure Functions host with your agent on port 7071 |

---

### Production deployment (Azure)

For deploying to Azure Functions with horizontal scaling, see
[deploy-azure-functions.md](deploy-azure-functions.md).

---

## Authentication

### Fleet workers (required)

Fleet workers need an OAuth token to operate. This is how the kit authenticates
with the underlying Claude Code workers that execute tool calls.

```bash
# Generate a token
claude setup-token
```

Pass it when you start the agent — the token never goes in a file:

```bash
# Local (no Docker)
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
node host/index.mjs

# Docker (VM)
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) docker compose up -d --build

# Docker (Azure Functions)
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) docker compose -f docker-compose.azure.yml up -d --build
```

For Azure Functions production, store the token in Key Vault and reference it
as an app setting (see [deploy-azure-functions.md](deploy-azure-functions.md)):

```bash
SECRET_URI=$(az keyvault secret show --vault-name my-vault --name claude-token --query id -o tsv)
az functionapp config appsettings set \
  --name my-agent-app \
  --resource-group my-rg \
  --settings CLAUDE_CODE_OAUTH_TOKEN="@Microsoft.KeyVault(SecretUri=$SECRET_URI)"
```

### API authentication (optional)

By default, the agent's HTTP endpoints (`/task`, `/jobs`, `/mcp`) are **open** —
no auth required. This is fine for local development.

For production, inject a custom authenticator when starting the host:

```js
// custom-auth.mjs
export function authenticateRequest(request) {
  const token = request.headers['authorization']?.replace('Bearer ', '');
  if (!token || token !== process.env.API_SECRET) return null; // rejected
  return { id: 'api-user' }; // accepted — returned as req.user
}
```

The kit calls your function on every request to auth-protected routes. Return a
user object to allow, or `null` to reject with 401. The chat UI routes (`/chat`,
`/chat/app.mjs`) and `/health` are always unauthenticated.

---

## Connect via MCP

Your agent exposes an MCP endpoint at `/mcp`. Any MCP-capable client can connect
to it and call your tools directly.

### Register with Claude Code

```bash
# Local agent
claude mcp add --transport http my-agent http://127.0.0.1:3000/mcp

# Azure Functions
claude mcp add --transport http my-agent https://my-agent-app.azurewebsites.net/api/mcp
```

Once registered, Claude Code can discover and call all your tools. Ask it
"what tools does my-agent have?" to verify.

### Register with other MCP clients

Any client that supports HTTP transport can connect:

```
Endpoint:  http://localhost:3000/mcp
Transport: HTTP (Streamable)
```

On Azure Functions, the MCP endpoint uses the web-standard transport
(`WebStandardStreamableHTTPServerTransport`) instead of the Express-specific one.

### With authentication

If you've added API auth, pass the header when registering:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer your-api-secret" \
  my-agent http://127.0.0.1:3000/mcp
```

### MCP vs. autonomous mode

| Mode | How it works | When to use |
|---|---|---|
| **MCP (tool server)** | External LLM calls your tools directly via `/mcp` | You want Claude Code or another AI to pick which tools to call |
| **Autonomous (`/task`)** | Your agent plans, reviews, and executes on its own | You want to submit a goal and get a complete answer back |
| **Both** | Both endpoints are live simultaneously | Most setups — let users choose |

---

## Step 4: Test it

### Via the chat UI

Open the chat URL for your mode and type a goal:

| Mode | Chat URL |
|---|---|
| VM (Options A / B) | `http://localhost:3000/chat` |
| Azure Functions (Options C / D) | `http://localhost:7071/api/chat` |

The UI shows:

1. **Status pipeline** — Generating Plan → Reviewing → Approved → Running → Complete
2. **Plan card** — each tool step with status, expandable results
3. **Final answer** — rendered markdown

### Via curl

```bash
# VM mode
curl -sX POST localhost:3000/task \
  -H "content-type: application/json" \
  -d '{"goal":"What is the weather in Tokyo?"}'

curl -N localhost:3000/jobs/<jobId>/events
curl -s localhost:3000/jobs/<jobId>

# Azure Functions mode (same commands, /api prefix)
curl -sX POST localhost:7071/api/task \
  -H "content-type: application/json" \
  -d '{"goal":"What is the weather in Tokyo?"}'

curl -N localhost:7071/api/jobs/<jobId>/events
curl -s localhost:7071/api/jobs/<jobId>
```

### Via MCP

Connect any MCP-capable client:

```bash
# VM mode
claude mcp add --transport http my-agent http://127.0.0.1:3000/mcp

# Azure Functions mode
claude mcp add --transport http my-agent http://127.0.0.1:7071/api/mcp
```

---

## Step 5: Iterate

### Adding more tools

1. Create `tools/new-tool/new_tool.py`
2. Add a registry entry in `mcp/registry.mjs`
3. Restart the host

### Tuning the agent

| Want to... | Change |
|---|---|
| Make the agent more careful | Increase `maxReviewAttempts`, set `minReviewPolicy: 'always'` |
| Make the agent faster | Use `strategy: 'open-ended'`, reduce `maxIterations` |
| Increase cost limit | Raise `budgets.maxCostUsd` |
| Allow more parallel tasks | Raise `dispatch.concurrency` |
| Disable the planner | Set `runLoop.enabled: false` — tools-only MCP mode |

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (required) | Fleet worker authentication |
| `PORT` | `3000` | HTTP listen port |
| `WORKER_POOL_SIZE` | `4` | Persistent worker count |
| `WORKER_EPHEMERAL_MAX` | `10` | Max ephemeral workers for burst |
| `CHAT_ENABLED` | from config | Override chat on/off (`true`/`false`) |

---

## Two modes of operation

### Tool server only (no autonomous agent)

Disable the run loop. An external LLM (Claude Code, another agent) calls your tools
via MCP. You provide tools; the caller provides reasoning.

```js
modules: {
  runLoop: { enabled: false },
  // dispatch, chat, etc. disabled
}
```

Run with `npm run mcp` or `node mcp/main.mjs`.

### Full autonomous agent

Enable all modules. The agent receives a goal, plans, calls tools, reviews, and
returns a complete answer. This is the default configuration.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `chat enabled but dispatch disabled` | Enable both `dispatch` and `notify.sse` when chat is on |
| `durable backend requires azure-functions adapter` | Use `backend: 'in-process'` with the express adapter |
| Tool script hangs | Add a timeout in your Python script; the kit enforces `budgets.timeoutMs` at the task level |
| `City not found` / tool returns `ok: false` | Check your tool's error handling — the agent sees the error and replans |
| Workers not starting | Verify `CLAUDE_CODE_OAUTH_TOKEN` is set and valid |

---

## What's next

- [memory.md](memory.md) — three-tier memory system: conversation context, long-term facts, decay, memory tools
- [run-loop.md](run-loop.md) — deep dive into strategies, prompts, and review policies
- [jobs.md](jobs.md) — full async jobs API reference
- [chat-ui.md](chat-ui.md) — chat page internals and theming
- [deploy-azure-functions.md](deploy-azure-functions.md) — production deployment
- [architecture.md](architecture.md) — how the kit works internally (for contributors)
