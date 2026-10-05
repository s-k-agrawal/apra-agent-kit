// host/memory/conversation-store/entity.mjs
//
// Chat turns held in the Durable task hub, one entity per session.
//
// Same reasoning as the facts store: the task hub is already there, so a
// default Azure deployment needs no Cosmos account and no SQL server. The turn
// handling is shared with the entity handler in
// `comm/azure-functions/entities/conversation-entity.mjs` so the two cannot
// drift.
//
// A conversation is capped. Entity state is read and rewritten whole on every
// operation, so an uncapped history makes each append dearer than the last.

import { conversationOps } from '../../../comm/azure-functions/entities/conversation-entity.mjs';

const ENTITY_NAME = 'conversation';

export function createConversationEntityStore({ getClient, maxTotalTurns = 20 } = {}) {
  if (typeof getClient !== 'function') {
    throw new Error('createConversationEntityStore requires getClient — the Durable client is how entities are reached');
  }
  let df = null;

  async function id(sessionId) {
    df ??= await import('durable-functions');
    return new df.EntityId(ENTITY_NAME, sessionId);
  }

  async function read(sessionId) {
    const client = getClient();
    if (!client?.readEntityState) return null;
    const res = await client.readEntityState(await id(sessionId));
    return res?.entityExists ? (res.entityState ?? null) : null;
  }

  return {
    async open() { /* the entity is created by its first write */ },
    async close() { df = null; },

    async append(sessionId, turn) {
      const client = getClient();
      await client.signalEntity(await id(sessionId), 'append', {
        turn,
        options: { maxTotalTurns },
      });
      return turn;
    },

    async get(sessionId, turnId) {
      const turns = conversationOps.all(await read(sessionId));
      return turns.find(t => t.id === turnId) ?? null;
    },

    async update(sessionId, turnId, patch) {
      const state = await read(sessionId);
      const turns = conversationOps.all(state).map(t => (t.id === turnId ? { ...t, ...patch } : t));
      const client = getClient();
      // No per-turn operation: the entity holds the list, so a replace is the
      // honest way to change one of them.
      await client.signalEntity(await id(sessionId), 'replaceAll', { turns });
      return turns.find(t => t.id === turnId) ?? null;
    },

    async listSession(sessionId, { limit } = {}) {
      const turns = conversationOps.all(await read(sessionId));
      return limit ? turns.slice(-limit) : turns;
    },

    /**
     * One entity per session, so purging is per session id. There is no
     * cross-entity query in the task hub — the caller supplies the ids, and
     * `host/jobs/entity-retention.mjs` is what knows which are stale.
     */
    async purgeSessions({ sessionIds = [] } = {}) {
      const client = getClient();
      let purged = 0;
      for (const sessionId of sessionIds) {
        await client.signalEntity(await id(sessionId), 'clear');
        purged += 1;
      }
      return purged;
    },
  };
}
