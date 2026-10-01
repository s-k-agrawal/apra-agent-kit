// host/memory/store/entity.mjs
//
// Long-term facts held in the Durable task hub, one entity per person.
//
// Why this exists: a default Azure deployment must need neither a Cosmos
// account nor a SQL server. The task hub is already provisioned for Durable, so
// putting state there costs an adopter nothing.
//
// What it costs us instead: an entity is read and written whole. `query` has to
// load every fact for that person and filter in memory, so `maxEntries` (500)
// is load-bearing here in a way it is not for sqlite. The filtering itself
// lives in `comm/azure-functions/entities/facts-entity.mjs` and is shared with
// the entity handler, so the two cannot drift.
//
// Reads go through the Durable client's `readEntityState`. Writes are
// fire-and-forget `signalEntity` **only** where losing one is survivable, and
// are read back where it is not — see `store` below.

import { factsOps } from '../../../comm/azure-functions/entities/facts-entity.mjs';

const ENTITY_NAME = 'facts';
const DEFAULT_PARTITION = 'global';

/**
 * @param {object} config
 * @param {() => object} config.getClient  returns a Durable client
 * @param {string} [config.partition]      entity key; one per person, or 'global'
 */
export function createEntityStore({ getClient, partition = DEFAULT_PARTITION, maxEntries = 500 } = {}) {
  if (typeof getClient !== 'function') {
    throw new Error('createEntityStore requires getClient — the Durable client is how entities are reached');
  }
  let df = null;
  let entityId = null;

  async function id() {
    if (!entityId) {
      df ??= await import('durable-functions');
      entityId = new df.EntityId(ENTITY_NAME, partition);
    }
    return entityId;
  }

  /** Whole entity state, or an empty one. */
  async function read() {
    const client = getClient();
    if (!client?.readEntityState) return { entries: [] };
    const res = await client.readEntityState(await id());
    return res?.entityExists ? (res.entityState ?? { entries: [] }) : { entries: [] };
  }

  async function signal(op, input) {
    const client = getClient();
    await client.signalEntity(await id(), op, input);
  }

  return {
    async open() { /* the entity is created by its first write */ },
    async close() { entityId = null; df = null; },

    /**
     * Refuses at the cap rather than throwing, matching the long-term tier,
     * which logs and skips.
     *
     * The cap has to be decided against *committed* state, so this reads
     * before it writes. A signal alone would let two concurrent stores both
     * believe there was room.
     */
    async store(entry) {
      const state = await read();
      const result = factsOps.store(state, entry, { maxEntries });
      if (!result.ok) return result;
      await signal('store', { entry, options: { maxEntries } });
      return { ok: true };
    },

    async get(entryId) {
      return factsOps.get(await read(), entryId);
    },

    async update(entryId, patch) {
      await signal('update', { id: entryId, patch });
    },

    async remove(entryId) {
      await signal('remove', entryId);
      return 1;
    },

    async query(filter = {}) {
      return factsOps.query(await read(), filter);
    },

    async purge(filter = {}) {
      const before = factsOps.count(await read(), {});
      await signal('purge', filter);
      const after = factsOps.count(await read(), {});
      return Math.max(0, before - after);
    },

    async count(filter = {}) {
      return factsOps.count(await read(), filter);
    },
  };
}
