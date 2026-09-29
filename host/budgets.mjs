// host/budgets.mjs

const DEFAULT_PRICING = {
  inputPer1k: 0.003,
  outputPer1k: 0.015,
};

/**
 * @param {object} config
 * @param {object} [restoreFrom] a `snapshot()` taken before a pause. Elapsed
 *   time and token totals continue from it, so a run that waited two days on a
 *   person does not resume already over its timeout.
 */
export function createBudgets(config = {}, restoreFrom = null) {
  const pricing = config.pricing ?? DEFAULT_PRICING;

  let iterations = restoreFrom?.iterations ?? 0;
  let totalInputTokens = restoreFrom?.totalInputTokens ?? 0;
  let totalOutputTokens = restoreFrom?.totalOutputTokens ?? 0;

  // Elapsed time is the tricky one. It is tracked as "time accumulated before
  // the current running span" plus "time since that span began", so that
  // pausing simply banks the current span and stops the clock.
  //
  // The alternative — a start timestamp and a running total of paused time —
  // is equivalent but needs both to be restored correctly, and gets one of
  // them wrong the first time somebody resumes across a restart.
  let accumulatedMs = restoreFrom?.elapsedMs ?? 0;
  let spanStart = Date.now();
  let pausedAt = null;

  function elapsed() {
    if (pausedAt !== null) return accumulatedMs;
    return accumulatedMs + (Date.now() - spanStart);
  }

  function record(usage = {}) {
    iterations++;
    if (typeof usage.inputTokens === 'number') {
      totalInputTokens += usage.inputTokens;
    }
    if (typeof usage.outputTokens === 'number') {
      totalOutputTokens += usage.outputTokens;
    } else if (typeof usage.responseChars === 'number') {
      totalOutputTokens += Math.ceil(usage.responseChars / 4);
    }
  }

  /**
   * Stop the clock. Time spent waiting on a person is not time the run spent
   * working, and charging it against `timeoutMs` would mean any question asked
   * near the end of a budget guarantees a timeout on resume — punishing the
   * run for having asked.
   *
   * Idempotent: pausing an already-paused budget is a no-op, not a reset.
   */
  function pause() {
    if (pausedAt !== null) return;
    accumulatedMs += Date.now() - spanStart;
    pausedAt = Date.now();
  }

  /** Start the clock again. Idempotent on a running budget. */
  function resume() {
    if (pausedAt === null) return;
    pausedAt = null;
    spanStart = Date.now();
  }

  function paused() {
    return pausedAt !== null;
  }

  function snapshot() {
    const totalTokens = totalInputTokens + totalOutputTokens;
    const estimatedCostUsd =
      (totalInputTokens / 1000) * pricing.inputPer1k +
      (totalOutputTokens / 1000) * pricing.outputPer1k;
    return {
      iterations,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCostUsd,
      elapsedMs: elapsed(),
    };
  }

  function check() {
    if (typeof config.maxIterations === 'number' && iterations >= config.maxIterations) {
      return { ok: false, reason: 'max_iterations', limit: config.maxIterations, actual: iterations };
    }
    const totalTokens = totalInputTokens + totalOutputTokens;
    if (typeof config.maxTokens === 'number' && totalTokens >= config.maxTokens) {
      return { ok: false, reason: 'max_tokens', limit: config.maxTokens, actual: totalTokens };
    }
    if (typeof config.maxCostUsd === 'number') {
      const cost =
        (totalInputTokens / 1000) * pricing.inputPer1k +
        (totalOutputTokens / 1000) * pricing.outputPer1k;
      if (cost > config.maxCostUsd) {
        return { ok: false, reason: 'max_cost', limit: config.maxCostUsd, actual: cost };
      }
    }
    if (typeof config.timeoutMs === 'number') {
      const ms = elapsed();
      if (ms >= config.timeoutMs) {
        return { ok: false, reason: 'timeout', limit: config.timeoutMs, actual: ms };
      }
    }
    return { ok: true };
  }

  return { check, record, snapshot, pause, resume, paused };
}
