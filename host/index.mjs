import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkerDispatcher } from '../pool/index.mjs';
import { buildMcpServer } from '../mcp/server.mjs';
import { authenticateRequest as defaultAuthenticate } from '../mcp/auth.mjs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createPooledFleetApi } from '../pool/pooled-fleet-api.mjs';
import { loadConfig, resolveChatConfig, resolveHumanInputConfig } from './config.mjs';
import { extendRegistry, withJobTools } from './tools/registry.mjs';
import { executeTool } from './tools/executor.mjs';
import { createExpressAdapter } from '../comm/express.mjs';
import { createRawHttpAdapter } from '../comm/raw-http.mjs';
import { createGuardrails } from './guardrails.mjs';
import { executeHostedTask, settleWhenAborted } from './tasks.mjs';
import { createJobsBackend } from './jobs/index.mjs';
import { resolveDispatchConfig, resolveNotifyConfigWithEnv } from './jobs/config.mjs';
import { createNotifier } from './notify/index.mjs';
import { buildRoutes } from './routes.mjs';
import { buildChatRoutes } from './chat/routes.mjs';
import { supportsHumanInput } from './jobs/interface.mjs';
import { createQuestionSweep } from './human-input/sweep.mjs';
import { createRetention, createArchiveStore } from './retention/index.mjs';
import { buildRetentionRoutes } from './retention/routes.mjs';
import { kitInfo } from './kit-info.mjs';

const SUPPORTED_ADAPTERS = {
  'express': () => createExpressAdapter(),
  'raw-http': () => createRawHttpAdapter(),
  'azure-functions': async () => (await import('../comm/azure-functions/http.mjs')).createAzureFunctionsAdapter(),
};

async function resolveAdapter(name) {
  const factory = SUPPORTED_ADAPTERS[name];
  if (!factory) throw new Error(`unsupported comm adapter: "${name}"`);
  try {
    return await factory();
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`comm adapter "${name}" is not available in this build`);
    }
    throw err;
  }
}

function defaultConfigDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveModules(config, { runLoop, budgets, guardrails, dispatch, notify, chat, humanInput } = {}) {
  return {
    runLoopConfig: runLoop ?? config.modules?.runLoop,
    budgetsConfig: budgets ?? config.modules?.budgets,
    guardrailsConfig: guardrails ?? config.modules?.guardrails,
    dispatchConfig: dispatch ?? config.modules?.dispatch,
    notifyConfig: notify ?? config.modules?.notify,
    chatOverride: chat ?? null,
    humanInputOverride: humanInput ?? null,
  };
}

function createPhase2Modules(toolRegistry, { runLoopConfig, budgetsConfig, guardrailsConfig }) {
  const runLoopEnabled = runLoopConfig?.enabled ?? !!runLoopConfig?.strategy;
  const budgetsEnabled = budgetsConfig && (budgetsConfig.enabled ?? true);
  const guardrailsEnabled = guardrailsConfig && (guardrailsConfig.enabled ?? true);
  const guardrailsMod = guardrailsEnabled ? createGuardrails(guardrailsConfig, toolRegistry, executeTool) : null;
  return { runLoopEnabled, runLoopConfig, budgetsConfig: budgetsEnabled ? budgetsConfig : null, guardrailsMod };
}

export async function startHost({
  fleetApi, dispatcher, port, bindHost: bindHostOption, adapter: adapterName, createAdapter,
  env = process.env, registry, configDir, authenticate = defaultAuthenticate,
  runLoop: runLoopOption, budgets: budgetsOption, guardrails: guardrailsOption,
  dispatch: dispatchOption, notify: notifyOption, chat: chatOption, humanInput: humanInputOption,
  durableClient = null, getDurableClient = null,
} = {}) {
  const config = await loadConfig(configDir ?? defaultConfigDir(), env);

  if (typeof authenticate === 'function' && authenticate.length >= 3) {
    throw new Error(
      'startHost({ authenticate }) expects authenticateRequest(request) => user | null, not Express middleware (req, res, next)',
    );
  }

  let api = fleetApi;
  let stopFleet = null;
  if (!api && env.FLEET_MOCK_SCRIPT) {
    if (env.NODE_ENV !== 'test') throw new Error('FLEET_MOCK_SCRIPT is only honoured when NODE_ENV=test');
    const { createScriptedFleetApi, loadScript } = await import('../tests/helpers/scripted-fleet.mjs');
    api = createScriptedFleetApi(await loadScript(env.FLEET_MOCK_SCRIPT));
    console.warn(`[host] using scripted fleet from ${env.FLEET_MOCK_SCRIPT} — no LLM calls will be made`);
  }
  if (!api) {
    const { ensureApralabs } = await import('../transport/ensure-apralabs.mjs');
    ensureApralabs();
    const { spawnFleet } = await import('../transport/stdio-fleet.mjs');
    const fleet = await spawnFleet({ env });
    api = fleet.fleetApi;
    stopFleet = fleet.stop;
  }

  let ownDispatcher = null;
  let activeDispatcher = dispatcher;
  if (!activeDispatcher) {
    try {
      activeDispatcher = ownDispatcher = await createWorkerDispatcher({ fleetApi: api, env });
    } catch (err) {
      try { await stopFleet?.(); } catch { /* preserve original error */ }
      throw err;
    }
  }

  const baseRegistry = registry ?? extendRegistry();
  const toolRegistry = [...baseRegistry];   // job tools appended below once jobs exists
  const resolved = resolveModules(config, {
    runLoop: runLoopOption, budgets: budgetsOption, guardrails: guardrailsOption, dispatch: dispatchOption, notify: notifyOption, chat: chatOption,
    humanInput: humanInputOption,
  });
  const phase2 = createPhase2Modules(toolRegistry, resolved);
  const { runLoopEnabled, budgetsConfig, guardrailsMod } = phase2;
  const runLoopConfig = {
    ...phase2.runLoopConfig,
    agentName: config.name,
    agentDescription: config.agentDescription ?? '',
  };
  const routerConfig = config.modules?.router ?? { enabled: false };

  // Phase 4 modules. Builder overrides arrive raw, config-file values arrive resolved; resolve again idempotently.
  const dispatchEnabled = runLoopEnabled && !!(resolved.dispatchConfig?.enabled ?? (dispatchOption ? true : false));
  const dispatchConfig = dispatchEnabled ? resolveDispatchConfig({ ...resolved.dispatchConfig, enabled: true }, { env, budgetsConfig }) : null;
  const notifyConfig = resolveNotifyConfigWithEnv(resolved.notifyConfig ?? {}, env);

  // Chat rides on the async job routes and the SSE stream. When the flag comes
  // from the file, loadConfig already validated it against the file's dispatch
  // and notify blocks; builder overrides can change both, so check the resolved
  // values here and unwind exactly like a jobs-backend failure would.
  const chatConfig = resolved.chatOverride
    ? resolveChatConfig({ enabled: true, ...resolved.chatOverride }, { env, name: config.name })
    : config.modules.chat;
  const chatProblem = !chatConfig.enabled ? null
    : !dispatchEnabled ? 'chat enabled but dispatch disabled — the chat page streams job events; enable dispatch or disable chat'
    : !notifyConfig.sse.enabled ? 'chat enabled but notify.sse disabled — the chat page needs the SSE stream'
    : null;
  if (chatProblem) {
    try { await ownDispatcher?.close(); } catch { /* preserve original error */ }
    try { await stopFleet?.(); } catch { /* preserve original error */ }
    throw new Error(chatProblem);
  }

  // Human input needs somewhere to park a run, so it only engages alongside
  // dispatch. config.mjs has already warned if the combination is wrong.
  const humanInputConfig = dispatchEnabled
    ? (resolved.humanInputOverride
        ? resolveHumanInputConfig({ ...config.modules.humanInput, enabled: true, ...resolved.humanInputOverride })
        : (config.modules.humanInput ?? null))
    : null;
  let questionSweep = null;
  let retention = null;

  let jobs = null;
  const runSync = (task, { signal } = {}) => executeHostedTask(task, {
    api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig, budgetsConfig, guardrailsMod, jobs, signal,
  });
  // The run loop only observes abort between iterations. A job blocked in
  // executePrompt would otherwise stay `processing` until FORCE_SETTLE (30s).
  const runJob = (task, { signal, onProgress, askUser, resumeFrom }) => settleWhenAborted(
    executeHostedTask(task, {
      api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig, budgetsConfig, guardrailsMod, jobs, signal, onProgress,
      askUser, resumeFrom,
    }),
    signal,
  );

  let notifier = null;
  if (dispatchEnabled) {
    try {
      // Notifier and jobs reference each other: SSE reads from jobs, jobs publish to notifier.
      const late = { jobs: null };
      notifier = createNotifier(notifyConfig, {
        jobs: { get: (id) => late.jobs.get(id), events: (id, o) => late.jobs.events(id, o), subscribe: (id, fn) => late.jobs.subscribe(id, fn) },
      });
      jobs = await createJobsBackend(dispatchConfig, {
        runJob, notifier, capacity: activeDispatcher.capacity,
        allowHttpCallbacks: notifyConfig.webhook.allowHttp, durableClient, getDurableClient,
        humanInput: humanInputConfig, kitVersion: (await kitInfo()).version,
      });
      late.jobs = jobs;
      await jobs.start();

      // The sweep enforces the two deadlines on a question. It only runs when
      // the feature is on and the backend can act on what it finds.
      if (humanInputConfig?.enabled && supportsHumanInput(jobs)) {
        questionSweep = createQuestionSweep({
          listWaiting: () => jobs.listWaiting(),
          expireInput: (id) => jobs.expireInput(id),
          markStale: (id) => jobs.markInputStale(id),
          intervalMs: humanInputConfig.sweepIntervalMs,
        });
        questionSweep.start();
      }

      // Record retention. Separate from the question sweep on purpose: one
      // clears settled records after 30 days, the other expires unanswered
      // questions after 7. Different clocks, different consequences.
      if (dispatchConfig.retention && typeof jobs.purgeFinishedBefore !== 'function') {
        const archiveStore = await createArchiveStore(dispatchConfig.retention.archive, { backend: dispatchConfig.backend });
        if (archiveStore) await archiveStore.open();
        retention = createRetention({
          config: dispatchConfig.retention,
          store: jobs.store ?? null,
          archiveStore,
          clear: (id) => jobs.clearRecord?.(id),
          listAll: () => jobs.listAllRecords?.() ?? [],
        });
        if (typeof jobs.listAllRecords === 'function') retention.start();
        else retention = null;   // a backend that cannot list its records cannot be swept
      }
      toolRegistry.push(...withJobTools([], jobs));
    } catch (err) {
      try { questionSweep?.stop(); retention?.stop(); } catch { /* preserve original error */ }
      try { await jobs?.stop({ drainMs: 0 }); } catch { /* preserve original error */ }
      try { await ownDispatcher?.close(); } catch { /* preserve original error */ }
      try { await stopFleet?.(); } catch { /* preserve original error */ }
      throw err;
    }
  }

  const mcpExecute = guardrailsMod
    ? (tool, executorArgs) => guardrailsMod.execute(tool, executorArgs)
    : (tool, executorArgs) => executeTool(tool, executorArgs);

  const mcpServerFactory = () => buildMcpServer({ fleetApi: api, dispatcher: activeDispatcher, registry: toolRegistry, execute: mcpExecute, jobs });

  const mcpRaw = async (req, res) => {
    const server = mcpServerFactory();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  };

  const chatRoutes = await buildChatRoutes({ chatConfig, hostName: config.name });
  const routes = {
    ...buildRoutes({ jobs, notifier, runSync, mcpRaw, mcpWeb: null, runLoopEnabled, chatRoutes, guardrails: guardrailsMod }),
    // Mounted only when retention.expiry.mode is 'manual' or 'both'. Under
    // 'auto' the timer owns it, and a second trigger would race it.
    ...buildRetentionRoutes({ retention }),
  };

  let adapter;
  const listenPort = port ?? config.comm.port;
  const bindHost = bindHostOption ?? config.comm.host;

  try {
    adapter = createAdapter ? createAdapter() : await resolveAdapter(adapterName ?? config.comm.adapter);
    await adapter.start({ routes, port: listenPort, host: bindHost, authenticate, mcpServerFactory });
  } catch (err) {
    try { await adapter?.stop(); } catch { /* preserve */ }
    try { questionSweep?.stop(); retention?.stop(); } catch { /* preserve */ }
    try { await jobs?.stop({ drainMs: 0 }); } catch { /* preserve */ }
    try { await ownDispatcher?.close(); } catch { /* preserve */ }
    try { await stopFleet?.(); } catch { /* preserve */ }
    throw err;
  }

  console.log(
    `host '${config.name}' listening on http://${bindHost}:${adapter.port() ?? '(platform)'} ` +
    `(worker capacity ${activeDispatcher.capacity}${jobs ? `, jobs backend ${dispatchConfig.backend}` : ''}` +
    `${chatConfig.enabled ? ', chat at /chat' : ''})`,
  );

  async function callTool(name, args = {}, { signal } = {}) {
    const tool = toolRegistry.find(t => t.name === name);
    if (!tool) return { ok: false, error: 'not_found', message: `tool "${name}" not found` };
    let lease;
    try {
      lease = await activeDispatcher.dispatch({ signal });
    } catch (err) {
      return { ok: false, error: 'dispatch_failed', message: String(err?.message ?? err) };
    }
    try {
      const executorArgs = {
        fleetApi: createPooledFleetApi(api, lease), args, signal: lease.signal ?? signal,
        reportPhase: () => {}, workspace: { workerId: lease.workerId, doer: lease.doer, reviewer: lease.reviewer }, jobs,
      };
      return guardrailsMod ? await guardrailsMod.execute(tool, executorArgs) : await executeTool(tool, executorArgs);
    } finally {
      await lease.release();
    }
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    activeDispatcher.beginShutdown();
    await adapter.stop();
    questionSweep?.stop();
    retention?.stop();
    await jobs?.stop({ drainMs: dispatchConfig?.drainMs });
    await notifier?.stop();
    await ownDispatcher?.close();
    await stopFleet?.();
  };

  const effectiveConfig = Object.freeze({ ...config, modules: Object.freeze({ ...config.modules, chat: chatConfig }) });
  return {
    host: adapter, jobs, notifier, callTool, close, stop: close, config: effectiveConfig, registry: toolRegistry,
    fleetApi: api, dispatcher: activeDispatcher, guardrailsMod, runLoopConfig, budgetsConfig, routerConfig,
  };
}

export function createHost(options = {}) {
  const overrides = { ...options };
  const builder = {
    tools(registry)    { overrides.registry = registry; return builder; },
    comm(commConfig)   {
      if (commConfig && typeof commConfig === 'object') {
        if ('port' in commConfig) overrides.port = commConfig.port;
        if ('host' in commConfig) overrides.bindHost = commConfig.host;
        if ('adapter' in commConfig) overrides.adapter = commConfig.adapter;
      }
      return builder;
    },
    runLoop(config)    { overrides.runLoop = { enabled: true, ...config }; return builder; },
    budget(config)     { overrides.budgets = config; return builder; },
    guardrails(config) { overrides.guardrails = config; return builder; },
    dispatch(config)   { overrides.dispatch = { enabled: true, ...config }; return builder; },
    notify(config)     { overrides.notify = config; return builder; },
    chat(config)       { overrides.chat = { enabled: true, ...(config ?? {}) }; return builder; },
    build() {
      const hostOptions = overrides;
      return {
        start: (startOpts = {}) => startHost({ ...hostOptions, ...startOpts }),
        run: async (task, runOpts = {}) => {
          const config = await loadConfig(hostOptions.configDir ?? defaultConfigDir(), hostOptions.env ?? process.env);
          const toolRegistry = hostOptions.registry ?? extendRegistry();
          const { runLoopEnabled, runLoopConfig, budgetsConfig, guardrailsMod } =
            createPhase2Modules(toolRegistry, resolveModules(config, hostOptions));
          if (!runLoopEnabled) throw new Error('run loop is not enabled');
          const api = hostOptions.fleetApi;
          const activeDispatcher = hostOptions.dispatcher;
          if (!api || !activeDispatcher) throw new Error('fleetApi and dispatcher are required for agent.run()');
          const routerConfig = config.modules?.router ?? { enabled: false };
          return executeHostedTask(task, {
            api, activeDispatcher, toolRegistry, runLoopConfig, routerConfig, budgetsConfig, guardrailsMod, signal: runOpts.signal,
          });
        },
      };
    },
  };
  return builder;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startHost();
    const shutdown = async () => { await close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
