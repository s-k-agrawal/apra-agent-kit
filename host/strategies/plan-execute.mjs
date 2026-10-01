// host/strategies/plan-execute.mjs
import { parseResponse } from '../response-parser.mjs';
import { checkpointKey, stepIdempotencyKey } from '../checkpoint/record.mjs';
import {
  buildSystemPrompt, buildPlanPrompt, buildReviewPrompt, buildStepReviewPrompt,
  buildResolveArgsPrompt, buildReasonPrompt, buildReplanPrompt, buildExecutePrompt,
  formatTools,
} from '../prompts/index.mjs';

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

function needsArgsResolution(step) {
  if (step.type !== 'tool') return false;
  if (!step.args || Object.keys(step.args).length === 0) return true;
  return Object.values(step.args).some(v => v === undefined || v === null || v === '');
}

export function createPlanExecuteStrategy({
  task,
  tools,
  fleetApi,
  guardrails,
  jobs,
  workspace,
  maxReplanAttempts = 3,
  maxReviewAttempts = 2,
  maxStepReviewAttempts = 2,
  maxNoActionTurns = 3,
  minReviewPolicy = 'irreversible',
  agentName = 'agent',
  agentDescription = '',
  traceId = null,
  memory,
  memories,
  conversation,
  askUser = undefined,
  resumeFrom = null,
  checkpoint = null,
  // Azure only. The orchestrator must commit the checkpoint between steps, and
  // `callEntity` is reachable only from the orchestrator generator — so the
  // activity advances the run by this many steps and then suspends. Unset on
  // the VM path, where a run executes end to end in one go.
  maxSteps = Infinity,
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription, memories, conversation });
  const toolCatalog = formatTools(tools);
  // Seeded on a resume; the empty array it has always been otherwise.
  const observations = resumeFrom?.observations ? [...resumeFrom.observations] : [];
  // ...and if it was seeded, the checkpoint load below must not append the same
  // observations again. `resumeContextFor` builds `resumeFrom` from the very
  // row that load reads, so before this flag a resume counted every completed
  // step twice, and the next save persisted the doubled list.
  const seededFromResume = Array.isArray(resumeFrom?.observations);
  // One key, from one place. The retired run-state used `task.id ?? task.goal`,
  // so two concurrent runs of the same goal shared a row and clobbered each
  // other. A task with no id cannot be checkpointed at all — see checkpointKey.
  let taskKey = null;
  try { taskKey = checkpointKey(task); } catch { taskKey = null; }

  // Where a pause left off, updated as execution advances, so `progress()`
  // reports the truth at whatever moment the run happens to unwind.
  let progressPlan = resumeFrom?.plan ?? null;
  let progressCursor = resumeFrom?.plan?.cursor ?? 0;

  function remember(observation) {
    observations.push(observation);
  }

  function historyForPrompt() {
    return observations;
  }

  function shouldReview(step) {
    if (step.review) return true;
    if (minReviewPolicy === 'irreversible' && step.type === 'tool') {
      const tool = tools.find(t => t.name === step.tool);
      if (tool && tool.reversible === false) return true;
    }
    return false;
  }

  async function callPrompt(memberName, prompt) {
    const raw = await fleetApi.executePrompt({ member_name: memberName, prompt });
    return extractText(raw);
  }

  async function runTool(name, args) {
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" not found in registry.` };
    }
    if (guardrails) {
      return guardrails.execute(tool, { fleetApi, args, jobs, traceId, workspace, askUser });
    }
    const { executeTool } = await import('../tools/executor.mjs');
    return executeTool(tool, { fleetApi, args, jobs, traceId, workspace, askUser });
  }

  async function* iterate() {
    let stepsThisPass = 0;
    let replanCount = 0;
    let currentPlan = null;
    let idempotencyKeys = new Set();
    let resumeStart = 0;
    let resumePending = false;

    if (checkpoint && taskKey) {
      const loaded = await checkpoint.load(taskKey);
      if (loaded.ok) {
        const cp = loaded.checkpoint;
        // The cursor is `plan.cursor` now, not `stepIndex`. One name for one
        // fact, shared with the pause path.
        if (Number.isInteger(cp.plan?.cursor)) resumeStart = cp.plan.cursor;
        if (cp.plan?.steps?.length) {
          currentPlan = { ...cp.plan, steps: cp.plan.steps };
          resumePending = true;
        }
        // Only when nothing seeded them: same row, same observations.
        if (!seededFromResume) for (const obs of cp.observations ?? []) remember(obs);
        // Always taken from here. `resumeFrom` does not carry the keys, and
        // without them a completed irreversible step runs a second time.
        idempotencyKeys = new Set(cp.idempotencyKeys ?? []);
      }
    }

    async function saveCheckpoint(stepIndex, idempotencyKey) {
      if (!checkpoint || !taskKey) return;
      const nextKeys = new Set(idempotencyKeys);
      nextKeys.add(idempotencyKey);

      let saved = false;
      try {
        saved = await checkpoint.save(taskKey, {
        jobId: task?.id ?? null,
        traceId,
        task,
        // Resuming under a renamed agent or a different strategy changes
        // behaviour with no trace, so all three are recorded.
        agentName,
        agentDescription,
        strategy: 'plan-execute',
        plan: { steps: currentPlan?.steps ?? [], cursor: stepIndex },
        observations,
        idempotencyKeys: [...nextKeys],
          conversation: conversation ?? [],
          recalledFacts: memories ?? [],
        });
      } catch (err) {
        // The shipped checkpoint returns false rather than throwing, but a
        // different implementation might not — and losing a checkpoint must
        // never take down a run that is otherwise fine.
        console.warn(`[host] checkpoint save threw — continuing: ${err?.message ?? err}`);
        return;
      }

      // A false means the write failed and the previous checkpoint must stay;
      // advancing the in-memory key set would let a step be skipped after a
      // crash that the store never learnt about.
      if (!saved) return;
      idempotencyKeys = nextKeys;
    }

    async function* reviewPlan(plan) {
      let workingPlan = plan;

      for (let reviewRound = 0; reviewRound < maxReviewAttempts; reviewRound++) {
        const reviewPrompt = buildReviewPrompt({ task, plan: workingPlan, tools: toolCatalog, systemPrompt });
        const reviewText = await callPrompt('reviewer', reviewPrompt);
        yield { type: 'prompt_usage', text: reviewText };
        const reviewParsed = parseResponse(reviewText);

        if (reviewParsed.type !== 'review') {
          yield { type: 'review', approved: true, note: 'Reviewer did not produce review block, treating as approved' };
          return workingPlan;
        }

        const { approved, feedback } = reviewParsed.payload;
        yield { type: 'review', approved, feedback };

        if (approved) return workingPlan;

        replanCount++;
        if (replanCount > maxReplanAttempts) {
          yield { type: 'error', reason: 'max_replans', message: `Exceeded ${maxReplanAttempts} replan attempts` };
          return null;
        }

        const replanPrompt = buildReplanPrompt({
          task, plan: workingPlan, history: historyForPrompt(),
          failedStep: null, reviewerFeedback: feedback, systemPrompt,
        });
        let replanResult = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const replanText = await callPrompt('doer', attempt === 0 ? replanPrompt : replanPrompt + '\n\nIMPORTANT: You MUST respond with a ```plan code fence containing the revised JSON plan.');
          yield { type: 'prompt_usage', text: replanText };
          const replanParsed = parseResponse(replanText);
          if (replanParsed.type === 'plan') { replanResult = replanParsed.payload; break; }
        }
        if (!replanResult) {
          yield { type: 'review', approved: true, feedback: 'Replan failed; proceeding with current plan' };
          return workingPlan;
        }
        workingPlan = replanResult;
        yield { type: 'plan', plan: workingPlan, _replan: true };
      }

      return workingPlan;
    }

    async function* replanAfterStepFailure(failedStep, feedback) {
      replanCount++;
      if (replanCount > maxReplanAttempts) {
        yield { type: 'error', reason: 'max_replans', message: 'Exceeded replan attempts after step review rejection' };
        return null;
      }

      const replanPrompt = buildReplanPrompt({
        task, plan: currentPlan, history: historyForPrompt(),
        failedStep, reviewerFeedback: feedback, systemPrompt,
      });
      let revisedPlan = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const rpText = await callPrompt('doer', attempt === 0 ? replanPrompt : replanPrompt + '\n\nIMPORTANT: You MUST respond with a ```plan code fence containing the revised JSON plan.');
        yield { type: 'prompt_usage', text: rpText };
        const rpParsed = parseResponse(rpText);
        if (rpParsed.type === 'plan') { revisedPlan = rpParsed.payload; break; }
      }
      if (!revisedPlan) {
        yield { type: 'review', approved: true, feedback: 'Replan failed; continuing with current plan' };
        return currentPlan;
      }

      yield { type: 'plan', plan: revisedPlan, _replan: true };

      return yield* reviewPlan(revisedPlan);
    }

    // Phase 1: Plan — skipped when a run-state checkpoint already holds a
    // plan, and skipped entirely when resuming from a pause. The plan was made
    // and reviewed before the run paused; re-planning would discard completed
    // work and cost another round of prompts for an answer we already have.
    //
    // A paused resume and a checkpoint resume are the same shape, so this
    // feeds the checkpoint's own resumeStart/resumePending rather than running
    // a second mechanism beside it.
    if (resumeFrom?.plan?.steps?.length) {
      currentPlan = { ...resumeFrom.plan, steps: resumeFrom.plan.steps };
      resumeStart = resumeFrom.plan.cursor ?? 0;
      resumePending = true;
      progressPlan = currentPlan;
      progressCursor = resumeStart;
      yield { type: 'plan', plan: currentPlan, _replan: false, _resumed: true };
    } else if (!currentPlan) {
      const planPrompt = buildPlanPrompt({ task, tools: toolCatalog, systemPrompt });
      const planText = await callPrompt('doer', planPrompt);
      yield { type: 'prompt_usage', text: planText };
      const planParsed = parseResponse(planText);

      if (planParsed.type !== 'plan') {
        yield { type: 'error', reason: 'invalid_plan', message: 'Doer did not produce a plan block' };
        return;
      }

      currentPlan = planParsed.payload;
      yield { type: 'plan', plan: currentPlan, _replan: false };

      const reviewedPlan = yield* reviewPlan(currentPlan);
      if (!reviewedPlan) return;
      currentPlan = reviewedPlan;
    }

    // Phase 3: Execute steps (restarts from the beginning after step-review replan)
    executeLoop: while (true) {
      const steps = currentPlan.steps;
      const start = resumePending ? resumeStart : 0;
      resumePending = false;
      let restartExecution = false;

      // Only the first pass resumes mid-plan — `start` is zero thereafter. A
      // replan produces new steps, and new steps are new work: starting one of
      // those part-way through would skip something that has never run.
      progressPlan = currentPlan;

      for (let i = start; i < steps.length; i++) {
        const step = steps[i];
        progressCursor = i;
        const idempotencyKey = stepIdempotencyKey(step, i);
        if (checkpoint && taskKey && await checkpoint.hasIdempotencyKey(taskKey, idempotencyKey)) {
          continue;   // already done before a crash; do not run it twice
        }

        if (step.type === 'tool') {
          let args = step.args;

          if (needsArgsResolution(step)) {
            const resolvePrompt = buildResolveArgsPrompt({ task, step, history: historyForPrompt(), systemPrompt });
            const resolveText = await callPrompt('doer', resolvePrompt);
            yield { type: 'prompt_usage', text: resolveText };
            const resolved = parseResponse(resolveText);
            if (resolved.type === 'tool_call') {
              args = resolved.payload.args;
            }
          }

          yield { type: 'step_started', stepIndex: i, step: { type: 'tool', tool: step.tool }, args };

          let result = await runTool(step.tool, args);
          if (result.ok === false) {
            const toolDef = tools.find(t => t.name === step.tool);
            const willRetry = !!(toolDef?.retryable);
            yield { type: 'step_failed', stepIndex: i, step: { type: 'tool', tool: step.tool }, error: result.message ?? result.error ?? 'Tool execution failed', willRetry };
            if (willRetry) {
              const retryLimit = toolDef.retryLimit ?? 1;
              for (let retry = 0; retry < retryLimit && result.ok === false; retry++) {
                result = await runTool(step.tool, args);
              }
            }
            if (result.ok === false) {
              const replannedPlan = yield* replanAfterStepFailure(
                step,
                result.message ?? result.error ?? 'Tool execution failed',
              );
              if (!replannedPlan) return;
              currentPlan = replannedPlan;
              restartExecution = true;
              break;
            }
          }

          remember({ type: 'observation', stepType: 'tool', tool: step.tool, args, result });
          yield { type: 'observation', stepType: 'tool', tool: step.tool, args, stepIndex: i, ...result };

          if (shouldReview(step)) {
            for (let retryRound = 0; retryRound <= maxStepReviewAttempts; retryRound++) {
              const srPrompt = buildStepReviewPrompt({ task, step, result, history: historyForPrompt(), systemPrompt });
              const srText = await callPrompt('reviewer', srPrompt);
              yield { type: 'prompt_usage', text: srText };
              const srParsed = parseResponse(srText);

              const approved = srParsed.type === 'step_review' ? srParsed.payload.approved : true;
              const feedback = srParsed.type === 'step_review' ? srParsed.payload.feedback : undefined;
              yield { type: 'step_review', approved, feedback, step: step.tool };

              if (approved) break;

              if (retryRound >= maxStepReviewAttempts) {
                const replannedPlan = yield* replanAfterStepFailure(step, feedback);
                if (!replannedPlan) return;
                currentPlan = replannedPlan;
                restartExecution = true;
                break;
              }

              const retryPrompt = buildResolveArgsPrompt({
                task,
                step: { ...step, reason: `Retry: ${feedback}` },
                history: historyForPrompt(),
                systemPrompt,
              });
              const retryText = await callPrompt('doer', retryPrompt);
              yield { type: 'prompt_usage', text: retryText };
              const retryParsed = parseResponse(retryText);
              if (retryParsed.type === 'tool_call') {
                args = retryParsed.payload.args;
              }
              result = await runTool(step.tool, args);
              remember({ type: 'observation', stepType: 'tool', tool: step.tool, args, result, retry: retryRound + 1 });
              yield { type: 'observation', stepType: 'tool', tool: step.tool, args, ...result };
            }

            if (restartExecution) break;
          }
        } else if (step.type === 'reason') {
          yield { type: 'step_started', stepIndex: i, step: { type: 'reason' } };
          const reasonPrompt = buildReasonPrompt({ task, step, history: historyForPrompt(), systemPrompt });
          let reasonText = await callPrompt('doer', reasonPrompt);
          yield { type: 'prompt_usage', text: reasonText };
          remember({ type: 'observation', stepType: 'reason', text: reasonText });
          yield { type: 'observation', stepType: 'reason', text: reasonText, stepIndex: i };

          if (shouldReview(step)) {
            for (let retryRound = 0; retryRound <= maxStepReviewAttempts; retryRound++) {
              const srPrompt = buildStepReviewPrompt({
                task, step, result: { text: reasonText }, history: historyForPrompt(), systemPrompt,
              });
              const srText = await callPrompt('reviewer', srPrompt);
              yield { type: 'prompt_usage', text: srText };
              const srParsed = parseResponse(srText);

              const approved = srParsed.type === 'step_review' ? srParsed.payload.approved : true;
              const feedback = srParsed.type === 'step_review' ? srParsed.payload.feedback : undefined;
              yield { type: 'step_review', approved, feedback, step: 'reason' };

              if (approved) break;

              if (retryRound >= maxStepReviewAttempts) {
                const replannedPlan = yield* replanAfterStepFailure(step, feedback);
                if (!replannedPlan) return;
                currentPlan = replannedPlan;
                restartExecution = true;
                break;
              }

              const retryPrompt = buildReasonPrompt({
                task,
                step: { ...step, prompt: `Retry: ${feedback}. ${step.prompt}` },
                history: historyForPrompt(),
                systemPrompt,
              });
              reasonText = await callPrompt('doer', retryPrompt);
              yield { type: 'prompt_usage', text: reasonText };
              remember({ type: 'observation', stepType: 'reason', text: reasonText, retry: retryRound + 1 });
              yield { type: 'observation', stepType: 'reason', text: reasonText };
            }

            if (restartExecution) break;
          }
        } else {
          continue;
        }

        await saveCheckpoint(i, idempotencyKey);

        stepsThisPass += 1;
        if (stepsThisPass >= maxSteps) {
          // Not done, not failed: the run has more to do and is handing control
          // back so the caller can commit. `cursor` is the next step to run —
          // without it a suspend is indistinguishable from a crash.
          progressCursor = i + 1;
          yield { type: 'suspended', cursor: i + 1, plan: currentPlan };
          return;
        }
      }

      if (restartExecution) {
        continue executeLoop;
      }
      progressCursor = steps.length;
      break executeLoop;
    }

    // Phase 4: Done
    const donePrompt = buildExecutePrompt({
      task, plan: currentPlan, stepIndex: currentPlan.steps.length - 1,
      observation: observations[observations.length - 1], systemPrompt,
    });
    const doneText = await callPrompt('doer', donePrompt);
    yield { type: 'prompt_usage', text: doneText };
    const doneParsed = parseResponse(doneText);

    if (doneParsed.type === 'done') {
      yield { type: 'done', result: doneParsed.payload.result, summary: doneParsed.payload.summary };
    } else {
      yield { type: 'done', result: doneText, summary: 'Plan execution completed' };
    }
  }

  return {
    iterate,
    history: () => [...observations],
    // What a pause needs to write down: the observations so far, and which
    // step the plan had reached. The cursor points at the step that was being
    // attempted, so a resume retries it rather than skipping it — the pause
    // happened *before* it completed.
    progress: () => ({
      observations: [...observations],
      plan: progressPlan ? { steps: progressPlan.steps, cursor: progressCursor } : null,
    }),
  };
}
