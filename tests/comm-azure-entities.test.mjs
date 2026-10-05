// tests/comm-azure-entities.test.mjs
//
// The state operations behind the three Durable Entities.
//
// These are pure `(state, input) => state` functions on purpose. The Durable
// wrapper around them is three lines; everything worth getting wrong is here,
// where it can be tested without a task hub, a client, or Azurite.
//
// They exist because `callEntity` returns a Task that must be `yield`ed, so it
// is reachable only from the orchestrator generator — which cannot `await` a
// promise, and therefore cannot use the promise-based memory store interface.
// See docs/specs/2026-09-30-azure-durable-entity-storage-spec.md §9.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkpointOps } = await import('../comm/azure-functions/entities/checkpoint-entity.mjs');
const { conversationOps } = await import('../comm/azure-functions/entities/conversation-entity.mjs');
const { factsOps } = await import('../comm/azure-functions/entities/facts-entity.mjs');
const { stepIdempotencyKey } = await import('../host/checkpoint/record.mjs');

const base = (over = {}) => ({ jobId: 'job-1', task: { id: 'job-1', goal: 'g' }, ...over });

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

test('checkpoint: save merges rather than replacing', () => {
  // The orchestrator commits a step's delta and knows nothing of the
  // idempotency keys that step produced. A replacing save would erase them and
  // the resumed run would redo an irreversible step. Same rule as the store.
  let s = checkpointOps.save(null, base({ observations: [{ n: 1 }], idempotencyKeys: ['a'] }));
  s = checkpointOps.save(s, base({ pendingBatchId: 'inp-1' }));
  assert.deepEqual(s.idempotencyKeys, ['a'], 'keys the writer did not mention survive');
  assert.deepEqual(s.observations, [{ n: 1 }]);
  assert.equal(s.pendingBatchId, 'inp-1');
});

test('checkpoint: a field the writer does mention still wins', () => {
  let s = checkpointOps.save(null, base({ pendingBatchId: 'inp-1', idempotencyKeys: ['a'] }));
  s = checkpointOps.save(s, base({ pendingBatchId: null, idempotencyKeys: ['a', 'b'] }));
  assert.equal(s.pendingBatchId, null, 'an explicit null clears it, so settling can');
  assert.deepEqual(s.idempotencyKeys, ['a', 'b']);
});

test('checkpoint: a credential never reaches entity state', () => {
  const s = checkpointOps.save(null, base({
    plan: { steps: [{ type: 'tool', tool: 'fetch', args: { client_secret: 'LEAK', url: 'u' } }], cursor: 0 },
    conversation: [{ role: 'user', text: 'ok', authorization: 'Bearer LEAK2' }],
  }));
  const json = JSON.stringify(s);
  assert.equal(json.includes('LEAK'), false, 'entity state is scrubbed like every other record');
});

test('checkpoint: the idempotency key is recorded with the observation, not after', () => {
  // A crash between the step activity returning and callEntity committing is
  // safe only if the key lands in the same operation that records the work.
  const s = checkpointOps.save(null, base({
    observations: [{ stepIndex: 0, result: { ok: true } }],
    idempotencyKeys: [stepIdempotencyKey({ tool: 'book', args: { x: 1 } }, 0)],
  }));
  assert.equal(s.observations.length, 1);
  assert.equal(s.idempotencyKeys.length, 1);
  assert.equal(checkpointOps.hasIdempotencyKey(s, stepIdempotencyKey({ tool: 'book', args: { x: 1 } }, 0)), true);
});

test('checkpoint: addIdempotencyKey is idempotent itself', () => {
  let s = checkpointOps.save(null, base({ idempotencyKeys: [] }));
  s = checkpointOps.addIdempotencyKey(s, 'k');
  s = checkpointOps.addIdempotencyKey(s, 'k');
  assert.deepEqual(s.idempotencyKeys, ['k'], 'a replayed commit does not duplicate');
});

test('checkpoint: clear empties it, and get on nothing is null not a throw', () => {
  const s = checkpointOps.save(null, base());
  assert.equal(checkpointOps.clear(s), null);
  assert.equal(checkpointOps.get(null), null);
  assert.equal(checkpointOps.hasIdempotencyKey(null, 'k'), false);
});

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

test('conversation: append keeps order and forPrompt returns the recent tail', () => {
  let s = null;
  for (let i = 0; i < 10; i += 1) s = conversationOps.append(s, { role: 'turn', goal: `q${i}`, answer: `a${i}` });
  const recent = conversationOps.forPrompt(s, { maxRecentTurns: 3 });
  assert.equal(recent.length, 3);
  assert.equal(recent.at(-1).goal, 'q9', 'the tail, not the head');
});

test('conversation: it is capped, so entity state cannot grow without bound', () => {
  // Entity state is read and rewritten whole on every operation. An uncapped
  // conversation makes every append more expensive than the last.
  let s = null;
  for (let i = 0; i < 100; i += 1) s = conversationOps.append(s, { role: 'turn', goal: `q${i}` }, { maxTotalTurns: 20 });
  assert.equal(s.turns.length, 20);
  assert.equal(s.turns.at(-1).goal, 'q99', 'the newest are the ones kept');
});

test('conversation: a credential in a turn is scrubbed', () => {
  const s = conversationOps.append(null, { role: 'turn', goal: 'hi', 'x-api-key': 'LEAK' });
  assert.equal(JSON.stringify(s).includes('LEAK'), false);
});

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------

const fact = (over = {}) => ({
  id: 'mem-1', kind: 'domain', text: 'a fact', tags: ['x'], state: 'active',
  retrievalStrength: 0.5, createdAt: '2026-09-01T00:00:00.000Z', ...over,
});

test('facts: query filters by kind, state and tag, and sorts by retrieval strength', () => {
  // Must match host/memory/store/sqlite.mjs query() exactly, or recall differs
  // between deployments and nobody notices until a run reasons differently.
  let s = null;
  s = factsOps.store(s, fact({ id: 'a', kind: 'domain', tags: ['trip'], retrievalStrength: 0.2 })).state;
  s = factsOps.store(s, fact({ id: 'b', kind: 'domain', tags: ['trip'], retrievalStrength: 0.9 })).state;
  s = factsOps.store(s, fact({ id: 'c', kind: 'preference', tags: ['other'] })).state;
  s = factsOps.store(s, fact({ id: 'd', kind: 'domain', tags: ['trip'], state: 'dormant' })).state;

  const out = factsOps.query(s, { kinds: ['domain'], states: ['active'], tags: ['trip'] });
  assert.deepEqual(out.map(e => e.id), ['b', 'a'], 'strongest first, dormant and wrong-kind excluded');
});

test('facts: a tag match is any-of, not all-of', () => {
  let s = factsOps.store(null, fact({ id: 'a', tags: ['trip', 'japan'] })).state;
  assert.equal(factsOps.query(s, { tags: ['japan', 'unrelated'] }).length, 1);
});

test('facts: limit is applied after sorting, not before', () => {
  let s = null;
  s = factsOps.store(s, fact({ id: 'weak', retrievalStrength: 0.1 })).state;
  s = factsOps.store(s, fact({ id: 'strong', retrievalStrength: 0.9 })).state;
  assert.deepEqual(factsOps.query(s, { limit: 1 }).map(e => e.id), ['strong']);
});

test('facts: maxEntries is refused, not thrown', () => {
  // The long-term tier logs and skips at the cap; an entity that threw would
  // fail the orchestration instead.
  let s = factsOps.store(null, fact({ id: 'a' })).state;
  const r = factsOps.store(s, fact({ id: 'b' }), { maxEntries: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'at_cap');
  assert.equal(r.state.entries.length, 1, 'and the store is unchanged');
});

test('facts: storing the same id updates rather than duplicating', () => {
  let s = factsOps.store(null, fact({ id: 'a', text: 'first' })).state;
  s = factsOps.store(s, fact({ id: 'a', text: 'second' })).state;
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].text, 'second');
});

test('facts: purge removes by state and age, and reports how many', () => {
  let s = null;
  s = factsOps.store(s, fact({ id: 'old', state: 'silent', createdAt: '2026-01-01T00:00:00.000Z' })).state;
  s = factsOps.store(s, fact({ id: 'new', state: 'silent', createdAt: '2026-09-29T00:00:00.000Z' })).state;
  const r = factsOps.purge(s, { states: ['silent'], olderThan: '2026-06-01T00:00:00.000Z' });
  assert.equal(r.removed, 1);
  assert.deepEqual(r.state.entries.map(e => e.id), ['new']);
});

test('facts: purge with no predicate removes nothing', () => {
  // Matches the sqlite store, which returns 0 rather than deleting everything.
  const s = factsOps.store(null, fact({ id: 'a' })).state;
  assert.equal(factsOps.purge(s, {}).removed, 0);
});

test('facts: count respects kind and state', () => {
  let s = null;
  s = factsOps.store(s, fact({ id: 'a', kind: 'domain', state: 'active' })).state;
  s = factsOps.store(s, fact({ id: 'b', kind: 'preference', state: 'active' })).state;
  assert.equal(factsOps.count(s, {}), 2);
  assert.equal(factsOps.count(s, { kinds: ['domain'] }), 1);
});

test('facts: a credential in a fact is scrubbed', () => {
  const r = factsOps.store(null, fact({ id: 'a', text: 'ok', connectionString: 'Server=x;Password=LEAK' }));
  assert.equal(JSON.stringify(r.state).includes('LEAK'), false);
});

test('facts: remove and get behave on an empty store', () => {
  assert.deepEqual(factsOps.query(null, {}), []);
  assert.equal(factsOps.count(null, {}), 0);
  assert.equal(factsOps.remove(null, 'nope').removed, 0);
});

// ---------------------------------------------------------------------------
// The orchestrator as the run loop
//
// Task 3. The orchestrator stops being a one-shot dispatcher: it calls
// `advance` repeatedly and commits each delta with `callEntity` before going
// round again. The determinism rules in the spec §5.3 apply to every line of
// it — the previous multi-yield loop produced 125 activities from one request.
// ---------------------------------------------------------------------------

const { buildOrchestrator, ADVANCE_NAME } = await import('../comm/azure-functions/orchestrator.mjs');

/**
 * Drive the generator against a scripted sequence of activity/entity results.
 * Records every task the orchestrator creates, in order, so a replay can be
 * compared against the first pass.
 */
function drive(results) {
  const created = [];
  const ctx = {
    df: {
      instanceId: 'job-1',
      currentUtcDateTime: new Date('2026-09-30T09:00:00Z'),
      getInput: () => ({ task: { goal: 'g' } }),
      setCustomStatus: () => {},
      callActivity: (name, input) => { created.push(`activity:${name}`); return { __t: 'activity', name, input }; },
      callEntity: (id, op) => { created.push(`entity:${id.name}:${op}`); return { __t: 'entity', op }; },
      EntityId: function (name, key) { return { name, key }; },
    },
  };
  const gen = buildOrchestrator()(ctx);
  let step = gen.next();
  let i = 0;
  let guard = 0;
  while (!step.done) {
    // Two yields per step now — the activity, then the entity commit. Only the
    // activity consumes a scripted result; an entity call answers nothing.
    const send = step.value?.__t === 'activity' ? results[i++] : undefined;
    step = gen.next(send);
    guard += 1;
    if (guard > 300) throw new Error('orchestrator did not terminate');
  }
  return { created, output: step.value };
}

const advanced = (over = {}) => ({ status: 'suspended', done: false, delta: { observations: [] }, cleared: false, ...over });
const finished = (over = {}) => ({ status: 'completed', done: true, delta: null, cleared: true, result: 'r', ...over });

test('orchestrator: it advances until the run reports done', () => {
  const { created, output } = drive([advanced(), advanced(), finished()]);
  const activities = created.filter(c => c.startsWith('activity:'));
  assert.equal(activities.length, 3, 'one activity per step, no more');
  assert.equal(output.status, 'completed');
});

test('orchestrator: each delta is committed before the next step runs', () => {
  // The whole point of the fork. If the commit came after the next advance,
  // a crash between them would lose the step that had already executed.
  const { created } = drive([advanced(), finished()]);
  assert.deepEqual(created, [
    `activity:${ADVANCE_NAME}`,
    'entity:checkpoint:save',
    `activity:${ADVANCE_NAME}`,
    'entity:checkpoint:clear',
  ]);
});

test('orchestrator: a finished run clears the entity rather than leaving the row', () => {
  const { created } = drive([finished()]);
  assert.ok(created.includes('entity:checkpoint:clear'));
  assert.equal(created.includes('entity:checkpoint:save'), false, 'nothing to save on a run that cleared');
});

test('orchestrator: a paused run stops without clearing', () => {
  // The state is exactly what the answer will resume from. Clearing it here
  // would make the question unanswerable.
  const { created, output } = drive([
    { status: 'paused', done: true, delta: { observations: [] }, cleared: false, batchId: 'inp-1', batch: { batchId: 'inp-1', questions: [] } },
  ]);
  assert.ok(created.includes('entity:checkpoint:save'));
  assert.equal(created.includes('entity:checkpoint:clear'), false);
  assert.equal(output.status, 'paused');
  assert.equal(output.checkpointKey, 'cp-job-1');
});

test('orchestrator: the yield sequence is identical on replay', () => {
  // The determinism property. A sequence that varies between replays is what
  // drifted the SDK's event-ID counter and scheduled duplicate activities.
  const script = [advanced(), advanced(), finished()];
  const a = drive(script).created;
  const b = drive(script).created;
  const c = drive(script).created;
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('orchestrator: a runaway run is bounded rather than looping forever', () => {
  // An unbounded loop in an orchestrator is how a replay bug becomes an
  // unbounded bill. Never-done advances must terminate with a clear reason.
  const never = Array.from({ length: 60 }, () => advanced());
  const { output } = drive(never);
  assert.equal(output.status, 'failed');
  assert.match(output.error.message, /step/i);
});
