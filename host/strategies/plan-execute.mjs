// host/strategies/plan-execute.mjs
import { parseResponse } from '../response-parser.mjs';
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
  askUser = undefined,
  resumeFrom = null,
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription });
  const toolCatalog = formatTools(tools);
  // Seeded on a resume; the empty array it has always been otherwise.
  const observations = resumeFrom?.observations ? [...resumeFrom.observations] : [];
  // Where a pause left off, updated as execution advances, so `progress()`
  // reports the truth at whatever moment the run happens to unwind.
  let progressPlan = resumeFrom?.plan ?? null;
  let progressCursor = resumeFrom?.plan?.cursor ?? 0;

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
    let replanCount = 0;
    let currentPlan = null;

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
          task, plan: workingPlan, history: observations,
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
        task, plan: currentPlan, history: observations,
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

    // Phase 1: Plan — skipped entirely on a resume. The plan was made, and
    // reviewed, before the run paused; re-planning would discard completed
    // work and cost another round of prompts for an answer we already have.
    let resumeAt = 0;
    if (resumeFrom?.plan?.steps?.length) {
      currentPlan = { ...resumeFrom.plan, steps: resumeFrom.plan.steps };
      resumeAt = resumeFrom.plan.cursor ?? 0;
      progressPlan = currentPlan;
      progressCursor = resumeAt;
      yield { type: 'plan', plan: currentPlan, _replan: false, _resumed: true };
    } else {
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
      let restartExecution = false;

      // Only the first pass resumes mid-plan. A replan produces new steps, and
      // new steps are new work — starting one of those part-way through would
      // skip something that has never run.
      const from = resumeAt;
      resumeAt = 0;
      progressPlan = currentPlan;

      for (let i = from; i < steps.length; i++) {
        const step = steps[i];
        progressCursor = i;

        if (step.type === 'tool') {
          let args = step.args;

          if (needsArgsResolution(step)) {
            const resolvePrompt = buildResolveArgsPrompt({ task, step, history: observations, systemPrompt });
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

          observations.push({ type: 'observation', stepType: 'tool', tool: step.tool, args, result });
          yield { type: 'observation', stepType: 'tool', tool: step.tool, args, stepIndex: i, ...result };

          if (shouldReview(step)) {
            for (let retryRound = 0; retryRound <= maxStepReviewAttempts; retryRound++) {
              const srPrompt = buildStepReviewPrompt({ task, step, result, history: observations, systemPrompt });
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
                history: observations,
                systemPrompt,
              });
              const retryText = await callPrompt('doer', retryPrompt);
              yield { type: 'prompt_usage', text: retryText };
              const retryParsed = parseResponse(retryText);
              if (retryParsed.type === 'tool_call') {
                args = retryParsed.payload.args;
              }
              result = await runTool(step.tool, args);
              observations.push({ type: 'observation', stepType: 'tool', tool: step.tool, args, result, retry: retryRound + 1 });
              yield { type: 'observation', stepType: 'tool', tool: step.tool, args, ...result };
            }

            if (restartExecution) break;
          }
        } else if (step.type === 'reason') {
          yield { type: 'step_started', stepIndex: i, step: { type: 'reason' } };
          const reasonPrompt = buildReasonPrompt({ task, step, history: observations, systemPrompt });
          let reasonText = await callPrompt('doer', reasonPrompt);
          yield { type: 'prompt_usage', text: reasonText };
          observations.push({ type: 'observation', stepType: 'reason', text: reasonText });
          yield { type: 'observation', stepType: 'reason', text: reasonText, stepIndex: i };

          if (shouldReview(step)) {
            for (let retryRound = 0; retryRound <= maxStepReviewAttempts; retryRound++) {
              const srPrompt = buildStepReviewPrompt({
                task, step, result: { text: reasonText }, history: observations, systemPrompt,
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
                history: observations,
                systemPrompt,
              });
              reasonText = await callPrompt('doer', retryPrompt);
              yield { type: 'prompt_usage', text: reasonText };
              observations.push({ type: 'observation', stepType: 'reason', text: reasonText, retry: retryRound + 1 });
              yield { type: 'observation', stepType: 'reason', text: reasonText };
            }

            if (restartExecution) break;
          }
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
