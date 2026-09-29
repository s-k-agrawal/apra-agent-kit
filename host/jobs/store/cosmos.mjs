// host/jobs/store/cosmos.mjs
//
// An optional third implementation of the unchanged `STORE_METHODS`.
//
// The two shipped stores cover the two shipped deployments: SQLite for one VM,
// the task hub for Azure Functions. Neither covers **several instances of the
// in-process backend behind a load balancer** — SQLite is one machine, and the
// task hub only exists on Durable Functions.
//
// This is a kit that gets cloned, and that gap is real for anyone running
// containers on something other than Functions. It also serves anyone who
// wants job history to outlive the task hub's purge.
//
// It is an adapter, not a dependency. `@azure/cosmos` is imported lazily, the
// default path never touches it, and removing this file would not change any
// shipped deployment.

import { IllegalTransitionError } from '../interface.mjs';
import { TERMINAL_STATUSES } from '../record.mjs';

const TERMINAL = [...TERMINAL_STATUSES];

async function loadSdk() {
  try {
    return await import('@azure/cosmos');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'dispatch.store.kind "cosmos" needs @azure/cosmos — install it, or choose another store kind',
      );
    }
    throw err;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.endpoint]   defaults to COSMOS_ENDPOINT
 * @param {string} [opts.key]        defaults to COSMOS_KEY
 * @param {string} [opts.database]   defaults to 'apra-agent-kit'
 * @param {string} [opts.container]  defaults to 'jobs'
 * @param {object} [opts.client]     a pre-built CosmosClient, for tests
 */
export function createCosmosStore({
  endpoint, key, database = 'apra-agent-kit', container = 'jobs',
  eventsContainer = 'job-events', client: injected = null, env = process.env,
} = {}) {
  let client = injected;
  let jobs = null;
  let events = null;

  const ensureOpen = () => {
    if (!jobs) throw new Error('cosmos store is not open');
  };

  // Records and events live in separate containers, both partitioned by job
  // id. Events in their own container because they are append-only and vastly
  // outnumber records; a single document per job would hit the 2MB item limit
  // on a long run.
  return {
    async open() {
      if (jobs) return;
      if (!client) {
        const { CosmosClient } = await loadSdk();
        const url = endpoint ?? env.COSMOS_ENDPOINT;
        const secret = key ?? env.COSMOS_KEY;
        if (!url || !secret) {
          throw new Error('cosmos store needs an endpoint and key (COSMOS_ENDPOINT / COSMOS_KEY)');
        }
        client = new CosmosClient({ endpoint: url, key: secret });
      }

      const { database: db } = await client.databases.createIfNotExists({ id: database });
      jobs = (await db.containers.createIfNotExists({
        id: container, partitionKey: { paths: ['/id'] },
      })).container;
      events = (await db.containers.createIfNotExists({
        id: eventsContainer, partitionKey: { paths: ['/jobId'] },
      })).container;
    },

    async close() {
      jobs = null;
      events = null;
    },

    async insert(record) {
      ensureOpen();
      try {
        await jobs.items.create({ ...record, _partition: record.id });
      } catch (err) {
        // 409 is Cosmos for "already there". The contract suite expects the
        // word "exists" in the message, same as the other two stores.
        if (err?.code === 409) throw new Error(`job ${record.id} already exists`);
        throw err;
      }
    },

    async get(id) {
      ensureOpen();
      try {
        const { resource } = await jobs.item(id, id).read();
        return resource ? strip(resource) : null;
      } catch (err) {
        if (err?.code === 404) return null;
        throw err;
      }
    },

    async update(id, patch) {
      ensureOpen();
      const current = await this.get(id);
      if (!current) throw new Error(`job ${id} not found`);
      const next = { ...current, ...patch };
      await jobs.item(id, id).replace({ ...next, _partition: id });
      return next;
    },

    /**
     * The one conditional write in the contract, and the reason the whole
     * design needs no other: only a `queued` row can be claimed, so two
     * workers cannot take the same job.
     *
     * Cosmos gives this via an ETag precondition rather than a WHERE clause.
     */
    async claim(id, startedAt) {
      ensureOpen();
      let resource;
      try {
        ({ resource } = await jobs.item(id, id).read());
      } catch (err) {
        if (err?.code === 404) return false;
        throw err;
      }
      if (!resource || resource.status !== 'queued') return false;

      try {
        await jobs.item(id, id).replace(
          { ...resource, status: 'processing', startedAt },
          { accessCondition: { type: 'IfMatch', condition: resource._etag } },
        );
        return true;
      } catch (err) {
        // 412 means somebody else changed the row between the read and the
        // write — which is exactly the race this method exists to lose safely.
        if (err?.code === 412) return false;
        throw err;
      }
    },

    async listByStatus(status) {
      ensureOpen();
      const { resources } = await jobs.items.query({
        query: 'SELECT * FROM c WHERE c.status = @s ORDER BY c.submittedAt ASC',
        parameters: [{ name: '@s', value: status }],
      }).fetchAll();
      return resources.map(strip);
    },

    async appendEvent(jobId, event) {
      ensureOpen();
      // Sequence numbers come from a count rather than a counter document.
      // Events for one job are in one partition and are written by one worker
      // at a time, so this is ordered without a second round trip.
      const { resources } = await events.items.query({
        query: 'SELECT VALUE MAX(c.seq) FROM c WHERE c.jobId = @j',
        parameters: [{ name: '@j', value: jobId }],
      }).fetchAll();
      const seq = (resources[0] ?? 0) + 1;
      await events.items.create({ ...event, jobId, seq, id: `${jobId}:${seq}` });
      return seq;
    },

    async events(jobId, { afterSeq = 0 } = {}) {
      ensureOpen();
      const { resources } = await events.items.query({
        query: 'SELECT * FROM c WHERE c.jobId = @j AND c.seq > @s ORDER BY c.seq ASC',
        parameters: [{ name: '@j', value: jobId }, { name: '@s', value: afterSeq }],
      }).fetchAll();
      return resources.map(strip);
    },

    async purgeFinishedBefore(isoTimestamp) {
      ensureOpen();
      const { resources } = await jobs.items.query({
        query: `SELECT c.id FROM c WHERE ARRAY_CONTAINS(@terminal, c.status) AND IS_DEFINED(c.finishedAt) AND c.finishedAt != null AND c.finishedAt < @t`,
        parameters: [{ name: '@terminal', value: TERMINAL }, { name: '@t', value: isoTimestamp }],
      }).fetchAll();

      for (const { id } of resources) {
        const { resources: rows } = await events.items.query({
          query: 'SELECT c.id FROM c WHERE c.jobId = @j',
          parameters: [{ name: '@j', value: id }],
        }).fetchAll();
        for (const row of rows) await events.item(row.id, id).delete();
        await jobs.item(id, id).delete();
      }
      return resources.length;
    },

    async countByStatus() {
      ensureOpen();
      const { resources } = await jobs.items.query({
        query: 'SELECT c.status, COUNT(1) AS n FROM c GROUP BY c.status',
      }).fetchAll();
      const out = {};
      for (const row of resources) out[row.status] = Number(row.n);
      return out;
    },
  };
}

// Cosmos adds `_rid`, `_self`, `_etag`, `_attachments`, `_ts` to every
// document. A caller comparing a record it wrote against one it read back must
// get the same object, so they come off on the way out.
function strip(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

export { IllegalTransitionError };
