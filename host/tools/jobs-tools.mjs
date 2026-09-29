// host/tools/jobs-tools.mjs
import * as z from 'zod/v4';

export const jobTools = [
  {
    name: 'submit-task',
    description: 'Submit a task for asynchronous execution by this agent. Returns a job id; poll it with job-status. Use for work that may take more than a minute.',
    inputSchema: z.object({
      goal: z.string().min(1).describe('Natural-language description of the task'),
      inputs: z.record(z.string(), z.any()).optional().describe('Structured inputs for the task'),
      callbackUrl: z.string().url().optional().describe('HTTPS URL to POST the settled event to'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
    reversible: true, timeout: 10_000, retryable: false, tags: ['jobs'],
    async run({ args, jobs }) {
      const { callbackUrl, ...task } = args;
      return jobs.submit(task, { callbackUrl, metadata: { via: 'mcp' } });
    },
  },
  {
    // Answering is not itself a mutation, so `reversible: true`. Marking it
    // otherwise would mean an approval that needs its own approval.
    name: 'job-input',
    description: 'Answer the question a paused job is waiting on. Pass the batch id it is waiting for and one value per field.',
    inputSchema: z.object({
      jobId: z.string().min(1),
      batchId: z.string().min(1).describe('The batch id the job is waiting on, from its pendingInput'),
      answers: z.record(z.string(), z.any()).describe('One value per question fieldId'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
    reversible: true, timeout: 10_000, retryable: false, tags: ['jobs'],
    async run({ args, jobs, identity = null }) {
      if (typeof jobs?.provideInput !== 'function') {
        return { ok: false, error: 'not_supported', message: 'this jobs backend does not support human input' };
      }
      const { jobId, ...submission } = args;
      return jobs.provideInput(jobId, submission, { identity });
    },
  },
  {
    name: 'job-status',
    description: 'Return the current record for a job submitted with submit-task: status, progress, and the result once finished.',
    inputSchema: z.object({ jobId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    reversible: true, timeout: 10_000, retryable: true, tags: ['jobs'],
    async run({ args, jobs }) {
      return (await jobs.get(args.jobId)) ?? { ok: false, error: 'not_found', jobId: args.jobId };
    },
  },
];
