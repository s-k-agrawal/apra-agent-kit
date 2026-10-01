// host/jobs/interface.mjs
//
// Every jobs backend implements:
//   async start()
//   async stop({ drainMs })
//   async submit(task, { callbackUrl, metadata }) → { jobId, status: 'queued', position }
//   async get(jobId)                               → JobRecord | null
//   async cancel(jobId)                            → { ok, status }
//   subscribe(jobId, onEvent)                      → unsubscribe()
//   async events(jobId, { afterSeq })              → JobEvent[] (each with seq)
//   stats()                                        → { queued, processing, capacity, maxQueueSize }
//
// A backend that supports durable human input also implements:
//   async pendingInput(jobId)                      → Batch & { stale, expired } | null
//   async provideInput(jobId, submission, { identity })
//                                                  → { ok: true, status, stale, batchId }
//                                                  | { ok: false, code, status, ... }
//   async expireInput(jobId)                       → { ok, status?, code? }
//
// These are optional so a backend built before the feature, or one an adopter
// wrote themselves, keeps satisfying `assertJobsBackend`. The routes check for
// them rather than assuming.
export const HUMAN_INPUT_METHODS = ['pendingInput', 'provideInput', 'expireInput'];

export function supportsHumanInput(backend) {
  return HUMAN_INPUT_METHODS.every(m => typeof backend?.[m] === 'function');
}

export class JobQueueFullError extends Error {
  constructor(message = 'job queue is full; retry later') { super(message); this.name = 'JobQueueFullError'; }
}
export class JobsClosedError extends Error {
  constructor(message = 'jobs backend is shutting down') { super(message); this.name = 'JobsClosedError'; }
}
export class InvalidCallbackUrlError extends Error {
  constructor(message) { super(message); this.name = 'InvalidCallbackUrlError'; }
}
export class IllegalTransitionError extends Error {
  constructor(from, to) { super(`illegal job transition ${from} → ${to}`); this.name = 'IllegalTransitionError'; }
}

const REQUIRED = ['start', 'stop', 'submit', 'get', 'cancel', 'subscribe', 'events', 'stats'];

export function assertJobsBackend(obj) {
  const missing = REQUIRED.filter(k => typeof obj?.[k] !== 'function');
  if (missing.length) throw new Error(`jobs backend missing: ${missing.join(', ')}`);
  return obj;
}

export function validateCallbackUrl(url, { allowHttp = false } = {}) {
  if (url === undefined || url === null || url === '') return null;
  let parsed;
  try { parsed = new URL(String(url)); } catch {
    throw new InvalidCallbackUrlError(`callbackUrl is not a valid URL: ${String(url)}`);
  }
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol === 'http:' && allowHttp) return parsed.toString();
  throw new InvalidCallbackUrlError(
    `callbackUrl must use https (got ${parsed.protocol}); set notify.webhook.allowHttp for development`,
  );
}
