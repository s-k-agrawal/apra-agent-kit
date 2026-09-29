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

/**
 * The question a person is actually shown before an irreversible tool runs.
 *
 * The plain-language rule is normative, not stylistic: no identifiers, no tool
 * names, no parameter names. Two reasons — a question nobody understands
 * trains people to approve reflexively, and internal structure on a screen is
 * an information-disclosure surface.
 *
 * A tool therefore describes itself. `approvalPrompt` is a function of the
 * arguments where the sentence depends on them; `description` is the fallback.
 * The last resort is deliberately vague rather than leaking the tool name.
 */
function describeForApproval(tool, args) {
  if (typeof tool.approvalPrompt === 'function') {
    const written = tool.approvalPrompt(args);
    if (typeof written === 'string' && written.trim()) return written.trim();
  }
  if (typeof tool.approvalPrompt === 'string' && tool.approvalPrompt.trim()) {
    return tool.approvalPrompt.trim();
  }
  if (typeof tool.description === 'string' && tool.description.trim()) {
    return `May I go ahead and ${lowerFirst(tool.description.trim().replace(/\.$/, ''))}?`;
  }
  return 'This step makes a change that cannot be undone. May I go ahead?';
}

const lowerFirst = (s) => (s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s);

export function createGuardrails(config = {}, tools = [], executor) {
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
    // Set when a person approved this call through `askUser`, so the result
    // can say who let it through rather than only that it ran.
    let approval = null;

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

    if (policy === 'approve') {
      // Precedence, in order:
      //   1. approvalCallback — an adopter with their own transport sees no
      //      change whatsoever from human input being available.
      //   2. askUser — the durable route: raise a one-question batch and pause.
      //   3. neither — deny, exactly as before.
      //
      // The order matters. Silently switching an adopter who already has a
      // callback over to the kit's own question flow would reroute their
      // approvals to a screen they do not run.
      if (config.approvalCallback) {
        const decision = await config.approvalCallback({ tool, args: executorArgs.args, context: executorArgs });
        if (decision !== 'approve') {
          return { ok: false, error: 'guardrail_denied', reason: 'approval_denied' };
        }
      } else if (typeof executorArgs.askUser === 'function') {
        // This either returns a replayed answer or throws PauseRequested,
        // which unwinds the run. It is deliberately not caught: a pause is not
        // a denial, and treating it as one would run the tool's opposite.
        const answer = await executorArgs.askUser({
          askedBy: 'guardrail',
          askedByDetail: tool.name,
          questions: [{
            fieldId: 'proceed',
            kind: 'approval',
            // Plain language, no identifiers: a question nobody understands
            // trains people to approve reflexively.
            prompt: describeForApproval(tool, executorArgs.args),
            required: true,
          }],
        });

        if (answer?.answers?.proceed !== 'approve') {
          return { ok: false, error: 'guardrail_denied', reason: 'approval_denied', approval: { decision: 'deny', batchId: answer?.batchId ?? null } };
        }
        approval = { decision: 'approve', batchId: answer.batchId ?? null };
      } else {
        return { ok: false, error: 'guardrail_denied', reason: 'approval_denied' };
      }
    }

    const sandboxDenied = checkSandbox(executorArgs.args, config);
    if (sandboxDenied) {
      return { ok: false, error: 'guardrail_denied', reason: 'sandbox_violation' };
    }

    if (config.dryRunMode) {
      return { ok: false, error: 'guardrail_denied', reason: 'dry_run' };
    }

    const result = await executor(tool, executorArgs);
    // Added only when there was one, so a run with no human input in it
    // produces byte-for-byte the results it always did.
    return approval ? { ...result, approval } : result;
  }

  function dryRun() {
    return config.dryRunMode === true;
  }

  function frozen() {
    return config.freeze === true;
  }

  return { gate, execute, dryRun, frozen };
}
