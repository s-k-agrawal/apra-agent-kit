// comm/azure-functions/main.mjs
// Entry point loaded by the Azure Functions host (wwwroot package.json "main").
// Registers HTTP functions (via the adapter), the orchestrator, and the activity.
import { app } from '@azure/functions';
import * as df from 'durable-functions';
import { startHost } from '../../host/index.mjs';
import { createLogger } from '../../host/logger.mjs';
import { createAzureFunctionsAdapter, getHttpDurableClient, setLastDurableClient } from './http.mjs';
import { registerDurableFunctions } from './index.mjs';

const clientInput = df.input.durableClient();

const started = await startHost({
  logger: createLogger({ prefix: 'host', target: 'file', filePath: './logs/app.log' }),
  createAdapter: () => createAzureFunctionsAdapter({
    extraInputs: [clientInput],
    getClient: (context) => df.getClient(context),
  }),
  getDurableClient: getHttpDurableClient,
});

await registerDurableFunctions({
  pollMs: started.config.modules.dispatch?.durable?.pollMs ?? 2000,
  // 1 means one attempt and no retry. Worth raising where a workflow route
  // runs here: a workflow executes to completion inside a single activity with
  // no checkpoint between its phases, so a worker recycle loses all of it.
  activityRetry: started.config.modules.dispatch?.durable?.activityRetry ?? { maxAttempts: 1 },
  hostContextFactory: async () => ({
    api: started.fleetApi,
    activeDispatcher: started.dispatcher,
    toolRegistry: started.registry,
    runLoopConfig: started.runLoopConfig,
    routerConfig: started.routerConfig,
    budgetsConfig: started.budgetsConfig,
    guardrailsMod: started.guardrailsMod,
    notifier: started.notifier,
    jobs: started.jobs,
    memory: started.memory,
    logger: started.logger,
  }),
});

if (started.scheduler?.registerTimerFunctions) {
  started.scheduler.registerTimerFunctions(app, {
    extraInputs: [clientInput],
    getClient: (context) => df.getClient(context),
    setClient: setLastDurableClient,
  });
}

app.http('resetWorkers', {
  methods: ['POST'], route: 'reset-workers', authLevel: 'anonymous',
  handler: async () => {
    const freed = await started.dispatcher.resetWorkers();
    return { status: 200, jsonBody: { ok: true, freed, queued: started.dispatcher.queued } };
  },
});

app.hook.appTerminate(async () => { await started.close(); });
