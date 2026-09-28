import { z } from 'zod';

/**
 * Foreman's domain, as the client sees it. The server (`packages/web/server/
 * lib/foreman`) owns ids, timestamps and the rules; this file is the trusted
 * shape everything in the UI reads, produced by parsing what the server sent.
 *
 * Job — the durable unit of work a person asked for (what outcome).
 * Task — a piece of that work.
 * Run — one attempt to perform a Task. A Task tried twice has two Runs.
 *
 * A Run's `status` is its current state and nothing else. `attention` says
 * why a person is needed and exists only while the status is
 * `waiting_for_user`; the server clears it on any other status.
 */

const JOB_STATUSES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
const TASK_STATUSES = ['pending', 'ready', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'] as const;
const RUN_STATUSES = ['queued', 'running', 'waiting_for_user', 'failed', 'completed', 'cancelled'] as const;
const ATTENTION_TYPES = ['permission', 'question', 'conflict'] as const;
export const RUN_ACTIVITY_TYPES = ['run_started', 'session_created', 'status_changed', 'attention_required', 'attention_resolved', 'progress', 'validation', 'run_completed', 'run_failed', 'run_cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunActivityType = (typeof RUN_ACTIVITY_TYPES)[number];
export type TaskBlockingReason = 'dependency_incomplete' | 'dependency_failed';

export const MEMORY_SCOPES = ['workspace', 'job'] as const;
export const MEMORY_TYPES = ['architecture', 'decision', 'convention', 'important_file', 'known_issue', 'fact'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];

const timestamp = z.number().finite();

export const jobSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  goal: z.string().optional(),
  /** The workspace the work happens in, by the path sessions also use. */
  directory: z.string().optional(),
  maxParallelTasks: z.number().int().min(1).max(10).default(3),
  status: z.enum(JOB_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const taskSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  title: z.string(),
  instructions: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  blockedByTaskIds: z.array(z.string()).optional(),
  blockingReason: z.enum(['dependency_incomplete', 'dependency_failed']).optional(),
  currentRunId: z.string().optional(),
  workspace: z.object({ kind: z.enum(['git-worktree', 'shared-directory']), directory: z.string(), createdAt: timestamp }).optional(),
  status: z.enum(TASK_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const runAttentionSchema = z.object({
  type: z.enum(ATTENTION_TYPES),
  message: z.string().optional(),
});

const RUN_ERROR_STAGES = ['workspace', 'session', 'dispatch', 'execution'] as const;

/** Why a failed run failed, and at which step. Present only while failed. */
const runErrorSchema = z.object({
  stage: z.enum(RUN_ERROR_STAGES),
  message: z.string(),
});

/**
 * How the run is carried out. Today always an OpenCode session: the run
 * points at it, the session knows nothing of the run. No `id` means a start
 * is in progress.
 */
const runExecutionSchema = z.object({
  type: z.literal('opencode-session'),
  id: z.string().min(1).optional(),
  directory: z.string().optional(),
  createdAt: timestamp,
  /** OpenCode no longer has the session; the reference stays for the record. */
  deletedAt: timestamp.optional(),
});

export const runSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  attention: runAttentionSchema.optional(),
  error: runErrorSchema.optional(),
  execution: runExecutionSchema.optional(),
  /** A person stopped this run through Foreman; the stop is final. */
  stoppedAt: timestamp.optional(),
  requestId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
});

export const runActivitySchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.enum(RUN_ACTIVITY_TYPES),
  message: z.string().min(1),
  timestamp: timestamp,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const foremanMemorySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES),
  workspaceId: z.string().min(1),
  jobId: z.string().min(1).optional(),
  type: z.enum(MEMORY_TYPES),
  content: z.string().min(1),
  tags: z.array(z.string()),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastVerifiedAt: timestamp,
}).superRefine((entry, context) => {
  if (entry.scope === 'job' && !entry.jobId) {
    context.addIssue({ code: 'custom', path: ['jobId'], message: 'jobId is required for job memory' });
  }
  if (entry.scope === 'workspace' && entry.jobId) {
    context.addIssue({ code: 'custom', path: ['jobId'], message: 'workspace memory cannot belong to a job' });
  }
});

export const foremanStateSchema = z.object({
  version: z.literal(2),
  globalConcurrency: z.number().int().min(1).max(32).default(3),
  jobs: z.array(jobSchema),
  tasks: z.array(taskSchema),
  runs: z.array(runSchema),
});

export type Job = z.infer<typeof jobSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunActivity = z.infer<typeof runActivitySchema>;
export type ForemanMemory = z.infer<typeof foremanMemorySchema>;
export type RunAttention = z.infer<typeof runAttentionSchema>;
export type RunError = z.infer<typeof runErrorSchema>;
export type ForemanState = z.infer<typeof foremanStateSchema>;

export interface CreateJobInput {
  title: string;
  goal?: string;
  directory?: string;
  maxParallelTasks?: number;
}

export interface CreateTaskInput {
  title: string;
  instructions?: string;
  dependsOn?: string[];
}

export interface CreateRunInput {
  /** Makes a retried create land once. */
  requestId?: string;
}

export const startRunResultSchema = z.object({ run: runSchema, alreadyStarted: z.boolean() });
export type StartRunResult = z.infer<typeof startRunResultSchema>;

export const stopRunResultSchema = z.object({ run: runSchema, stopped: z.boolean() });
export type StopRunResult = z.infer<typeof stopRunResultSchema>;

export interface JobPatch {
  title?: string;
  goal?: string | null;
  status?: JobStatus;
  maxParallelTasks?: number;
}

export interface TaskPatch {
  title?: string;
  instructions?: string | null;
  status?: TaskStatus;
  dependsOn?: string[];
}

export interface RunPatch {
  status?: RunStatus;
  attention?: RunAttention | null;
}

export interface CreateRunActivityInput {
  type: RunActivityType;
  message: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface CreateForemanMemoryInput {
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  tags: string[];
  source?: string;
  confidence?: number;
}

export interface ForemanMemoryPatch {
  type?: MemoryType;
  content?: string;
  tags?: string[];
  source?: string;
  confidence?: number;
}

export const tasksForJob = (tasks: readonly Task[], jobId: string): Task[] =>
  tasks.filter((task) => task.jobId === jobId);

export const runsForTask = (runs: readonly Run[], taskId: string): Run[] =>
  runs.filter((run) => run.taskId === taskId);
