import path from 'node:path';
import os from 'node:os';

function resolvePolicy(tool, config) {
  // Kill switch. Freezing denies every irreversible tool outright, ahead of
  // per-tool policy, so an operator can stop writes without a redeploy and
  // without editing the policy table tool by tool. Reads keep working.
  if (config.freeze && tool.reversible === false) {
    return 'deny';
  }
  if (config.policies?.[tool.name]) {
    return config.policies[tool.name];
  }
  if (tool.reversible === false) {
    return 'approve';
  }
  return config.defaultPolicy ?? 'allow';
}

function looksLikePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('~/')) return true;
  if (value.includes('..')) return true;
  return path.isAbsolute(value);
}

function resolveSandboxPath(value) {
  if (value.startsWith('~/')) {
    const home = os.homedir();
    return path.resolve(home, value.slice(2));
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(process.cwd(), value);
}

function isWithinWorkdir(resolvedPath, workdir) {
  const relative = path.relative(workdir, resolvedPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function collectPathStrings(value, paths = []) {
  if (typeof value === 'string') {
    if (looksLikePath(value)) paths.push(value);
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, paths);
    return paths;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPathStrings(item, paths);
  }
  return paths;
}

function checkSandbox(args, config) {
  if (!config.sandboxFs) return null;
  const workdir = path.resolve(config.workdir ?? 'workdir');
  for (const candidate of collectPathStrings(args)) {
    const resolved = resolveSandboxPath(candidate);
    if (!isWithinWorkdir(resolved, workdir)) {
      return { allowed: false, reason: 'sandbox_violation' };
    }
  }
  return null;
}

// A guardrails instance is created once per process (host/index.mjs), while a
// budget is created per run (host/tasks.mjs). So a plain counter here would cap
// irreversible calls for the lifetime of the process, which is not what "at
// most N writes per run" means. Scope the count by traceId instead — every run
// started through /task carries one.
//
// The map is bounded so a long-lived host cannot accumulate one entry per run
// forever; the oldest run is evicted once the limit is passed. Eviction only
// loses accounting for runs that finished long ago.
const MAX_TRACKED_RUNS = 1024;

// traceId is what identifies a run, so it is also what makes a per-run cap
// meaningful. A call that arrives without one — a direct callTool from an MCP
// client, say — cannot be attributed to a run.
//
// Such calls are NOT capped, deliberately. The alternative is to count every
// untraced call into one shared bucket, which would mean one caller's writes
// refusing an unrelated caller's: a refusal that looks arbitrary and is very
// hard to diagnose. A missing limit is the safer failure of the two, because
// it is at least visible in what the agent did.
//
// If you want the cap to apply, pass a traceId. Every run started through
// /task carries one already.
function runKeyFor(executorArgs) {
  const id = executorArgs?.traceId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function createWriteCounter() {
  const counts = new Map();

  return {
    // null key => untraced => not subject to the cap (see above).
    count(executorArgs) {
      const key = runKeyFor(executorArgs);
      return key === null ? 0 : counts.get(key) ?? 0;
    },
    increment(executorArgs) {
      const key = runKeyFor(executorArgs);
      if (key === null) return;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      // Bounded so a long-lived host cannot accumulate one entry per run
      // forever; evicting the oldest only loses accounting for runs that
      // finished long ago.
      if (counts.size > MAX_TRACKED_RUNS) {
        counts.delete(counts.keys().next().value);
      }
    },
  };
}

// The callback may return a bare 'approve'/'deny' (the original contract) or
// { decision, approvedBy, reason }. Normalise both into one shape so an
// approval can be recorded rather than just acted on.
//
// Note on reach: the kit records who approved, but does not yet ship a way to
// put the question in front of a human. Until an adopter supplies a callback
// that reaches one, approvedBy is null and the approve policy denies. The
// transport — waiting_input job status, POST /jobs/:id/input, SSE delivery,
// budget pause and timeout — is tracked in issue #30.
function normaliseApproval(raw) {
  if (typeof raw === 'string') {
    return { approved: raw === 'approve', approvedBy: null, reason: null };
  }
  if (raw && typeof raw === 'object') {
    return {
      approved: raw.decision === 'approve',
      approvedBy: raw.approvedBy ?? null,
      reason: raw.reason ?? null,
    };
  }
  return { approved: false, approvedBy: null, reason: null };
}

export function createGuardrails(config = {}, tools = [], executor) {
  const writes = createWriteCounter();

  function gate(tool, args) {
    if (config.validateInputs && tool.inputSchema) {
      const result = tool.inputSchema.safeParse(args);
      if (!result.success) {
        return { allowed: false, reason: 'validation_failed', details: result.error };
      }
    }

    if (config.freeze && tool.reversible === false) {
      return { allowed: false, reason: 'frozen', policy: 'deny' };
    }

    const policy = resolvePolicy(tool, config);

    if (policy === 'deny') {
      return { allowed: false, reason: 'policy_denied', policy };
    }

    if (policy === 'approve') {
      return { allowed: false, reason: 'approval_denied', policy, needsCallback: true };
    }

    const sandboxDenied = checkSandbox(args, config);
    if (sandboxDenied) return sandboxDenied;

    return { allowed: true };
  }

  async function execute(tool, executorArgs) {
    if (config.validateInputs && tool.inputSchema) {
      const result = tool.inputSchema.safeParse(executorArgs.args);
      if (!result.success) {
        return { ok: false, error: 'guardrail_denied', reason: 'validation_failed', details: result.error };
      }
    }

    if (config.freeze && tool.reversible === false) {
      return { ok: false, error: 'guardrail_denied', reason: 'frozen' };
    }

    const policy = resolvePolicy(tool, config);

    if (policy === 'deny') {
      return { ok: false, error: 'guardrail_denied', reason: 'policy_denied' };
    }

    // Cap irreversible work per run. maxIterations counts turns, so a plan of
    // twenty reads and a plan of twenty writes cost the same against it; this
    // is the ceiling that distinguishes them.
    const isWrite = tool.reversible === false;
    const runKey = runKeyFor(executorArgs);
    if (isWrite && runKey !== null && typeof config.maxIrreversibleCalls === 'number') {
      const used = writes.count(executorArgs);
      if (used >= config.maxIrreversibleCalls) {
        return {
          ok: false,
          error: 'guardrail_denied',
          reason: 'write_limit',
          limit: config.maxIrreversibleCalls,
          used,
        };
      }
    }

    let approval = null;
    if (policy === 'approve') {
      if (!config.approvalCallback) {
        return { ok: false, error: 'guardrail_denied', reason: 'approval_denied' };
      }
      const raw = await config.approvalCallback({ tool, args: executorArgs.args, context: executorArgs });
      approval = normaliseApproval(raw);
      if (!approval.approved) {
        return {
          ok: false,
          error: 'guardrail_denied',
          reason: 'approval_denied',
          ...(approval.approvedBy ? { approvedBy: approval.approvedBy } : {}),
          ...(approval.reason ? { approvalReason: approval.reason } : {}),
        };
      }
    }

    const sandboxDenied = checkSandbox(executorArgs.args, config);
    if (sandboxDenied) {
      return { ok: false, error: 'guardrail_denied', reason: 'sandbox_violation' };
    }

    if (config.dryRunMode) {
      return { ok: false, error: 'guardrail_denied', reason: 'dry_run' };
    }

    // Count only work that is actually about to run. A write refused by policy,
    // freeze or an approver never happened, so it must not consume the budget.
    if (isWrite) writes.increment(executorArgs);

    const result = await executor(tool, executorArgs);

    // Record who approved an irreversible action, so the run history answers
    // "who let this happen?" rather than only "it happened".
    if (approval && (approval.approvedBy || approval.reason)) {
      return {
        ...result,
        approval: {
          approvedBy: approval.approvedBy,
          reason: approval.reason,
          at: new Date().toISOString(),
        },
      };
    }
    return result;
  }

  function dryRun() {
    return config.dryRunMode === true;
  }

  function frozen() {
    return config.freeze === true;
  }

  function writeCount(executorArgs) {
    return writes.count(executorArgs);
  }

  return { gate, execute, dryRun, frozen, writeCount };
}
