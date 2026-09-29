import { assertJobsBackend } from './interface.mjs';
import { createInProcessJobs } from './in-process.mjs';
import { createMemoryStore } from './store/memory.mjs';
import { createSqliteStore } from './store/sqlite.mjs';

export async function createJobsBackend(dispatchConfig, {
  runJob, notifier = null, logger = console, capacity = 1, allowHttpCallbacks = false, durableClient = null, getDurableClient = null,
  humanInput = null, kitVersion = null,
}) {
  if (dispatchConfig.backend === 'durable') {
    try {
      const { createDurableJobs } = await import('./durable.mjs');
      const getClient = typeof getDurableClient === 'function'
        ? getDurableClient
        : (typeof durableClient === 'function' ? durableClient : undefined);
      const client = typeof durableClient === 'function' ? undefined : durableClient;
      return assertJobsBackend(createDurableJobs({ client, getClient, config: dispatchConfig, notifier, logger, allowHttpCallbacks }));
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('jobs backend "durable" is not available in this build');
      }
      throw err;
    }
  }
  const store = dispatchConfig.store.kind === 'memory'
    ? createMemoryStore()
    : createSqliteStore({ dbPath: dispatchConfig.store.dbPath });
  return assertJobsBackend(createInProcessJobs({
    store, runJob, notifier, logger, allowHttpCallbacks, humanInput, kitVersion,
    config: { ...dispatchConfig, capacity },
  }));
}
