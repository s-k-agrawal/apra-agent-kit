// host/config.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDispatchConfig, resolveNotifyConfigWithEnv } from './jobs/config.mjs';
import { resolveSchedulerConfig } from './scheduler/config.mjs';

const SUPPORTED_ADAPTERS = new Set(['express', 'raw-http', 'azure-functions']);
const KNOWN_MODULES = new Set(['runLoop', 'memory', 'budgets', 'guardrails', 'evals', 'dispatch', 'notify', 'chat', 'router', 'scheduler', 'humanInput']);
const IMPLEMENTED_MODULES = new Set(['runLoop', 'budgets', 'guardrails', 'dispatch', 'notify', 'chat', 'router', 'memory', 'evals', 'scheduler', 'humanInput']);

export async function loadConfig(configDir, env = process.env) {
  const raw = await resolveConfig(configDir);
  return validate(raw, env);
}

// modules.chat → { enabled, title, themes }. CHAT_ENABLED=true|false|1|0 wins over the file.
const VALID_THEMES = new Set(['apra', 'blue']);
export function resolveRouterConfig(raw = {}, { env = process.env } = {}) {
  const router = {
    enabled: !!raw?.enabled,
    fallbackStrategy: env.ROUTER_FALLBACK_STRATEGY ?? raw?.fallbackStrategy ?? 'open-ended',
  };
  const flag = String(env.ROUTER_ENABLED ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') router.enabled = true;
  else if (flag === '0' || flag === 'false') router.enabled = false;
  return router;
}

export function resolveChatConfig(raw = {}, { env = process.env, name = '' } = {}) {
  const chat = { enabled: !!raw?.enabled, title: raw?.title === undefined ? name : raw.title };
  const flag = String(env.CHAT_ENABLED ?? '').toLowerCase();
  if (flag === '1' || flag === 'true') chat.enabled = true;
  else if (flag === '0' || flag === 'false') chat.enabled = false;
  if (typeof chat.title !== 'string' || !chat.title.trim()) {
    throw new Error('chat.title must be a non-empty string');
  }
  const rawThemes = Array.isArray(raw?.themes) ? raw.themes.filter(t => VALID_THEMES.has(t)) : [];
  chat.themes = rawThemes.length > 0 ? rawThemes : ['apra'];
  return chat;
}

async function resolveConfig(dir) {
  const mjsPath = path.join(dir, 'host.config.mjs');
  try {
    const mod = await import(pathToFileURL(mjsPath).href);
    return mod.default;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' && !err.message?.includes('Cannot find module')) {
      throw err;
    }
  }

  const jsonPath = path.join(dir, 'host.config.json');
  try {
    const text = await fs.readFile(jsonPath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  throw new Error(`host.config.mjs (or .json) not found in ${dir}`);
}

function validate(raw, env) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config must be an object');
  }
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error('config.name is required (non-empty string)');
  }
  if (!raw.fleet || typeof raw.fleet !== 'object') {
    throw new Error('config.fleet is required (object)');
  }
  if (!raw.comm || typeof raw.comm !== 'object') {
    throw new Error('config.comm is required (object)');
  }
  if (!SUPPORTED_ADAPTERS.has(raw.comm.adapter)) {
    throw new Error(
      `unsupported comm adapter: "${raw.comm.adapter}" — supported: ${[...SUPPORTED_ADAPTERS].join(', ')}`,
    );
  }

  const port = raw.comm.port ?? Number(env.PORT ?? 3000);
  const host = raw.comm.host ?? env.MCP_BIND_HOST ?? '127.0.0.1';

  if (raw.modules && typeof raw.modules === 'object') {
    for (const key of Object.keys(raw.modules)) {
      if (!KNOWN_MODULES.has(key)) {
        console.warn(`[host/config] unknown module "${key}" — ignored`);
      } else if (raw.modules[key]?.enabled && !IMPLEMENTED_MODULES.has(key)) {
        console.warn(
          `[host/config] ${key} enabled but not implemented in this version — ignored`,
        );
      }
    }

    if (raw.modules?.budgets?.enabled && !raw.modules?.runLoop?.enabled) {
      console.warn(
        '[host/config] budgets enabled but runLoop disabled — budget enforcement will not run; disable budgets or enable runLoop',
      );
    }

    // A clone inherits these defaults silently. Say something when the
    // combination leaves irreversible tools ungated, because the failure mode
    // is an unwanted write rather than an error.
    const g = raw.modules?.guardrails;
    if (g?.enabled) {
      if ((g.defaultPolicy ?? 'allow') === 'allow' && !g.policies) {
        console.warn(
          '[host/config] guardrails enabled with defaultPolicy "allow" and no policies — only tools declaring reversible:false will be gated',
        );
      }
      if (g.freeze) {
        console.warn('[host/config] guardrails freeze is ON — every irreversible tool will be denied');
      }
      if (g.dryRunMode) {
        console.warn('[host/config] guardrails dryRunMode is ON — no tool will actually execute');
      }
    } else if (g && g.enabled === false) {
      console.warn(
        '[host/config] guardrails explicitly disabled — irreversible tools will execute without approval',
      );
    }
  }

  const modules = { ...(raw.modules ?? {}) };
  const runLoopEnabled = !!modules.runLoop?.enabled;

  const mem = raw.modules?.memory;
  if (mem) {
    if (mem.conversationContext?.enabled && !modules.chat?.enabled) {
      console.warn('[host/config] memory.conversationContext enabled but chat disabled — no conversation to track');
    }
    if ((mem.checkpoint ?? mem.runState)?.enabled && !runLoopEnabled) {
      console.warn('[host/config] memory.checkpoint enabled but runLoop disabled — no step sequence to checkpoint');
    }
    if (mem.longTerm?.autoLearn && !runLoopEnabled) {
      console.warn('[host/config] memory.longTerm.autoLearn enabled but runLoop disabled — needs a run to learn from');
    }
    if (mem.longTerm?.autoLearn && !mem.longTerm?.enabled) {
      console.warn('[host/config] memory.longTerm.autoLearn enabled but longTerm disabled — nowhere to store learned facts');
    }
  }

  const budgetsConfig = modules.budgets?.enabled ? modules.budgets : null;

  if (modules.dispatch?.enabled) {
    if (!runLoopEnabled) throw new Error('dispatch enabled but runLoop disabled — there is nothing to run; enable runLoop or disable dispatch');
    const dispatch = resolveDispatchConfig(modules.dispatch, { env, budgetsConfig });
    if (dispatch.backend === 'durable' && raw.comm.adapter !== 'azure-functions') {
      throw new Error('dispatch.backend "durable" requires comm.adapter "azure-functions"');
    }
    if (raw.comm.adapter === 'azure-functions' && dispatch.backend === 'in-process') {
      console.warn('[host/config] in-process jobs on azure-functions — jobs are lost when the instance recycles; use backend "durable"');
    }
    if (typeof budgetsConfig?.timeoutMs === 'number' && budgetsConfig.timeoutMs > dispatch.durable.maxActivityMs) {
      console.warn(`[host/config] budgets.timeoutMs ${budgetsConfig.timeoutMs} exceeds dispatch.durable.maxActivityMs ${dispatch.durable.maxActivityMs}; Durable does not enforce maxActivityMs — budgets.timeoutMs is the run-loop limit`);
    }
    if (dispatch.store.kind === 'memory' && env.NODE_ENV !== 'test') {
      console.warn('[host/config] dispatch.store.kind "memory" — jobs are lost on restart');
    }
    modules.dispatch = dispatch;
  }

  const router = resolveRouterConfig(modules.router, { env });
  if (router.enabled && !runLoopEnabled) {
    throw new Error('router enabled but runLoop disabled — the router needs the run loop as a fallback; enable runLoop or disable router');
  }
  if (router.enabled && !['open-ended', 'plan-execute'].includes(router.fallbackStrategy)) {
    throw new Error(`router.fallbackStrategy must be "open-ended" or "plan-execute", got "${router.fallbackStrategy}"`);
  }
  modules.router = Object.freeze(router);
  if (router.enabled) {
    console.warn('[host/config] router enabled — tasks will be classified before execution');
  }

  const schedulerConfig = resolveSchedulerConfig(modules.scheduler, { env, dispatchConfig: modules.dispatch });
  if (schedulerConfig.enabled) {
    if (!modules.dispatch?.enabled) {
      throw new Error('scheduler enabled but dispatch disabled — the scheduler submits jobs; enable dispatch or disable scheduler');
    }
    if (!Array.isArray(schedulerConfig.schedules) || schedulerConfig.schedules.length === 0) {
      console.warn('[host/config] scheduler enabled but no schedules configured');
    }
  }
  modules.scheduler = Object.freeze(schedulerConfig);

  const notify = resolveNotifyConfigWithEnv(modules.notify ?? {}, env);
  if (notify.webhook.allowHttp) console.warn('[host/config] notify.webhook.allowHttp is on — plain-http callback URLs are accepted');
  modules.notify = notify;

  const humanInput = resolveHumanInputConfig(modules.humanInput, { env });
  modules.humanInput = humanInput;
  // Refuses a configuration that cannot work, rather than warning and failing
  // at the first question days later.
  assertHumanInputDependencies(modules);

  const chat = resolveChatConfig(modules.chat, { env, name: raw.name });
  if (chat.enabled) {
    if (!modules.dispatch?.enabled) {
      throw new Error('chat enabled but dispatch disabled — the chat page streams job events; enable dispatch or disable chat');
    }
    if (!notify.sse.enabled) {
      throw new Error('chat enabled but notify.sse disabled — the chat page needs the SSE stream');
    }
  }
  modules.chat = chat;

  return Object.freeze({
    name: raw.name,
    description: raw.description ?? '',
    agentDescription: raw.agentDescription ?? '',
    fleet: Object.freeze({ ...raw.fleet }),
    comm: Object.freeze({
      adapter: raw.comm.adapter,
      port,
      host,
    }),
    modules: Object.freeze(modules),
  });
}

// Defaults for durable human input. Off unless asked for: a kit that started
// stopping runs to ask questions the moment it was cloned would be a surprise,
// and every one of these numbers is a policy decision an adopter should make
// deliberately.
export const HUMAN_INPUT_DEFAULTS = Object.freeze({
  enabled: false,
  maxInterruptions: 10,          // counted in interruptions, not questions
  staleAfterMs: 86_400_000,      // 24h - soft: warn on resume
  expiresAfterMs: 604_800_000,   // 7d  - hard: treated as refused
  sweepIntervalMs: 300_000,
});

export function resolveHumanInputConfig(raw, { env = {} } = {}) {
  const enabledEnv = env.HUMAN_INPUT_ENABLED;
  const enabled = enabledEnv === undefined
    ? !!(raw?.enabled ?? HUMAN_INPUT_DEFAULTS.enabled)
    : ['1', 'true', 'yes'].includes(String(enabledEnv).toLowerCase());

  const out = { ...HUMAN_INPUT_DEFAULTS, ...(raw ?? {}), enabled };

  // A limit of zero means every question is one too many, which is a run that
  // can never ask anything - almost certainly a typo for "off".
  if (!(Number.isInteger(out.maxInterruptions) && out.maxInterruptions > 0)) {
    throw new Error(`humanInput.maxInterruptions must be a positive integer (got ${out.maxInterruptions})`);
  }
  for (const key of ['staleAfterMs', 'expiresAfterMs', 'sweepIntervalMs']) {
    if (!(Number.isFinite(out[key]) && out[key] > 0)) {
      throw new Error(`humanInput.${key} must be a positive number of milliseconds (got ${out[key]})`);
    }
  }
  // A hard deadline inside the soft one means every question is expired before
  // it is ever merely stale, and the warning never fires.
  if (out.expiresAfterMs <= out.staleAfterMs) {
    throw new Error(
      `humanInput.expiresAfterMs (${out.expiresAfterMs}) must be greater than staleAfterMs (${out.staleAfterMs})`,
    );
  }

  return Object.freeze(out);
}

/**
 * A startup failure reason that is safe to put in an exception.
 *
 * A memory-store failure routinely carries a connection string, an endpoint,
 * a SAS token or a file path. That belongs in the operator's log — where it is
 * needed to diagnose — and never in an exception, which may be rendered to a
 * screen, posted to an error tracker, or returned over HTTP.
 *
 * The error's *name* survives, because "which kind of failure" is useful and
 * carries nothing. "Which host, which key, which path" is the part that does.
 */
export function describeStartupFailure(cause) {
  const kind = cause?.name && cause.name !== 'Error' ? ` (${cause.name})` : '';
  return `the memory store could not be opened${kind} — see the host log for the underlying cause`;
}

/**
 * Human input has no graceful degrade: a paused run needs somewhere to park
 * and somewhere to put a checkpoint.
 *
 * Called twice — once on the configuration, once after the memory module has
 * actually opened. The second is the sharper case, because the configuration
 * is correct and only the store is unreachable, so nobody is looking for a
 * mistake.
 *
 * @param {object} modules
 * @param {object} [opts]
 * @param {boolean} [opts.memoryStarted] false when memory is configured but failed to open
 */
export function assertHumanInputDependencies(modules, { memoryStarted = true, cause = null } = {}) {
  if (!modules?.humanInput?.enabled) return;

  if (!modules.dispatch?.enabled) {
    throw new Error(
      'humanInput requires dispatch — there is nowhere to park a paused run on the synchronous ' +
      '/task?wait=true path. Enable modules.dispatch or disable modules.humanInput.',
    );
  }

  if (!modules.memory || modules.memory.enabled === false) {
    throw new Error(
      'humanInput requires memory — a paused run stores its checkpoint in the memory store. ' +
      'Enable modules.memory or disable modules.humanInput.',
    );
  }

  // `memory.enabled` is not the same as a checkpoint store existing. With no
  // block the store resolves to null, the host starts happily, and every pause
  // then dies on a raw null-deref that surfaces on the job record. Same rule as
  // describeStartupFailure: name the setting, never quote its value.
  const cp = modules.memory.checkpoint ?? modules.memory.runState ?? null;
  if (!cp || cp.enabled === false) {
    throw new Error(
      'humanInput requires memory.checkpoint — a paused run stores its state there, and without ' +
      'it the failure would surface at the first question rather than here. Configure ' +
      'modules.memory.checkpoint (formerly memory.runState) or disable modules.humanInput.',
    );
  }

  if (!memoryStarted) {
    // Deliberately does not quote `cause`. See describeStartupFailure.
    throw new Error(
      `modules.humanInput is enabled but ${describeStartupFailure(cause)}. ` +
      'A paused run would have nowhere to store its checkpoint, and the failure would surface at ' +
      'the first question rather than here. Fix the memory store or disable modules.humanInput.',
    );
  }
}
