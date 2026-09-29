// deploy/demo-scripts/human-input-demo.mjs
//
// Runs the travel agent's chat page with durable human input, and **no Fleet
// and no LLM token**. For seeing the feature work before wiring up the real
// thing.
//
//   node deploy/demo-scripts/human-input-demo.mjs
//   → open http://127.0.0.1:3000/chat
//
// Try:
//   "plan me a trip to Paris"          → the tool asks which Paris (pick one, or Other)
//   "plan and save a Kerala trip"      → the guardrail asks before saving (approve / deny)
//   "plan and save a trip to Paris"    → both, one after the other
//
// The stand-in model below decides from what it has been told rather than from
// a call counter. That matters: a positional script hands the second run the
// reply meant for the first, and every prompt carries the whole tool catalogue
// and the run's history, so "what has happened so far" is genuinely readable
// from the prompt.
//
// Demo scaffolding. Delete it when adopting the kit.

import { startHost } from '../../host/index.mjs';
import { createMockFleetApi, rosterNames } from '../../tests/helpers/mock-fleet.mjs';

const call = (tool, args) => '```tool_call\n' + JSON.stringify({ tool, args }) + '\n```';
const done = (result, summary = 'Done') => '```done\n' + JSON.stringify({ result, summary }) + '\n```';

const ITINERARIES = {
  kerala: { destination: 'Kerala', summary: 'Seven days of backwaters, Fort Kochi and a night in Munnar', estimatedCost: 'INR 45,000' },
  paris: { destination: 'Paris', summary: 'Four days: Marais, Musee d\'Orsay and a day trip to Versailles', estimatedCost: 'EUR 900' },
};

// The prompt carries three things: the system prompt, the *whole tool
// catalogue*, and the run's history. Reading intent off all of it is a trap —
// the catalogue contains the word "save" because a tool is named that, so
// "does the user want this saved?" is only answerable from the Goal line.
const goalOf = (text) => (/^Goal:\s*(.+)$/m.exec(text)?.[1] ?? '');

// "a trip to Kerala" -> "Kerala". Good enough for a demo; a real model would
// not be doing this with a regex.
const destinationOf = (goal) => {
  const m = /\b(?:to|in|for)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)/.exec(goal)
    ?? /\b([A-Z][\w'-]{2,})\b/.exec(goal);
  return m?.[1]?.trim() ?? null;
};

// Turn the answers the person actually gave into a plan that visibly reflects
// them - otherwise a demo that asks four questions and ignores them teaches
// the wrong lesson about what the questions are for.
function summarise(text, where) {
  const pace = /"pace"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? 'balanced';
  const budget = /"budget"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? 'mid';
  const mustSee = /"mustSee"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  const interests = (/"interests"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '')
    .split(',').map(v => v.trim().replace(/"/g, '')).filter(Boolean);

  const days = pace === 'packed' ? 5 : pace === 'relaxed' ? 3 : 4;
  const lines = [
    `A **${pace}** ${days}-day trip to ${where}, at a **${budget}** budget.`,
    '',
  ];
  for (let d = 1; d <= days; d++) {
    const focus = interests.length ? interests[(d - 1) % interests.length] : 'the main sights';
    lines.push(`- **Day ${d}** — ${focus}${d === 1 ? ', after settling in' : ''}`);
  }
  if (mustSee) lines.push('', `You asked for: _${mustSee}_ — worked into day 2.`);
  return lines.join('\n');
}

function respond(prompt) {
  const text = String(prompt ?? '');

  // The router runs first and only wants a path.
  if (text.includes('task router')) return '{"path":"open-ended"}';

  const goal = goalOf(text);

  // --- what has already happened, read off the history ----------------------
  const resolved = /"resolved"\s*:\s*"([^"]+)"/.exec(text);
  const prefs = /"pace"\s*:\s*"([^"]+)"/.exec(text);
  const savedId = text.includes('"savedAt"');
  const refused = text.includes('approval_denied');
  const wantsSave = /\b(save|book|confirm)\b/i.test(goal);
  const wantsDetail = /\b(detailed|properly|full|itinerary|plan out|day.by.day)\b/i.test(goal);

  if (refused) {
    return done('I have not saved anything. Tell me what to change and I will redo the plan.', 'Declined');
  }

  if (savedId) {
    const where = resolved ? resolved[1] : (/kerala/i.test(goal) ? 'Kerala' : 'Your trip');
    return done(
      `## ${where}\n\nSaved. I have put the itinerary where you will find it later.\n\n` +
      '- Day 1 — arrive, settle in, evening walk\n' +
      '- Day 2 — the main sights, slowly\n' +
      '- Day 3 — a day trip out of the city\n\n' +
      '_Costs are estimates and nothing is booked._',
      'Itinerary saved',
    );
  }

  // Preferences in hand: build the plan, and save it if that was asked for.
  if (prefs) {
    const where = resolved ? resolved[1] : (destinationOf(goal) ?? 'your trip');
    if (wantsSave) {
      const key = /kerala/i.test(goal) ? 'kerala' : 'paris';
      return call('confirm-itinerary', { ...ITINERARIES[key], destination: where, summary: summarise(text, where) });
    }
    return done(`## ${where}\n\n${summarise(text, where)}\n\n_Nothing is booked and nothing is saved._`, 'Plan ready');
  }

  // Destination pinned down. Ask how to shape the trip before building it.
  if (resolved) {
    if (wantsDetail || wantsSave) return call('trip-preferences', { destination: resolved[1] });
    return done(
      `I have the destination pinned down: **${resolved[1]}**.\n\n` +
      'Ask me to plan it properly and I will check a few things with you first.',
      'Destination confirmed',
    );
  }

  // --- nothing has happened yet: pick the opening move ----------------------
  const ambiguous = /\b(paris|hyderabad|springfield)\b/i.exec(goal);
  if (ambiguous) return call('choose-destination', { city: ambiguous[1] });

  const where = destinationOf(goal);
  if (where && (wantsDetail || wantsSave)) return call('trip-preferences', { destination: where });

  if (wantsSave) {
    const key = /kerala/i.test(goal) ? 'kerala' : 'paris';
    return call('confirm-itinerary', ITINERARIES[key]);
  }

  return done(
    'Three things to try:\n\n' +
    '- **"plan me a trip to Paris"** — one question: which Paris did you mean?\n' +
    '- **"plan a detailed trip to Kerala"** — four questions in one form: pace, interests, budget, anything else.\n' +
    '- **"plan and save a detailed trip to Paris"** — all of it: which Paris, then the four, then approval before saving.\n\n' +
    'Every time, the run parks, releases its worker, and picks up again when you answer.',
    'Nothing to ask',
  );
}

const port = Number(process.env.PORT ?? 3000);

const { host, close } = await startHost({
  port,
  env: { ...process.env, NODE_ENV: 'test' },
  fleetApi: createMockFleetApi({ members: rosterNames(2), promptResponses: ({ prompt }) => respond(prompt) }),
  // The store is in memory so repeated demos start clean and leave no file behind.
  dispatch: { enabled: true, store: { kind: 'memory' }, concurrency: 2, maxQueueSize: 10 },
  humanInput: { enabled: true },
});

console.log(`\n  Travel agent with human input: http://127.0.0.1:${host.port()}/chat`);
console.log('  No Fleet, no LLM token, no network. Ctrl-C to stop.\n');
console.log('  Try:  plan me a trip to Paris');
console.log('        plan and save a Kerala trip');
console.log('        plan and save a trip to Paris\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void close().then(() => process.exit(0)); });
}
