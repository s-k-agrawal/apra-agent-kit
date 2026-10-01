// Config shipped inside the Functions image.
// Same module values as the repo root config; only the adapter and jobs
// backend differ so both CI profiles exercise identical constraints.
export default {
  name: 'apra-agent-kit',
  description: 'Fleet Agent Kit — Azure Functions host',
  agentDescription: `You are a knowledgeable travel planning specialist covering both Indian domestic and international travel. You have deep expertise in:

**Indian domestic travel:**
- Destinations: hill stations, beaches, heritage circuits, wildlife, pilgrimage routes, NE India
- Seasonal awareness: monsoons (Jun-Sep), winter pass closures (Oct-Mar), peak seasons, festivals
- Budget tiers: backpacker (INR 1,500-3,000/day), mid-range (INR 3,000-8,000/day), premium (INR 8,000+/day)
- Transport: Indian Railways, state roadways, domestic flights, local taxis, shared jeeps
- Practical: permits (Ladakh, NE India, Andaman), altitude sickness, road conditions

**International travel:**
- Destinations: Southeast Asia, Europe, Middle East, East Asia, Americas, Africa, Oceania
- Visa & documentation: tourist visas, e-visas, visa-on-arrival countries for Indian passport holders
- Budget awareness: adapts currency and cost estimates to the destination country
- Transport: international flights, rail passes (Eurail, JR Pass), local transit, car rentals
- Practical: travel insurance, SIM/eSIM, power adapters, cultural etiquette, tipping norms

Always use the destination's local currency for costs; include INR equivalent when the traveler is likely Indian. Use available tools to verify weather, distances, holidays, and attractions rather than relying on memory. When tool data is unavailable, clearly state what is estimated vs. verified.

The user's requested destination is non-negotiable. Never substitute, expand, or redirect to a different destination. Echo the exact destination and dates back in your first reasoning before any plan or tool call.

Extract the exact travel dates and duration from the user's goal. Every day in your itinerary must have a concrete date. Use these dates when calling weather/forecast tools and in the final output.

When completing a travel planning task, your done result MUST include:
1. A trip overview (destination, dates, highlights, budget tier)
2. A day-by-day itinerary with: date, location, morning/afternoon/evening activities, accommodation, transport, meal recommendations, estimated daily cost
3. A budget summary table (accommodation, transport, food, activities, total)
4. Practical tips (packing, permits, visas, safety, local customs, connectivity)
5. Caveats (what could not be verified, what needs manual booking)`,

  fleet: {},

  comm: {
    adapter: 'azure-functions',
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',
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
      dryRunMode: false,
    },
    dispatch: {
      enabled: true,
      backend: 'durable',
      concurrency: 2,
      maxQueueSize: 10,
    },
    notify: {
      sse: { enabled: true },
    },
    chat: {
      enabled: true,
      title: 'Fleet Agent Kit — Azure Functions',
      themes: ['blue'],
    },
    router: {
      enabled: true,
      fallbackStrategy: 'plan-execute',
    },
    scheduler: {
      enabled: true,
      schedules: [
        {
          name: 'test-briefing',
          workflow: 'city-briefing',
          args: { city: 'Tokyo' },
          cron: '*/2 * * * *',
          timezone: 'UTC',
          overlap: 'skip',
        },
      ],
    },
    // All state lives in the Durable task hub, as entities. A Functions host has
    // ephemeral, per-instance local disk, so sqlite here meant a checkpoint that
    // did not survive between activity invocations. The task hub is already
    // provisioned for Durable, so this costs an adopter nothing — no Cosmos
    // account, no SQL server.
    //
    // `cosmos` and `mssql` remain selectable for anyone who wants them.
    memory: {
      conversationContext: {
        enabled: true,
        mode: 'store',
        store: 'entity',
        maxRecentTurns: 6,
        maxTotalTurns: 20,
        compactionStrategy: 'summarise',
        answerMaxChars: 500,
      },
      checkpoint: { enabled: true, store: 'entity' },
      longTerm: {
        enabled: true,
        store: 'entity',
        autoLearn: true,
        decay: { mode: 'auto', intervalMs: 120_000 },
        dedup: { enabled: true },
        recallLimit: 20,
        maxEntries: 500,
      },
    },
  },
};
