# Memory

The kit has a three-tier memory system. Each tier is independent and optional —
enable what you need in `modules.memory` in `host.config.mjs`.

| Tier | What it does | Scope | Store |
|------|-------------|-------|-------|
| **Conversation context** | Prior chat turns within a session | Single browser tab / API session | SQLite or Cosmos |
| **Run state** | Crash recovery checkpoints | Single task run | SQLite or Cosmos |
| **Long-term memory** | Cross-session facts with spaced-repetition decay | All sessions, all time | SQLite, Cosmos, or filesystem |

When all three are enabled, a typical task lifecycle looks like this:

```
1. Chat message arrives with sessionId
2. Conversation context loads prior turns for this session
3. Long-term memory recalls relevant facts by tag
4. Both are injected into the system prompt
5. The run loop executes the task
6. After completion:
   a. The goal+answer pair is recorded as a conversation turn
   b. The learner extracts reusable facts into long-term memory
   c. Run state checkpoint is cleared
```

---

## Configuration

All memory config lives under `modules.memory` in `host.config.mjs`:

```js
modules: {
  memory: {
    conversationContext: {
      enabled: true,
      mode: 'store',                      // 'store' | 'passthrough'
      store: 'sqlite',                    // 'sqlite' | 'cosmos' | function
      dbPath: './memory/conversation.db', // sqlite only
      maxRecentTurns: 6,                  // verbatim turns kept in prompt
      maxTotalTurns: 20,                  // cap per session before eviction
      compactionStrategy: 'summarise',    // 'summarise' | 'sliding-window'
      answerMaxChars: 500,                // truncate stored answers
    },

    checkpoint: {                        // former name `runState` still works
      enabled: true,
      store: 'sqlite',
      dbPath: './memory/checkpoint.db',
    },

    longTerm: {
      enabled: true,
      store: 'sqlite',                   // 'sqlite' | 'cosmos' | 'filesystem' | function
      dbPath: './memory/memory.db',      // sqlite only
      dir: './memory',                   // filesystem only
      autoLearn: true,                   // learner extracts facts after each task
      decay: {
        mode: 'auto',                    // 'auto' | 'on-recall' | 'none'
        intervalMs: 120_000,             // auto mode: timer interval
      },
      dedup: { enabled: true },
      recallLimit: 20,                   // max facts per recall
      maxEntries: 500,                   // cap before purge
      preloadDir: './knowledge',         // optional: seed .json files on startup
    },
  },
}
```

---

## Tier 1: Conversation Context

Carries prior chat turns (user goals + agent answers) across tasks within a
single chat session. Enables the user to say "book the cheapest one" after a
search, or "do that again" — the agent sees what was discussed.

### Two modes

**Store mode** (default) — the server persists turns in SQLite or Cosmos. The
client sends a `sessionId` with each request. The server loads, decays,
optionally compacts, and injects turns into the prompt. After the task, the
goal+answer pair is recorded.

**Passthrough mode** — the caller sends `conversation[]` with each request. The
server injects it into the prompt but does no storage, decay, or compaction.
Use this for API callers who manage their own state, lightweight deployments,
or testing.

### How it works (store mode)

On each task:

1. **Load** — all turns for the `sessionId` are fetched from the store,
   ordered by `turnIndex`.
2. **Decay** — each turn's retrievalStrength is recomputed via FSRS-6.
   Turns that drop below thresholds transition: `active` → `dormant` →
   `silent` → `unavailable`. Only `active` and `dormant` turns are visible.
3. **Compact** — if visible turns exceed `maxRecentTurns`:
   - `summarise` strategy: older turns are summarised by the LLM into one
     paragraph, recent turns are kept verbatim.
   - `sliding-window` strategy: older turns are dropped, recent kept.
   - If summarisation fails, falls back to sliding-window automatically.
4. **Inject** — the formatted conversation is added to the system prompt
   as a `## Conversation History` section.
5. **Record** — after the task completes, the goal+answer pair is appended
   as a new turn (answer truncated to `answerMaxChars`).

### Eviction

When a session exceeds `maxTotalTurns`, the turns with the lowest
`retrievalStrength` are marked `unavailable` to make room.

### Session isolation

Each browser tab generates its own `sessionId` (stored in `sessionStorage`).
Turns from one session never leak into another's context.

### Conversation store

The conversation context uses its own store interface, separate from the
long-term memory store:

| Method | What it does |
|--------|-------------|
| `open()` | Connect, create tables |
| `close()` | Cleanup |
| `append(turn)` | Insert a turn |
| `get(id)` | Fetch one turn |
| `update(id, patch)` | Merge fields into a turn |
| `listSession(sessionId, opts)` | List turns for a session, ordered by turnIndex |
| `purgeSessions({ olderThanDays })` | Remove old sessions |

Implementations: `host/memory/conversation-store/sqlite.mjs` (SQLite) and
`host/memory/conversation-store/cosmos.mjs` (Cosmos, lazy-loaded).

---

## Tier 2: Run State

Crash recovery for the plan-execute strategy. If a task is interrupted
mid-execution (process crash, timeout, deployment), the checkpoint is
persisted so the task can resume from the last completed step.

Run state stores checkpoints as memory entries tagged `__run_state__` in the
same store backend as long-term memory. Each checkpoint captures the current
plan, completed steps, and accumulated observations.

Run state has no user-facing configuration beyond `enabled` and `store`.

---

## Tier 3: Long-Term Memory

Cross-session fact storage. The agent accumulates domain knowledge, user
preferences, patterns, and procedures over time. Facts that prove useful
are reinforced; facts that go unused decay and eventually disappear.

### Memory entry schema

```js
{
  id:                 'mem-<uuid12>',
  kind:               'domain',          // domain | preference | pattern | procedure
  text:               'Tokyo Narita has 3 terminals',
  tags:               ['tokyo', 'airport'],
  source:             'agent',           // human | agent | system
  confidence:         0.8,
  retrievalStrength:  0.95,              // FSRS-6 managed — decays over time
  stability:          2.5,               // FSRS-6 managed — grows with reinforcement
  state:              'active',          // active | dormant | silent | unavailable
  createdAt:          '2026-09-28T...',
  lastPromotedAt:     '2026-09-28T...',
}
```

### Fact kinds

| Kind | Use for | Example |
|------|---------|---------|
| `domain` | Domain-specific knowledge | "Tokyo Narita has 3 terminals" |
| `preference` | User preferences | "User prefers window seats" |
| `pattern` | Recurring patterns | "Flights to Osaka are cheapest on Tuesdays" |
| `procedure` | How-to knowledge | "To book JR Pass, use the online portal first" |

### Recall

Before each task, the host calls `longTerm.recall()` with tags extracted from
the task goal. Matching facts (up to `recallLimit`) are injected into the
system prompt under `## Your Memory`. Rules are listed first ("always follow
these"), then facts ("relevant knowledge").

### FSRS-6 Decay

The kit uses the FSRS-6 spaced-repetition algorithm (pre-trained on 700M+
Anki reviews) to manage memory strength. Each fact has two FSRS parameters:

- **retrievalStrength** — probability the fact can be recalled right now.
  Decays over time since last use.
- **stability** — how slowly the fact decays. Grows each time the fact is
  reinforced (used or promoted).

The decay engine runs on a timer (`decay.mode: 'auto'`) or on each recall
(`decay.mode: 'on-recall'`). As retrievalStrength drops, facts transition
through states:

```
active (R ≥ 0.7) → dormant (R ≥ 0.4) → silent (R ≥ 0.1) → unavailable (R < 0.1)
```

- **active** — included in recall results and system prompt
- **dormant** — included in recall but ranked lower
- **silent** — excluded from recall, still in storage (can be promoted back)
- **unavailable** — eligible for purge

### Dedup

When `dedup.enabled` is true, storing a fact that matches an existing one
(by text similarity) either **reinforces** the existing fact (boosts its
stability) or **merges** them, rather than creating a duplicate.

### Auto-learn (Learner)

When `autoLearn` is true, the learner runs after each completed task. It
sends the task goal, observation history, and recalled facts to the LLM
with a prompt asking it to extract reusable facts. The LLM returns:

- **newFacts** — domain knowledge, preferences, patterns, or procedures
  discovered during the task. Each is stored in long-term memory.
- **usedRecalledIds** — IDs of recalled facts that were actually used.
  These are promoted (reinforced against decay).

The learner only extracts facts useful across future runs — not task-specific
results.

### Preloader

If `preloadDir` is configured, the host loads `.json` files from that
directory on startup. Each JSON file contains one memory entry object (or
an array of them) with their own `kind` field. Duplicates are skipped
via the dedup gate.

```
knowledge/
├── city-data.json       → memory entries with their own kind fields
├── visa-rules.json      → memory entries with their own kind fields
└── booking-tips.json    → memory entries with their own kind fields
```

Example entry format:

```json
{
  "kind": "domain",
  "text": "Indian passport holders get visa-on-arrival in Thailand for 30 days",
  "tags": ["india", "thailand", "visa"]
}
```

### Memory store interface

Long-term memory uses a pluggable store adapter:

| Method | What it does |
|--------|-------------|
| `open()` | Connect, create tables/directories |
| `close()` | Cleanup |
| `store(entry)` | Insert or dedup a fact |
| `get(id)` | Fetch one fact |
| `update(id, patch)` | Merge fields into a fact |
| `remove(id)` | Delete a fact |
| `query(opts)` | Search by tags, kinds, states, text |
| `purge(opts)` | Remove unavailable/expired facts |
| `count()` | Total facts in store |

### Store backends

| Backend | When to use | Notes |
|---------|------------|-------|
| `sqlite` | Local dev, single-instance | `node:sqlite` `DatabaseSync`, WAL mode |
| `cosmos` | Azure deployments | Lazy-loaded `@azure/cosmos`, partition key: `kind` |
| `filesystem` | Simplest option | JSON files in a directory, long-term only |
| function | Custom adapter | Receives config, returns store implementing the interface |

---

## Memory Tools

When long-term memory is enabled, the host automatically registers four tools
via `withMemoryTools()`. These appear alongside your custom tools — no
registry entry needed.

| Tool | Description | Input |
|------|------------|-------|
| `remember` | Store a fact in long-term memory | `{ text, kind, tags? }` |
| `recall` | Retrieve relevant facts | `{ tags?, kinds?, query?, limit? }` |
| `forget` | Remove a fact by ID | `{ id }` |
| `promote` | Mark a fact as useful (strengthens against decay) | `{ id }` |

The LLM uses these during task execution — for example, recalling knowledge
before planning, or remembering a user preference for next time.

### Coaching the LLM

The `agentDescription` in `host.config.mjs` should tell the LLM when and how
to use memory tools:

```
ALWAYS use the recall tool at the start of each task to check for relevant
prior knowledge. Use the remember tool to store useful facts you discover.

When the user corrects your output or provides a preference, use the remember
tool to store it as a 'preference' fact so you apply it in future conversations.
```

---

## REST API

When long-term memory is enabled, the host exposes REST endpoints:

| Method | Path | What it does |
|--------|------|-------------|
| `POST` | `/memory` | Store a fact (`{ text, kind, tags? }`) |
| `GET` | `/memory` | Query facts (`?kinds=domain&tags=tokyo&limit=10`) |
| `GET` | `/memory/:id` | Get one fact |
| `PATCH` | `/memory/:id` | Update a fact |
| `PATCH` | `/memory/:id/promote` | Promote (reinforce) a fact |
| `DELETE` | `/memory/:id` | Remove a fact |

---

## Events

Memory operations emit events through the SSE stream:

| Event | When | Payload |
|-------|------|---------|
| `memory:recall` | Facts recalled before a task | `{ count }` |
| `memory:store` | A fact is stored | `{ id, kind }` |
| `memory:learn` | Learner finishes after a task | `{ taskId, newFacts, promotedIds }` |
| `memory:error` | A memory operation fails gracefully | `{ tier, error, policy }` |
| `memory:conversation:recall` | Conversation turns loaded | `{ sessionId, turnCount }` |
| `memory:conversation:store` | A conversation turn recorded | `{ sessionId, turnId }` |
| `memory:conversation:compact` | Compaction ran | `{ sessionId, strategy, survivingTurns }` |

The chat UI uses these to show the RECALLED MEMORIES and LEARNED panels.

---

## Graceful degradation

Every memory operation is wrapped in try/catch. Failures never halt a task:

- **Store fails to open** — host starts without memory, logs a warning
- **Recall fails** — task runs with empty memory (blank-slate policy)
- **Conversation context fails** — task runs without conversation history
- **Learner fails** — task completes, no facts extracted
- **Summarisation fails** — falls back to sliding-window compaction
- **Dedup fails** — fact is stored as new (may create a duplicate)

---

## File layout

```
host/memory/
├── index.mjs                      # Module factory — wires all tiers
├── conversation-context.mjs       # Tier 1: conversation turn management
├── conversation-store/
│   ├── interface.mjs              # Store contract (7 methods)
│   ├── sqlite.mjs                 # SQLite adapter
│   └── cosmos.mjs                 # Cosmos adapter (lazy-loaded)
├── ../checkpoint/                 # Tier 2: the run checkpoint — crash recovery
│                                  #   and pause/resume, backed by this module's
│                                  #   store (see host/checkpoint/)
├── long-term.mjs                  # Tier 3: fact lifecycle (store/recall/decay)
├── learner.mjs                    # Auto-learn: extract facts after tasks
├── preloader.mjs                  # Seed .json knowledge on startup
├── working-context.mjs            # (deprecated — replaced by conversation-context)
├── events.mjs                     # SSE event emitter
├── routes.mjs                     # REST API route builder
├── store/
│   ├── interface.mjs              # Long-term store contract (9 methods)
│   ├── sqlite.mjs                 # SQLite adapter
│   ├── cosmos.mjs                 # Cosmos adapter (lazy-loaded)
│   └── filesystem.mjs             # Filesystem adapter (JSON files)
├── decay/
│   ├── interface.mjs              # Decay engine contract + default thresholds
│   ├── fsrs6.mjs                  # FSRS-6 algorithm implementation
│   └── timer.mjs                  # Periodic decay timer
└── dedup/
    └── index.mjs                  # Duplicate detection gate
```
