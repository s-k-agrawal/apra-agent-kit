// host/memory/learner.mjs
const LEARNER_PROMPT = `You are a memory extraction agent. Given a completed task and its observation history, extract reusable facts that would help in future similar tasks.

Rules:
- Only extract facts useful across multiple future runs, not task-specific results.
- Each fact must have: kind (one of: domain, preference, pattern, procedure — NEVER "rule"), text, and tags (array of strings).
- Also identify which recalled facts (by id) were actually used in this run.
- Respond with a JSON block:

\`\`\`json
{
  "newFacts": [{ "kind": "domain", "text": "...", "tags": ["..."] }],
  "usedRecalledIds": ["mem-xxx", "mem-yyy"]
}
\`\`\`

Task: {{TASK}}

Recalled facts at start:
{{RECALLED}}

Answers the person gave when asked (higher signal than an observation — these
are stated preferences, not inferred ones):
{{ANSWERS}}

Observation history:
{{HISTORY}}`;

/**
 * An answer as a person would read it.
 *
 * A future question kind can hand back any shape, and string interpolation
 * turns an object into "[object Object]" — the model learns nothing from it
 * and the prompt still looks well-formed, so nobody finds out.
 */
function renderAnswer(answer) {
  if (Array.isArray(answer)) return answer.join(', ');
  if (answer !== null && typeof answer === 'object') return JSON.stringify(answer);
  return String(answer);
}

function buildPrompt(task, history, recalledFacts, answers) {
  const taskText = typeof task === 'string' ? task : (task?.goal ?? JSON.stringify(task));
  const recalledText = (recalledFacts ?? []).map(f => `[${f.id}] (${f.kind}) ${f.text}`).join('\n') || '(none)';
  const historyText = (history ?? []).map((e, i) => {
    let content = e.text;
    if (content == null) {
      content = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? e);
    }
    if (content.length > 500) content = content.slice(0, 500) + '…';
    return `[${i + 1}] ${e.type ?? 'step'}: ${content}`;
  }).join('\n');
  return LEARNER_PROMPT
    .replace('{{TASK}}', taskText)
    .replace('{{RECALLED}}', recalledText)
    .replace('{{ANSWERS}}', (answers ?? []).map(a => `- asked "${a.prompt}" → ${renderAnswer(a.answer)}`).join('\n') || '(none)')
    .replace('{{HISTORY}}', historyText);
}

function parseExtraction(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return { newFacts: [], usedRecalledIds: [] };
  try {
    const parsed = JSON.parse(match[1]);
    const newFacts = (parsed.newFacts ?? []).filter(f => f.kind !== 'rule');
    return { newFacts, usedRecalledIds: parsed.usedRecalledIds ?? [] };
  } catch {
    return { newFacts: [], usedRecalledIds: [] };
  }
}

function extractText(response) {
  if (typeof response === 'string') return response;
  if (response?.isError) {
    const msg = (response.content ?? []).map(p => p.text ?? '').join('\n') || 'unknown error';
    throw new Error(`execute_prompt returned error: ${msg}`);
  }
  return (response?.content ?? []).map(p => p.text ?? '').join('\n');
}

export function createLearner({ longTermMemory, fleetApi: defaultFleetApi, events = null, logger = console, maxRetries = 2, retryDelayMs = 3000 } = {}) {
  async function callWithRetry(prompt, api) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await api.executePrompt({ member_name: 'doer', prompt });
        return extractText(response);
      } catch (err) {
        lastErr = err;
        logger.warn?.(`[memory/learner] executePrompt attempt ${attempt + 1} failed: ${err?.message ?? err}`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
    throw lastErr;
  }

  return {
    async extract({ task, history, recalledFacts, answers, fleetApi }) {
      const api = fleetApi ?? defaultFleetApi;
      try {
        const prompt = buildPrompt(task, history, recalledFacts, answers);
        const text = await callWithRetry(prompt, api);
        const { newFacts, usedRecalledIds } = parseExtraction(text);

        const stored = [];
        for (const fact of newFacts) {
          const result = await longTermMemory.store({
            kind: fact.kind,
            text: fact.text,
            tags: fact.tags ?? [],
            source: 'agent',
          });
          stored.push(result);
        }

        const promotedIds = [];
        for (const id of usedRecalledIds) {
          try {
            await longTermMemory.promote(id);
            promotedIds.push(id);
          } catch { /* skip missing */ }
        }

        logger.info?.(`[memory/learner] extracted ${newFacts.length} facts, promoted ${promotedIds.length} recalled facts`);
        events?.emit('memory:learn', { taskId: task?.id ?? null, newFacts: stored, promotedIds });
        return { newFacts: stored, promotedIds };
      } catch (err) {
        logger.warn?.(`[memory/learner] extraction failed: ${err?.message ?? err}`);
        events?.emit('memory:error', { tier: 'learner', error: err?.message ?? String(err), policy: 'log-and-skip' });
        return { newFacts: [], promotedIds: [] };
      }
    },
  };
}

/**
 * The answers a run may learn from.
 *
 * Both clauses are load-bearing. `askedBy` excludes the safety layer; `kind`
 * closes the case where a *tool* raises an approval question of its own, which
 * nothing in the kit prevents and which `askedBy` alone would let through.
 *
 * **A remembered approval is a guardrail that silently stopped working.**
 * Permission is per-action and per-moment: somebody who approved one booking
 * has not approved the next one, and an agent that learns otherwise is worse
 * than one that asks every time.
 *
 * Safe to feed to a model: question prompts are plain language by contract —
 * no identifiers, no tool names, no parameter names — so what reaches the
 * learner is already fit to store as a fact.
 */
export function learnableAnswers(history = []) {
  const batches = new Map();
  const out = [];

  for (const e of history) {
    if (e?.type === 'question_asked' && e.batch?.batchId) {
      batches.set(e.batch.batchId, e.batch);
      continue;
    }
    if (e?.type !== 'answer_received') continue;

    // Without the batch there is no way to know who asked or what kind it was,
    // and guessing would be guessing about permission.
    const batch = batches.get(e.batchId);
    if (!batch || batch.askedBy === 'guardrail') continue;

    for (const q of batch.questions ?? []) {
      if (q.kind === 'approval') continue;
      const answer = e.answers?.[q.fieldId];
      if (answer === undefined) continue;
      out.push({
        prompt: q.prompt,
        answer: answer !== null && typeof answer === 'object' && !Array.isArray(answer) && 'other' in answer
          ? answer.other
          : answer,
      });
    }
  }

  return out;
}
