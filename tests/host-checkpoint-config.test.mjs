// tests/host-checkpoint-config.test.mjs
//
// Human input has no graceful degrade. A paused run needs somewhere to park
// and somewhere to put a checkpoint; without either, the failure surfaces at
// the first question rather than at startup — potentially days into a
// deployment, on the one path that cannot degrade.
//
// Two failure points, not one:
//   config  — humanInput on, memory off. Someone wrote it wrong.
//   runtime — memory configured, but it failed to open. The configuration is
//             CORRECT, so nobody is looking for a mistake.
//
// The second is the sharper of the two, and it is the one that used to warn
// and carry on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { assertHumanInputDependencies, describeStartupFailure } =
  await import('../host/config.mjs');

// A configuration that genuinely works. `memory: { enabled: true }` alone does
// not: with no checkpoint block the store resolves to null and every pause
// fails, so the block is part of what "on" means.
const on = {
  humanInput: { enabled: true },
  memory: { enabled: true, checkpoint: { enabled: true, store: 'sqlite' } },
  dispatch: { enabled: true },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('config: humanInput without memory is a startup error, not a warning', () => {
  assert.throws(
    () => assertHumanInputDependencies({ ...on, memory: { enabled: false } }),
    /humanInput requires memory/,
  );
  assert.throws(
    () => assertHumanInputDependencies({ humanInput: { enabled: true }, dispatch: { enabled: true } }),
    /humanInput requires memory/,
  );
});

test('config: humanInput without dispatch still errors, as before', () => {
  assert.throws(
    () => assertHumanInputDependencies({ ...on, dispatch: { enabled: false } }),
    /humanInput requires dispatch/,
  );
});

test('config: the error names the fix, so nobody has to read the source', () => {
  try {
    assertHumanInputDependencies({ ...on, memory: { enabled: false } });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /modules\.memory/);
    assert.match(err.message, /modules\.humanInput/);
  }
});

test('config: humanInput off requires nothing', () => {
  assert.doesNotThrow(() => assertHumanInputDependencies({ humanInput: { enabled: false } }));
  assert.doesNotThrow(() => assertHumanInputDependencies({}));
  assert.doesNotThrow(() => assertHumanInputDependencies(undefined));
});

test('config: a correct configuration passes', () => {
  assert.doesNotThrow(() => assertHumanInputDependencies(on));
});

// ---------------------------------------------------------------------------
// Runtime — memory configured but unreachable
// ---------------------------------------------------------------------------

test('runtime: memory that fails to start is fatal when humanInput is on', () => {
  assert.throws(
    () => assertHumanInputDependencies(on, { memoryStarted: false }),
    /the memory store could not be opened/,
  );
});

test('runtime: memory that fails to start is survivable when humanInput is off', () => {
  // On a VM without human input this is a reasonable degrade: the agent loses
  // recall and carries on. It is only fatal because a pause has nowhere to go.
  assert.doesNotThrow(
    () => assertHumanInputDependencies({ ...on, humanInput: { enabled: false } }, { memoryStarted: false }),
  );
});

test('runtime: the error says WHY memory stopped being optional', () => {
  try {
    assertHumanInputDependencies(on, { memoryStarted: false });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /humanInput/, 'names human input as the reason');
  }
});

// ---------------------------------------------------------------------------
// The error must not leak configuration
// ---------------------------------------------------------------------------

test('startup failure: the reason is stated, the cause is never quoted', () => {
  // A memory-store failure routinely carries a connection string, an endpoint,
  // a SAS token or a file path. That belongs in the operator's log, never in
  // an exception that may be rendered to a screen, posted to an error tracker,
  // or returned over HTTP.
  const cause = new Error(
    'failed to connect: AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2==;' +
    'BlobEndpoint=http://10.1.2.3:10000/devstoreaccount1;',
  );

  const safe = describeStartupFailure(cause);

  for (const leak of ['AccountKey', 'Eby8vdM02', 'BlobEndpoint', '10.1.2.3', 'devstoreaccount1']) {
    assert.equal(safe.includes(leak), false, `leaked: ${leak}`);
  }
  assert.match(safe, /memory store/, 'but it still says what failed');
});

test('startup failure: a file path is not quoted either', () => {
  const safe = describeStartupFailure(new Error("ENOENT: no such file or directory, open 'C:\\\\secrets\\\\memory.db'"));
  assert.equal(safe.includes('C:\\\\secrets'), false);
  assert.equal(safe.includes('memory.db'), false);
});

test('startup failure: the error name survives, because it is not sensitive', () => {
  // "which kind of failure" is useful and carries nothing. "which host, which
  // key, which path" is the part that does.
  const err = new TypeError('connection string malformed: Endpoint=https://acct.documents.azure.com');
  const safe = describeStartupFailure(err);
  assert.match(safe, /TypeError/);
  assert.equal(safe.includes('acct.documents.azure.com'), false);
});

test('startup failure: a cause with no message still produces something readable', () => {
  assert.match(describeStartupFailure(null), /memory store/);
  assert.match(describeStartupFailure(undefined), /memory store/);
});

// ---------------------------------------------------------------------------
// Memory "enabled" is not the same as a checkpoint store existing
//
// `memory: { enabled: true }` with no `checkpoint` block resolves to a null
// store, so the host started happily and then every pause died on
// "Cannot read properties of null (reading 'save')" — a raw null-deref,
// surfaced on the job record over GET /jobs/:id. That is exactly the failure
// this check exists to move to startup.
// ---------------------------------------------------------------------------

test('memory enabled with no checkpoint block is refused at startup', () => {
  assert.throws(
    () => assertHumanInputDependencies({
      humanInput: { enabled: true },
      dispatch: { enabled: true },
      memory: { enabled: true, longTerm: { enabled: true } },
    }),
    /checkpoint/,
  );
});

test('an explicitly disabled checkpoint block is refused too', () => {
  assert.throws(
    () => assertHumanInputDependencies({
      humanInput: { enabled: true },
      dispatch: { enabled: true },
      memory: { enabled: true, checkpoint: { enabled: false } },
    }),
    /checkpoint/,
  );
});

test('the former runState name still satisfies the check', () => {
  assert.doesNotThrow(() => assertHumanInputDependencies({
    humanInput: { enabled: true },
    dispatch: { enabled: true },
    memory: { enabled: true, runState: { enabled: true, store: 'sqlite' } },
  }));
});

test('a configured checkpoint block passes', () => {
  assert.doesNotThrow(() => assertHumanInputDependencies({
    humanInput: { enabled: true },
    dispatch: { enabled: true },
    memory: { enabled: true, checkpoint: { enabled: true, store: 'sqlite' } },
  }));
});

test('the refusal names no environment value', () => {
  // Same rule as describeStartupFailure: say what is wrong, never quote a
  // connection string, key or path.
  try {
    assertHumanInputDependencies({
      humanInput: { enabled: true }, dispatch: { enabled: true },
      memory: { enabled: true, checkpoint: { enabled: false, dbPath: '/srv/secret-path/memory.db' } },
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.message.includes('/srv/secret-path'), false);
  }
});
