import path from 'node:path';
import * as z from 'zod/v4';
import { toolsDir, shellEscape, parseToolOutput } from './registry-helpers.mjs';
import { runDemo } from '../workflows/demo/main.mjs';
import { runInspectMembers } from '../workflows/inspect-members/main.mjs';
import { runCityBriefing } from '../workflows/city-briefing/main.mjs';
import { runQuickWeather } from '../workflows/quick-weather/main.mjs';
import { runDestinationOverview } from '../workflows/destination-overview/main.mjs';
import { runTravelPrep } from '../workflows/travel-prep/main.mjs';
import { runRouteCheck } from '../workflows/route-check/main.mjs';
import { humanInputDemoTools } from './human-input-tools.mjs';

// Routable workflows. To expose a new tool, append an entry here — no changes to
// server.mjs or http.mjs are needed. `description` is read by the connected
// model when it decides which tool to call, so write it for that reader.
export const defaultRegistry = [
  {
    name: 'demo',
    description:
      'Runs the demo workflow end to end: fleet status, the dummy python command, ' +
      'the transform, and an agent smoke test. The leased doer runs the command and agent steps. ' +
      'Choose this to run the demo workflow or to verify that Fleet plumbing works. ' +
      'Spends LLM tokens and can take a minute.',
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ fleetApi, workspace, signal, reportPhase }) {
      const result = await runDemo({ fleetApi, workspace, signal, reportPhase });
      return `demo workflow completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'inspect-members',
    description:
      "Reports on the worker pair this call is running on: whether each role's member is " +
      'registered, and what is in its work folder. Choose this to check fleet health or to see ' +
      'what a worker has been doing. Read-only and spends no LLM tokens.',
    inputSchema: z.object({
      roles: z
        .array(z.enum(['doer', 'reviewer']))
        .optional()
        .describe('Roles to inspect on the leased worker. Defaults to both.'),
      includeFiles: z
        .boolean()
        .optional()
        .describe('Include a capped listing of top-level entries in each work folder.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      return await runInspectMembers({
        fleetApi,
        workspace,
        roles: args.roles,
        includeFiles: args.includeFiles,
        signal,
        reportPhase,
      });
    },
  },
  {
    name: 'city-briefing',
    description:
      'Fetches live weather, local time, and composes a short city briefing using an agent. ' +
      'Uses three internal tools (weather API, timezone API, text stats) and one agent prompt. ' +
      'Spends LLM tokens.',
    routing: {
      description: 'Weather + local time + short briefing for a city',
      args: { city: { extract: 'city name from the goal' } },
    },
    inputSchema: z.object({
      city: z
        .string()
        .optional()
        .describe('City name to brief on. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      const result = await runCityBriefing({
        fleetApi,
        workspace,
        city: args.city,
        signal,
        reportPhase,
      });
      return `city briefing completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'quick-weather',
    description:
      'Fetches current weather and 3-day forecast for a city. Uses weather and forecast tools plus one agent compose call.',
    routing: {
      description: 'Current weather + short forecast for a single city',
      args: { city: { extract: 'city name from the goal' } },
    },
    inputSchema: z.object({
      city: z.string().optional().describe('City name. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      const result = await runQuickWeather({ fleetApi, workspace, city: args.city, signal, reportPhase });
      return `quick weather completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'destination-overview',
    description:
      'Overview of a destination: background info + tourist attractions and activities. Uses wikipedia-summary and places-of-interest tools plus one agent compose call.',
    routing: {
      description: 'Overview of a destination: background info + tourist attractions and activities',
      args: { destination: { extract: 'destination/city/region name from the goal' } },
    },
    inputSchema: z.object({
      destination: z.string().optional().describe('Destination name. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      const result = await runDestinationOverview({ fleetApi, workspace, destination: args.destination, signal, reportPhase });
      return `destination overview completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'travel-prep',
    description:
      'Pre-trip preparation: country info + visa/advisory + currency + public holidays. Uses four tools plus one agent compose call.',
    routing: {
      description: 'Pre-trip preparation: country info + visa/advisory + currency + public holidays',
      args: { country: { extract: 'country name from the goal' } },
    },
    inputSchema: z.object({
      country: z.string().optional().describe('Country name. Defaults to Japan.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      const result = await runTravelPrep({ fleetApi, workspace, country: args.country, signal, reportPhase });
      return `travel prep completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'route-check',
    description:
      'Driving distance and travel time between two cities. Uses route-distance tool plus one agent compose call.',
    routing: {
      description: 'Driving distance and travel time between two cities',
      args: {
        from: { extract: 'origin city from the goal' },
        to: { extract: 'destination city from the goal' },
      },
    },
    inputSchema: z.object({
      from: z.string().optional().describe('Origin city. Defaults to Delhi.'),
      to: z.string().optional().describe('Destination city. Defaults to Manali.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: false },
    async run({ fleetApi, args, signal, reportPhase, workspace }) {
      const result = await runRouteCheck({ fleetApi, workspace, from: args.from, to: args.to, signal, reportPhase });
      return `route check completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'weather',
    description:
      'Fetches current weather for a city using the wttr.in API. Returns temperature, ' +
      'humidity, wind, UV index, and a text description. Read-only, no LLM tokens.',
    inputSchema: z.object({
      city: z
        .string()
        .optional()
        .describe('City name to look up. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const city = args.city || 'London';
      const script = path.join(toolsDir, 'weather', 'weather.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${city}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'timezone',
    description:
      'Fetches the current local time and timezone for a city using the World Time API. ' +
      'Returns datetime, UTC offset, and abbreviation. Read-only, no LLM tokens.',
    inputSchema: z.object({
      city: z
        .string()
        .optional()
        .describe('City name to look up. Defaults to London.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const city = args.city || 'London';
      const script = path.join(toolsDir, 'timezone', 'timezone.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${city}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'textstats',
    description:
      'Analyzes a text string and returns character count, word count, sentence count, ' +
      'unique words, and average word length. Read-only, no LLM tokens.',
    inputSchema: z.object({
      text: z
        .string()
        .describe('The text to analyze.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const escaped = args.text.replace(/"/g, '\\"').replace(/\n/g, ' ');
      const script = path.join(toolsDir, 'textstats', 'textstats.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${escaped}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'currency',
    description:
      'Converts between currencies using live exchange rates from the European Central Bank. ' +
      'Returns the rate and converted amount. Read-only, no LLM tokens.',
    inputSchema: z.object({
      from: z.string().optional().describe('Source currency code (e.g. USD). Defaults to USD.'),
      to: z.string().optional().describe('Target currency code (e.g. EUR). Defaults to EUR.'),
      amount: z.number().optional().describe('Amount to convert. Defaults to 1.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const from = shellEscape(args.from || 'USD');
      const to = shellEscape(args.to || 'EUR');
      const amount = args.amount ?? 1;
      const script = path.join(toolsDir, 'currency', 'currency.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${from}" "${to}" ${amount}`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'country-info',
    description:
      'Fetches country information from Wikipedia: name, description, and summary extract. ' +
      'Accepts full country names (e.g. Japan) or ISO alpha-2/3 codes (e.g. JP, IND). ' +
      'Read-only, no LLM tokens.',
    inputSchema: z.object({
      country: z.string().describe('Country name (e.g. Japan, France).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const country = shellEscape(args.country);
      const script = path.join(toolsDir, 'country-info', 'country_info.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${country}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'travel-advisory',
    description:
      'Fetches travel safety advisories for a country by ISO country code. ' +
      'Returns a safety score and advisory message. Read-only, no LLM tokens.',
    inputSchema: z.object({
      country: z.string().describe('ISO 3166-1 alpha-2 country code (e.g. JP, FR, US).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const country = shellEscape(args.country);
      const script = path.join(toolsDir, 'travel-advisory', 'travel_advisory.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${country}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'geocode',
    description:
      'Geocodes a city name to lat/lon coordinates, or reverse-geocodes coordinates to a location name. ' +
      'Uses OpenStreetMap Nominatim. Read-only, no LLM tokens. Rate limited to 1 request per second.',
    inputSchema: z.object({
      city: z.string().optional().describe('City name to geocode.'),
      lat: z.number().optional().describe('Latitude for reverse geocoding.'),
      lon: z.number().optional().describe('Longitude for reverse geocoding.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const script = path.join(toolsDir, 'geocode', 'geocode.py');
      let command;
      if (typeof args.lat === 'number' && typeof args.lon === 'number') {
        command = `python3 "${script}" ${args.lat} ${args.lon}`;
      } else {
        const city = shellEscape(args.city || 'London');
        command = `python3 "${script}" "${city}"`;
      }
      const raw = await fleetApi.executeCommand({ member_name: 'doer', command });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'forecast',
    description:
      'Fetches a multi-day weather forecast for a city. Returns daily high/low temperatures, ' +
      'precipitation, and weather codes. Read-only, no LLM tokens.',
    inputSchema: z.object({
      city: z.string().optional().describe('City name. Defaults to London.'),
      days: z.number().optional().describe('Number of forecast days (1-16). Defaults to 7.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const city = shellEscape(args.city || 'London');
      const days = args.days ?? 7;
      const script = path.join(toolsDir, 'forecast', 'forecast.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${city}" ${days}`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'wikipedia-summary',
    description:
      'Fetches a Wikipedia summary extract for any topic — cities, landmarks, people, concepts. ' +
      'Returns title, extract text, and description. Read-only, no LLM tokens.',
    inputSchema: z.object({
      topic: z.string().describe('The topic to look up (e.g. Tokyo, Eiffel Tower).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const topic = shellEscape(args.topic);
      const script = path.join(toolsDir, 'wikipedia-summary', 'wikipedia_summary.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${topic}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'places-of-interest',
    description:
      'Searches Wikipedia for tourist attractions, activities, and points of interest at a location. ' +
      'Returns titles and summary extracts for the top results. Read-only, no LLM tokens.',
    inputSchema: z.object({
      location: z.string().describe('Location to search for (e.g. Manali, Shimla, Himachal Pradesh).'),
      limit: z.number().optional().describe('Max results to return (1-20). Defaults to 8.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const location = shellEscape(args.location);
      const limit = args.limit ?? 8;
      const script = path.join(toolsDir, 'places-of-interest', 'places_of_interest.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${location}" ${limit}`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'route-distance',
    description:
      'Calculates driving distance and estimated travel time between two cities using ' +
      'OpenStreetMap routing. Returns distance in km, duration in hours, and a human-readable ' +
      'duration string. Read-only, no LLM tokens. Rate limited (1 req/sec for geocoding).',
    inputSchema: z.object({
      from: z.string().describe('Origin city name (e.g. Delhi, Shimla).'),
      to: z.string().describe('Destination city name (e.g. Manali, Dharamshala).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const from = shellEscape(args.from);
      const to = shellEscape(args.to);
      const script = path.join(toolsDir, 'route-distance', 'route_distance.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${from}" "${to}"`,
      });
      return parseToolOutput(raw);
    },
  },
  {
    name: 'public-holidays',
    description:
      'Fetches public holidays for a country and year. Returns holiday names, dates, and types. ' +
      'Read-only, no LLM tokens.',
    inputSchema: z.object({
      country: z.string().describe('ISO 3166-1 alpha-2 country code (e.g. JP, US, GB).'),
      year: z.number().optional().describe('Year to check. Defaults to current year.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args }) {
      const country = shellEscape(args.country);
      const yr = args.year ?? new Date().getFullYear();
      const script = path.join(toolsDir, 'public-holidays', 'public_holidays.py');
      const raw = await fleetApi.executeCommand({
        member_name: 'doer',
        command: `python3 "${script}" "${country}" ${yr}`,
      });
      return parseToolOutput(raw);
    },
  },
  // Demo tools for durable human input. Delete these when adopting the kit -
  // they exist so the travel agent has something to ask about, since every
  // other tool here is read-only.
  ...humanInputDemoTools,
];
