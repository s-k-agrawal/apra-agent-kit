# Documentation

### Build an agent

| Document | Read it when |
|---|---|
| [getting-started.md](getting-started.md) | **Start here.** You want to build your own agent — configure it, add tools, run it, deploy it. No kit internals required. |
| [roadmap.md](roadmap.md) | You want to see what's shipped, in progress, and planned. |

### Understand the system

| Document | Read it when |
|---|---|
| [architecture.md](architecture.md) | You want the big picture: component diagram, how the layers fit, data flow, and design decisions. |
| [architecture-diagram.html](architecture-diagram.html) | Visual component diagram — open in a browser for the color-coded interactive version. |
| [development.md](development.md) | You are setting up, running tests, adding a workflow, or debugging a failure. |
| [mcp-interface.md](mcp-interface.md) | You are setting up or extending the MCP server — tool catalog, registry contract, timeouts, auth, and hosting. |
| [run-loop.md](run-loop.md) | You want the detailed reference for the autonomous run loop: strategies, budgets, guardrails, prompt templates, and the `/task` API. |
| [memory.md](memory.md) | You want the memory system: conversation context, long-term facts with FSRS-6 decay, checkpoint recovery, memory tools, store adapters, and the REST API. |
| [chat-ui.md](chat-ui.md) | You want the built-in chat page: enabling it, what the card shows, the console event log, and its limits. |
| [jobs.md](jobs.md) | Async jobs API: submit, poll, SSE, webhooks, cancellation, and MCP job tools. |
| [deploy-azure-functions.md](deploy-azure-functions.md) | Deploy the agent on Azure Functions Premium with the Durable jobs backend. |

### Specs

Design documents for features that have been implemented or proposed.

| Spec | Status | Covers |
|---|---|---|
| [agent-kit-vision-spec](specs/agent-kit-vision-spec.md) | Implemented | Vision spec for the modular agent kit. |
| [stdio-transport-spec](specs/stdio-transport-spec.md) | Implemented | Spawning Fleet over stdio (the current downstream transport). |
| [concurrency-spec](specs/concurrency-spec.md) | Implemented | Original shared worker pool design (superseded by tiered dispatch). |
| [tiered-worker-dispatch-spec](specs/tiered-worker-dispatch-spec.md) | Implemented | Tiered worker dispatch: pool + ephemeral + queue. |
| [phase1-host-layer-spec](specs/phase1-host-layer-spec.md) | Implemented | Host layer: config, tools, communication adapter. |
| [phase2-run-loop-spec](specs/phase2-run-loop-spec.md) | Implemented | Run loop, strategies, budgets, guardrails. |
| [phase3-memory-eval-spec](specs/phase3-memory-eval-spec.md) | Approved | Memory (3 kinds) + eval harness. |
| [phase4-jobs-durable-spec](specs/phase4-jobs-durable-spec.md) | Implemented | Async jobs API, notifier, Durable backend, Azure Functions adapter. |
| [chat-ui-spec](specs/chat-ui-spec.md) | Implemented | Built-in chat page over the job SSE stream. |
| [travel-agent-quality-spec](specs/travel-agent-quality-spec.md) | Implemented | Prompt overhaul + new tools for travel agent quality. |

The [root README](../README.md) is the homepage: what the kit is, how to build an agent, and how to contribute.
