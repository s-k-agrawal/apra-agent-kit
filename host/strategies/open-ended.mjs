// host/strategies/open-ended.mjs
import { parseResponse } from '../response-parser.mjs';
import { buildSystemPrompt, buildActPrompt, formatTools } from '../prompts/index.mjs';
import { checkpointKey } from '../checkpoint/record.mjs';

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

export function createOpenEndedStrategy({
  task,
  tools,
  fleetApi,
  guardrails,
  jobs,
  workspace,
  maxNoActionTurns = 3,
  agentName = 'agent',
  agentDescription = '',
  traceId = null,
  memory,
  memories,
  conversation,
  askUser = undefined,
  resumeFrom = null,
  checkpoint = null,
  // Azure only — see plan-execute for why. Open-ended has no plan, so a step
  // is one LLM turn plus whatever tool it chose.
  maxSteps = Infinity,
  strategy = 'open-ended',
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription, memories, conversation });
  const toolCatalog = formatTools(tools);
  // A resumed run picks up the observations it had before it paused, so the
  // next prompt reads exactly as it would have. Absent `resumeFrom`, this is
  // the empty array it has always been.
  const observations = resumeFrom?.observations ? [...resumeFrom.observations] : [];
  let noActionCount = 0;

  function remember(observation) {
    observations.push(observation);
  }

  /**
   * Crash recovery. open-ended never had this: only plan-execute checkpointed,
   * so a crash here lost every step the run had taken.
   *
   * Best-effort by design. A false return means the store is unreachable,
   * which degrades recovery and does not invalidate the work already done —
   * so the run carries on. A task with no id cannot be keyed (two runs of the
   * same goal would share a row), and that is a reason to skip, not to crash.
   */
  async function saveCheckpoint() {
    if (!checkpoint) return;
    let key;
    try {
      key = checkpointKey(task);
    } catch {
      return;   // no id to key on — see checkpointKey
    }
    try {
      await checkpoint.save(key, {
      jobId: task?.id ?? null,
      traceId,
      task,
      agentName,
      agentDescription,
      strategy,
      plan: null,                       // open-ended has no plan
      observations,
        conversation: conversation ?? [],
        recalledFacts: memories ?? [],
      });
    } catch {
      // Same reasoning as plan-execute: a checkpoint that cannot be written
      // degrades crash recovery and does not invalidate the work already done.
    }
  }

  function historyForPrompt() {
    return observations;
  }

  async function executeTool(name, args) {
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" not found in registry.` };
    }
    if (guardrails) {
      return guardrails.execute(tool, { fleetApi, args, jobs, traceId, workspace, askUser });
    }
    const { executeTool: exec } = await import('../tools/executor.mjs');
    return exec(tool, { fleetApi, args, jobs, traceId, workspace, askUser });
  }

  async function* iterate() {
    let stepsThisPass = 0;
    while (true) {
      const history = historyForPrompt();
      const prompt = buildActPrompt({ task, history, tools: toolCatalog, systemPrompt });
      const raw = await fleetApi.executePrompt({ member_name: 'doer', prompt });
      const text = extractText(raw);
      const parsed = parseResponse(text);

      yield { type: 'prompt_usage', text };

      if (parsed.type === 'done') {
        yield { type: 'done', result: parsed.payload.result, summary: parsed.payload.summary };
        return;
      }

      if (parsed.type === 'tool_call') {
        noActionCount = 0;
        const { tool, args } = parsed.payload;
        yield { type: 'action', tool, args, reasoning: parsed.reasoning };
        const result = await executeTool(tool, args);
        remember({ type: 'observation', tool, args, result });
        await saveCheckpoint();
        yield { type: 'observation', tool, args, ...result };
        stepsThisPass += 1;
        if (stepsThisPass >= maxSteps) {
          yield { type: 'suspended' };
          return;
        }
        continue;
      }

      if (parsed.type === 'thinking' || parsed.type === 'error') {
        noActionCount++;
        remember({ type: 'thinking', text: parsed.reasoning ?? parsed.message });
        if (noActionCount >= maxNoActionTurns) {
          yield { type: 'error', reason: 'no_action', message: `${maxNoActionTurns} consecutive turns with no tool call or done block` };
          return;
        }
        continue;
      }

      noActionCount++;
      remember({ type: 'thinking', text });
      if (noActionCount >= maxNoActionTurns) {
        yield { type: 'error', reason: 'no_action', message: `${maxNoActionTurns} consecutive turns with no tool call or done block` };
        return;
      }
    }
  }

  return {
    iterate,
    history: () => [...observations],
    // What a pause needs to write down. Open-ended has no plan, so where it
    // had got to *is* its observations.
    progress: () => ({ observations: [...observations], plan: null }),
  };
}
