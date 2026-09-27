import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  foremanStateSchema,
  jobSchema,
  runSchema,
  taskSchema,
  type CreateJobInput,
  type CreateRunInput,
  type CreateTaskInput,
  type ForemanState,
  type Job,
  type JobPatch,
  type Run,
  type RunPatch,
  type Task,
  type TaskPatch,
} from './model';

/**
 * The client of `/api/foreman/*`. Every answer is parsed into the model
 * before anything else sees it, and a failed request is an error — never an
 * empty state a caller could mistake for "no jobs".
 */

class ForemanApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'ForemanApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ForemanApi {
  fetchState: () => Promise<ForemanState>;
  createJob: (input: CreateJobInput) => Promise<Job>;
  updateJob: (jobId: string, patch: JobPatch) => Promise<Job>;
  createTask: (jobId: string, input: CreateTaskInput) => Promise<Task>;
  updateTask: (taskId: string, patch: TaskPatch) => Promise<Task>;
  createRun: (taskId: string, input: CreateRunInput) => Promise<Run>;
  updateRun: (runId: string, patch: RunPatch) => Promise<Run>;
}

const errorPayloadSchema = z.object({ error: z.string(), code: z.string().optional() });

const request = async <T>(path: string, schema: z.ZodType<T>, init?: { method: string; body: object }): Promise<T> => {
  const response = await runtimeFetch(path, init
    ? { method: init.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
    : undefined);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new ForemanApiError(
      response.status,
      failure.success ? failure.data.error : `Foreman request failed (${response.status})`,
      failure.success ? failure.data.code ?? null : null,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ForemanApiError(response.status, `Foreman answered with an unexpected shape for ${path}`);
  }
  return parsed.data;
};

const encode = encodeURIComponent;

export const foremanApi: ForemanApi = {
  fetchState: () => request('/api/foreman/state', foremanStateSchema),
  createJob: (input) => request('/api/foreman/jobs', jobSchema, { method: 'POST', body: input }),
  updateJob: (jobId, patch) => request(`/api/foreman/jobs/${encode(jobId)}`, jobSchema, { method: 'PATCH', body: patch }),
  createTask: (jobId, input) => request(`/api/foreman/jobs/${encode(jobId)}/tasks`, taskSchema, { method: 'POST', body: input }),
  updateTask: (taskId, patch) => request(`/api/foreman/tasks/${encode(taskId)}`, taskSchema, { method: 'PATCH', body: patch }),
  createRun: (taskId, input) => request(`/api/foreman/tasks/${encode(taskId)}/runs`, runSchema, { method: 'POST', body: input }),
  updateRun: (runId, patch) => request(`/api/foreman/runs/${encode(runId)}`, runSchema, { method: 'PATCH', body: patch }),
};
