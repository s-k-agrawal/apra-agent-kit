// mcp/human-input-tools.mjs
//
// Three demo tools that exist to make durable human input visible in the
// travel agent, because every other tool in this kit is read-only and would
// never trigger a question.
//
// They do no real work and call no external service:
//
//   choose-destination   resolves an ambiguous city name  → one question
//   trip-preferences     asks how to shape the trip       → four, in one batch
//   confirm-itinerary    "saves" a plan to a Map          → the guardrail asks
//
// Between them they drive every path: all five question kinds, a multi-field
// batch, the guardrail approval, and a reversal with something real to take
// back.
//
// **Delete all three when adopting the kit.** They are demo scaffolding, and
// the adoption flow already says to delete the demo tools.

import * as z from 'zod/v4';

// Stands in for whatever a real deployment would write to. Per-process and
// deliberately not persisted — it is here so a reversal has something to undo.
const saved = new Map();

export function savedItineraries() {
  return saved;
}

// Cities whose names are genuinely ambiguous, to demonstrate a tool asking a
// question of its own rather than the guardrail asking on its behalf.
const AMBIGUOUS = {
  paris: [
    { value: 'geo-2988507', label: 'Paris, France' },
    { value: 'geo-4717560', label: 'Paris, Texas, USA' },
  ],
  hyderabad: [
    { value: 'geo-1269843', label: 'Hyderabad, Telangana, India' },
    { value: 'geo-1173491', label: 'Hyderabad, Sindh, Pakistan' },
  ],
  springfield: [
    { value: 'geo-4951257', label: 'Springfield, Massachusetts, USA' },
    { value: 'geo-4409896', label: 'Springfield, Missouri, USA' },
    { value: 'geo-4245152', label: 'Springfield, Illinois, USA' },
  ],
};

export const humanInputDemoTools = [
  {
    name: 'choose-destination',
    // Deliberately names no cities. A description listing examples primes the
    // model on those specific places, and every prompt carries the tool
    // catalogue - so the names would show up in contexts that have nothing to
    // do with them.
    description:
      'Resolves a city name to a specific place. When the name could refer to more than one ' +
      'place, asks the traveller which they meant rather than guessing. Call this before ' +
      'planning an itinerary if the destination is ambiguous.',
    inputSchema: z.object({
      city: z.string().min(1).describe('The city name the traveller gave'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    reversible: true,
    timeout: 600_000,
    tags: ['travel', 'demo'],

    async run({ args, askUser }) {
      const key = String(args.city ?? '').trim().toLowerCase();
      const options = AMBIGUOUS[key];

      // Unambiguous, or nothing to ask with: answer and move on. A tool that
      // can work without interrupting should never interrupt.
      if (!options) return { city: args.city, resolved: args.city, ambiguous: false };
      if (typeof askUser !== 'function') {
        return { city: args.city, resolved: options[0].label, ambiguous: true, note: 'picked the most likely match; nobody was available to ask' };
      }

      const answer = await askUser({
        askedBy: 'tool',
        askedByDetail: 'choose-destination',
        questions: [{
          fieldId: 'destination',
          kind: 'pick_one_or_text',
          // Plain language: the traveller sees place names, never ids.
          prompt: `There is more than one ${args.city}. Which did you mean?`,
          options,
          allowOther: true,
          otherPrompt: 'Somewhere else — tell me where',
          required: true,
        }],
      });

      const chosen = answer.answers.destination;
      if (chosen && typeof chosen === 'object' && typeof chosen.other === 'string') {
        return { city: args.city, resolved: chosen.other, ambiguous: true, choseOther: true };
      }
      const match = options.find(o => o.value === chosen);
      return { city: args.city, resolved: match ? match.label : args.city, ambiguous: true };
    },
  },

  {
    name: 'trip-preferences',
    description:
      'Asks the traveller how they want the trip shaped — pace, what to build it around, daily ' +
      'budget, and anything they already have in mind. Call this once, early, before building an ' +
      'itinerary. Do not guess these.',
    inputSchema: z.object({
      destination: z.string().min(1).describe('Where the trip is to'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    reversible: true,
    timeout: 600_000,
    tags: ['travel', 'demo'],

    async run({ args, askUser }) {
      if (typeof askUser !== 'function') {
        // Sensible defaults rather than a failure. A tool that cannot ask
        // should still return something the run can use.
        return { pace: 'balanced', interests: ['food', 'history'], budget: 'mid', mustSee: null, asked: false };
      }

      // Four questions, **one interruption**. The unit that costs a person
      // their attention is being stopped, not being asked — so everything
      // needed is asked at once rather than trickled out over four pauses.
      const answer = await askUser({
        askedBy: 'tool',
        askedByDetail: 'trip-preferences',
        questions: [
          {
            fieldId: 'pace',
            kind: 'pick_one',
            prompt: `How full should the days be in ${args.destination}?`,
            options: [
              { value: 'relaxed', label: 'Relaxed — one thing a day, long lunches' },
              { value: 'balanced', label: 'Balanced — a couple of things, time to wander' },
              { value: 'packed', label: 'Packed — I want to see everything' },
            ],
            default: 'balanced',
            required: true,
          },
          {
            fieldId: 'interests',
            kind: 'pick_many',
            prompt: 'What should I build the trip around? Pick as many as you like.',
            options: [
              { value: 'food', label: 'Food and markets' },
              { value: 'history', label: 'History and architecture' },
              { value: 'nature', label: 'Nature and the outdoors' },
              { value: 'art', label: 'Art and museums' },
              { value: 'nightlife', label: 'Bars and nightlife' },
              { value: 'shopping', label: 'Shopping' },
            ],
            required: true,
          },
          {
            fieldId: 'budget',
            kind: 'pick_one_or_text',
            prompt: 'Roughly what are you happy to spend a day, not counting flights?',
            options: [
              { value: 'shoestring', label: 'Shoestring — hostels and street food' },
              { value: 'mid', label: 'Middle — decent hotels, eat out properly' },
              { value: 'premium', label: 'Premium — comfort matters more than cost' },
            ],
            allowOther: true,
            otherPrompt: 'Give me a number instead',
            required: true,
          },
          {
            fieldId: 'mustSee',
            kind: 'text',
            prompt: 'Anything you already know you want to do or avoid?',
            // Optional: an empty box is a real answer here, and forcing a
            // sentence out of someone with nothing to add is how a form
            // teaches people to type "n/a".
            required: false,
          },
        ],
      });

      const a = answer.answers;
      const budget = a.budget && typeof a.budget === 'object' ? a.budget.other : a.budget;
      return {
        destination: args.destination,
        pace: a.pace,
        interests: a.interests ?? [],
        budget,
        mustSee: a.mustSee ?? null,
        asked: true,
      };
    },
  },

  {
    name: 'confirm-itinerary',
    description:
      'Saves a finished itinerary for the traveller. Use once the plan is complete and the ' +
      'traveller is happy with it. This writes the plan somewhere they will see it.',
    inputSchema: z.object({
      destination: z.string().min(1),
      summary: z.string().min(1).describe('One or two sentences describing the trip'),
      estimatedCost: z.string().optional().describe('Total estimated cost, with its currency'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },

    // The whole point of this tool: it is the one thing in the demo that is
    // not read-only, so it is what the guardrail stops and asks about.
    reversible: false,
    timeout: 600_000,
    tags: ['travel', 'demo'],

    // What the traveller is actually asked, in their words rather than ours.
    approvalPrompt: (args) =>
      `Shall I save the ${args?.destination ?? 'trip'} itinerary?` +
      (args?.estimatedCost ? ` It comes to about ${args.estimatedCost}.` : ''),

    // Declared, so a correction later has something to take back. `mandatory`
    // is false: deleting a saved plan is the traveller's call, not ours.
    undo: {
      mandatory: false,
      describe: ({ result }) => `the ${result?.destination ?? 'trip'} itinerary I saved`,
      run: async ({ result }) => {
        saved.delete(result?.id);
        return { deleted: result?.id ?? null };
      },
    },

    async run({ args }) {
      const id = `itin-${Date.now().toString(36)}`;
      const record = { id, destination: args.destination, summary: args.summary, estimatedCost: args.estimatedCost ?? null, savedAt: new Date().toISOString() };
      saved.set(id, record);
      return record;
    },
  },
];
