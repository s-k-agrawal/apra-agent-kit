// comm/azure-functions/entities/conversation-entity.mjs
//
// Chat turns for one session, held in the task hub as an entity.
//
// One entity per session id. Unlike the checkpoint this does outlive a single
// run — which is the whole reason it cannot live in an orchestration's output.

import { scrub } from '../../../host/checkpoint/record.mjs';

const DEFAULT_MAX_TOTAL_TURNS = 20;
const DEFAULT_MAX_RECENT_TURNS = 6;

export const conversationOps = {
  /**
   * Add a turn, oldest evicted first.
   *
   * The cap is not a nicety. Entity state is read and rewritten whole on every
   * operation, so an uncapped conversation makes each append more expensive
   * than the last, and eventually exceeds what a single operation can carry.
   */
  append(state, turn, { maxTotalTurns = DEFAULT_MAX_TOTAL_TURNS } = {}) {
    const turns = [...(state?.turns ?? []), scrub(turn)];
    return { ...(state ?? {}), turns: turns.slice(-maxTotalTurns) };
  },

  /** The recent tail, which is what actually reaches a prompt. */
  forPrompt(state, { maxRecentTurns = DEFAULT_MAX_RECENT_TURNS } = {}) {
    return (state?.turns ?? []).slice(-maxRecentTurns);
  },

  all(state) {
    return state?.turns ?? [];
  },

  /** Replace the list wholesale. The entity holds the turns, not each turn. */
  replaceAll(state, { turns }) {
    return { ...(state ?? {}), turns: (turns ?? []).map(scrub) };
  },

  clear() {
    return null;
  },
};

const READ_OPS = new Set(['forPrompt', 'all']);

export function registerConversationEntity(df) {
  df.app.entity('conversation', (context) => {
    const op = context.df.operationName;
    const state = context.df.getState(() => null);
    const input = context.df.getInput();

    if (!Object.hasOwn(conversationOps, op)) {
      throw new Error(`conversation entity: unknown operation "${op}"`);
    }
    if (READ_OPS.has(op)) {
      context.df.return(conversationOps[op](state, input ?? {}));
      return;
    }
    if (op === 'append') {
      context.df.setState(conversationOps.append(state, input?.turn, input?.options ?? {}));
      return;
    }
    context.df.setState(conversationOps[op](state, input));
  });
}
