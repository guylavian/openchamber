/**
 * Foreman domain store: Job → Task → Run.
 *
 * A Job is the durable unit of work a person asked for. A Task is a piece of
 * that work. A Run is one attempt to perform a Task. The three are kept apart
 * on purpose: a Task that failed once and succeeded on the second attempt has
 * two Runs and one Task, and the Job says what the whole thing was for.
 *
 * Execution state is the current state, nothing else. `status` on a Run says
 * what the Run is doing now; `attention` says why it needs a person and is
 * only ever present while the status is `waiting_for_user`. Leaving that
 * status clears it, so a stale "blocked" can never outlive the block.
 *
 * Persistence is one JSON file per OpenChamber data dir, written whole and
 * atomically (temp file, then rename), one mutation at a time. The file
 * carries a `version`; a file from a newer OpenChamber is left untouched and
 * every operation reports it, rather than being rewritten into an older shape.
 * No file at all is the normal state for someone who has never used Foreman.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import cryptoDefault from 'node:crypto';
import { z } from 'zod';

import type { Attention, ForemanErrorCode, JobId, MemoryId, RunId, SessionId, TaskId } from './types.js';

export const FOREMAN_FILE_NAME = 'foreman.json';
const FOREMAN_STATE_VERSION = 5;
const FOREMAN_PUBLIC_STATE_VERSION = 2;

const JOB_STATUSES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
const TASK_STATUSES = ['pending', 'ready', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'] as const;
const RUN_STATUSES = ['queued', 'running', 'waiting_for_user', 'failed', 'completed', 'cancelled'] as const;
const ATTENTION_TYPES = ['permission', 'question', 'conflict'] as const;
const ACTIVITY_TYPES = ['run_started', 'session_created', 'status_changed', 'attention_required', 'attention_resolved', 'progress', 'validation', 'run_completed', 'run_failed', 'run_cancelled'] as const;

const RUN_TERMINAL_STATUSES = new Set<string>(['failed', 'completed', 'cancelled']);
const MEMORY_SCOPES = ['workspace', 'job'] as const;
const MEMORY_TYPES = ['architecture', 'decision', 'convention', 'important_file', 'known_issue', 'fact'] as const;
/** Where a Run's attempt went wrong: finding the workspace, making the
 * session, handing it the task, or during the work itself. */
const RUN_ERROR_STAGES = ['workspace', 'session', 'dispatch', 'execution'] as const;
/** The only execution kind today. A Run is an attempt; an OpenCode session is
 * one way to carry it out, so the reference names its kind. */
const EXECUTION_TYPES = ['opencode-session'] as const;

const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;
const MAX_MEMORY_CONTENT_LENGTH = 6_000;
const MAX_MEMORY_TAGS = 20;
const MAX_ACTIVITY_MESSAGE_LENGTH = 500;
const MAX_ACTIVITY_PER_RUN = 200;
const DEFAULT_JOB_PARALLELISM = 3;
const MAX_JOB_PARALLELISM = 10;

export class ForemanStoreError extends Error {
  // Declared, not a class field: no emitted field, so the instance's own keys
  // stay in the JavaScript order (message, name, code).
  declare code: ForemanErrorCode;

  /**
   * @param {'invalid_input' | 'not_found' | 'unsupported_version' | 'conflict' | 'abort_failed'} code
   * @param {string} message
   */
  constructor(code: ForemanErrorCode, message: string) {
    super(message);
    this.name = 'ForemanStoreError';
    this.code = code;
  }
}

// Requests are parsed here, once, into the domain's own vocabulary. Optional
// text arrives as absent, empty or null: absent leaves a field alone, empty
// and null clear it.
const title = z.string().trim().min(1, 'title is required').max(MAX_TITLE_LENGTH);
const optionalText = z.string().trim().max(MAX_TEXT_LENGTH).transform((value) => value || undefined).optional();
const clearableText = z.string().trim().max(MAX_TEXT_LENGTH).transform((value) => value || null).nullable().optional();

const attentionSchema = z.object({
  type: z.enum(ATTENTION_TYPES),
  message: optionalText,
}).strict();

const createJobSchema = z.object({ title, goal: optionalText, directory: optionalText, maxParallelTasks: z.number().int().min(1).max(MAX_JOB_PARALLELISM).default(DEFAULT_JOB_PARALLELISM) }).strict();
const jobPatchSchema = z.object({ title: title.optional(), goal: clearableText, status: z.enum(JOB_STATUSES).optional(), maxParallelTasks: z.number().int().min(1).max(MAX_JOB_PARALLELISM).optional() }).strict();
const dependencyIds = z.array(z.string().trim().min(1).brand<'TaskId'>()).max(100).default([]).refine((ids) => new Set(ids).size === ids.length, 'dependencies must not contain duplicates');
const createTaskSchema = z.object({ title, instructions: optionalText, dependsOn: dependencyIds }).strict();
const taskPatchSchema = z.object({
  title: title.optional(),
  instructions: clearableText,
  dependsOn: dependencyIds.optional(),
}).strict();
// `requestId` makes a retried create land once: the same (task, requestId)
// answers with the run the first request made.
const createRunSchema = z.object({
  requestId: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
}).strict();
const runPatchSchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  attention: attentionSchema.nullable().optional(),
}).strict();
const activityEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).brand<'RunId'>(),
  type: z.enum(ACTIVITY_TYPES),
  message: z.string().trim().min(1).max(MAX_ACTIVITY_MESSAGE_LENGTH),
  timestamp: z.number().finite(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();
const createActivitySchema = activityEventSchema.omit({ id: true, runId: true, timestamp: true });
const memoryTags = z.array(z.string().trim().min(1).max(100)).max(MAX_MEMORY_TAGS)
  .transform((tags) => [...new Set(tags)]);
const memorySchema = z.object({
  id: z.string().min(1).brand<'MemoryId'>(),
  scope: z.enum(MEMORY_SCOPES),
  workspaceId: z.string().trim().min(1).max(4_096),
  jobId: z.string().min(1).brand<'JobId'>().optional(),
  type: z.enum(MEMORY_TYPES),
  content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_LENGTH),
  tags: memoryTags,
  source: z.string().trim().min(1).max(300),
  confidence: z.number().finite().min(0).max(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  lastVerifiedAt: z.number().finite(),
}).strict().superRefine((entry, context) => {
  if (entry.scope === 'job' && !entry.jobId) {
    context.addIssue({ code: 'custom', path: ['jobId'], message: 'jobId is required for job memory' });
  }
  if (entry.scope === 'workspace' && entry.jobId) {
    context.addIssue({ code: 'custom', path: ['jobId'], message: 'workspace memory cannot belong to a job' });
  }
});
const createMemorySchema = z.object({
  scope: z.enum(MEMORY_SCOPES),
  type: z.enum(MEMORY_TYPES),
  content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_LENGTH),
  tags: memoryTags.default([]),
  source: z.string().trim().min(1).max(300).default('user'),
  confidence: z.number().finite().min(0).max(1).default(0.8),
}).strict();
const updateMemorySchema = z.object({
  type: z.enum(MEMORY_TYPES).optional(),
  content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_LENGTH).optional(),
  tags: memoryTags.optional(),
  source: z.string().trim().min(1).max(300).optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'at least one memory field is required');

const parse = <Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
  throw new ForemanStoreError('invalid_input', `${where}${issue?.message ?? 'invalid input'}`);
};

// What comes back from disk. A file that fails is the whole file failing:
// the store does not guess at partial data.
const timestamp = z.number().finite();
const storedJobSchema = z.object({
  id: z.string().brand<'JobId'>(),
  title: z.string(),
  goal: z.string().optional(),
  directory: z.string().optional(),
  status: z.enum(JOB_STATUSES),
  maxParallelTasks: z.number().int().min(1).max(MAX_JOB_PARALLELISM).default(DEFAULT_JOB_PARALLELISM),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const storedTaskSchema = z.object({
  id: z.string().brand<'TaskId'>(),
  jobId: z.string().brand<'JobId'>(),
  title: z.string(),
  instructions: z.string().optional(),
  dependsOn: dependencyIds,
  workspace: z.object({ kind: z.enum(['git-worktree', 'shared-directory']), directory: z.string().min(1), createdAt: timestamp }).strict().optional(),
  status: z.enum(TASK_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const executionSchema = z.object({
  type: z.enum(EXECUTION_TYPES),
  /** Absent while the session is being created: a start is in progress. */
  id: z.string().min(1).brand<'SessionId'>().optional(),
  directory: z.string().optional(),
  createdAt: timestamp,
  /** Set when OpenCode no longer has the session; the reference stays for the record. */
  deletedAt: timestamp.optional(),
});
const runErrorSchema = z.object({ stage: z.enum(RUN_ERROR_STAGES), message: z.string() });
const storedRunSchema = z.object({
  id: z.string().brand<'RunId'>(),
  taskId: z.string().brand<'TaskId'>(),
  status: z.enum(RUN_STATUSES),
  attention: attentionSchema.optional(),
  error: runErrorSchema.optional(),
  execution: executionSchema.optional(),
  /** Set when a person stopped the run through Foreman; the stop is final. */
  stoppedAt: timestamp.optional(),
  requestId: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  activity: z.array(activityEventSchema).max(MAX_ACTIVITY_PER_RUN).default([]),
});
export const foremanFileSchema = z.object({
  version: z.literal(FOREMAN_STATE_VERSION),
  jobs: z.array(storedJobSchema),
  tasks: z.array(storedTaskSchema),
  runs: z.array(storedRunSchema),
  memories: z.array(memorySchema),
});
/**
 * Version 1 kept an optional bare `sessionId` on a run. It becomes an
 * execution reference; nothing else changed.
 */
const storedRunV1Schema = storedRunSchema.omit({ error: true, execution: true, requestId: true }).extend({
  sessionId: z.string().brand<'SessionId'>().optional(),
});
const foremanFileV1Schema = z.object({
  version: z.literal(1),
  jobs: z.array(storedJobSchema.omit({ maxParallelTasks: true })),
  tasks: z.array(storedTaskSchema.omit({ dependsOn: true, workspace: true })),
  runs: z.array(storedRunV1Schema),
});
const foremanFileV2Schema = z.object({
  version: z.literal(2),
  jobs: z.array(storedJobSchema.omit({ maxParallelTasks: true })),
  tasks: z.array(storedTaskSchema.omit({ dependsOn: true, workspace: true })),
  runs: z.array(storedRunSchema),
});
const foremanFileV3Schema = z.object({
  version: z.literal(3),
  jobs: z.array(storedJobSchema.omit({ maxParallelTasks: true })),
  tasks: z.array(storedTaskSchema.omit({ dependsOn: true, workspace: true })),
  runs: z.array(storedRunSchema.omit({ activity: true })),
  memories: z.array(memorySchema),
});
const foremanFileV4Schema = z.object({
  version: z.literal(4),
  jobs: z.array(storedJobSchema),
  tasks: z.array(storedTaskSchema.omit({ dependsOn: true, workspace: true })),
  runs: z.array(storedRunSchema),
  memories: z.array(memorySchema),
});
export type ForemanState = z.output<typeof foremanFileSchema>;
/** What the execution side asks `applyExecutionChange` to set on a run. */
export interface ExecutionChange {
  status?: Run['status'];
  attention?: Attention;
  error?: NonNullable<Run['error']>;
  execution?: NonNullable<Run['execution']> | null;
  stoppedAt?: number;
  activityEvent?: { type: Run['activity'][number]['type']; message: string; metadata?: Run['activity'][number]['metadata'] };
}
export type Job = ForemanState['jobs'][number];
export type Task = ForemanState['tasks'][number];
export type Run = ForemanState['runs'][number];
export type Memory = ForemanState['memories'][number];
export type ActivityEvent = Run['activity'][number];
export type TaskWorkspace = NonNullable<Task['workspace']>;
export type RunStatus = Run['status'];
export type TaskStatus = Task['status'];
type ActivityType = ActivityEvent['type'];
/** A task as the client sees it: its status derived from its runs and dependencies. */
export type DerivedTask = Task & {
  currentRunId: RunId | undefined;
  blockedByTaskIds?: string[];
  blockingReason?: 'dependency_failed' | 'dependency_incomplete';
};
type ActivityMetadata = ActivityEvent['metadata'];
type StoredTaskV1 = z.output<typeof foremanFileV1Schema>['tasks'][number];

const upgradeTasks = (tasks: StoredTaskV1[]): Task[] => tasks.map((task) => ({ ...task, dependsOn: [], workspace: undefined }));
const migrateV1 = (v1: z.output<typeof foremanFileV1Schema>): ForemanState => ({
  version: FOREMAN_STATE_VERSION,
  jobs: v1.jobs.map((job) => ({ ...job, maxParallelTasks: DEFAULT_JOB_PARALLELISM })),
  tasks: upgradeTasks(v1.tasks),
  runs: v1.runs.map(({ sessionId, ...run }) => (sessionId
    ? { ...run, execution: { type: 'opencode-session' as const, id: sessionId, createdAt: run.createdAt } }
    : run)).map((run) => ({ ...run, activity: [] })),
  memories: [],
});
const migrateV2 = (v2: z.output<typeof foremanFileV2Schema>): ForemanState => ({ ...v2, version: FOREMAN_STATE_VERSION, jobs: v2.jobs.map((job) => ({ ...job, maxParallelTasks: DEFAULT_JOB_PARALLELISM })), tasks: upgradeTasks(v2.tasks), runs: v2.runs.map((run) => ({ ...run, activity: [] })), memories: [] });
const migrateV3 = (v3: z.output<typeof foremanFileV3Schema>): ForemanState => ({ ...v3, version: FOREMAN_STATE_VERSION, tasks: upgradeTasks(v3.tasks), runs: v3.runs.map((run) => ({ ...run, activity: [] })), jobs: v3.jobs.map((job) => ({ ...job, maxParallelTasks: DEFAULT_JOB_PARALLELISM })) });
const migrateV4 = (v4: z.output<typeof foremanFileV4Schema>): ForemanState => ({ ...v4, version: FOREMAN_STATE_VERSION, tasks: upgradeTasks(v4.tasks), jobs: v4.jobs.map((job) => ({ ...job, maxParallelTasks: job.maxParallelTasks ?? DEFAULT_JOB_PARALLELISM })) });
/** Only the version, to tell "written by a newer OpenChamber" from "unreadable". */
const versionedFileSchema = z.object({ version: z.number().finite() });

const emptyState = (): ForemanState => ({ version: FOREMAN_STATE_VERSION, jobs: [], tasks: [], runs: [], memories: [] });
const activityMessageForStatus = (status: string, detail?: { type?: string; message?: string | undefined } | null): string => {
  if (status === 'running') return 'Run is running';
  if (status === 'waiting_for_user') return detail?.type === 'permission' ? 'Waiting for permission' : 'Waiting for your response';
  if (status === 'completed') return 'Run completed';
  if (status === 'failed') return detail?.message ? `Run failed: ${detail.message.slice(0, 300)}` : 'Run failed';
  if (status === 'cancelled') return 'Run cancelled';
  return `Run status changed to ${status}`;
};
const appendActivity = (run: Run, type: ActivityType, message: string, timestamp: number, metadata?: ActivityMetadata): ActivityEvent | null => {
  run.activity ??= [];
  const duplicate = type === 'run_started'
    ? run.activity.some((entry) => entry.type === type)
    : run.activity[run.activity.length - 1]?.type === type && run.activity[run.activity.length - 1]?.message === message;
  if (duplicate) return null;
  const event: ActivityEvent = { id: cryptoDefault.randomUUID(), runId: run.id, type, message, timestamp };
  if (metadata && Object.keys(metadata).length > 0) event.metadata = metadata;
  if (run.activity.length >= MAX_ACTIVITY_PER_RUN) run.activity.shift();
  run.activity.push(event);
  return event;
};
const appendStatusActivity = (run: Run, status: string, message: string, timestamp: number): ActivityEvent | null => {
  const previous = run.activity[run.activity.length - 1];
  if (status === 'running' && previous?.type === 'session_created') return null;
  if (status === 'running' && previous?.type === 'attention_resolved') return null;
  return appendActivity(run, 'status_changed', message, timestamp);
};
const latestRunByTask = (runs: readonly Run[]): Map<string, Run> => {
  const latest = new Map<string, Run>();
  for (const run of runs) latest.set(run.taskId, run);
  return latest;
};
const derivedTasks = (tasks: readonly Task[], runs: readonly Run[]): DerivedTask[] => {
  const latestRuns = latestRunByTask(runs);
  const base = new Map(tasks.map((task): [string, { status: string; run: Run | undefined }] => {
    const run = latestRuns.get(task.id);
    const status = run
      ? run.status === 'waiting_for_user' ? 'waiting'
        : run.status === 'running' || (run.status === 'queued' && run.execution) ? 'running'
          : run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' ? run.status
            : task.dependsOn.length ? 'pending' : 'ready'
      : task.status === 'pending' && task.dependsOn.length === 0 ? 'ready' : task.status;
    return [task.id, { status, run }];
  }));
  return tasks.map((task) => {
    const current = base.get(task.id)!;
    if (current.status === 'running' || current.status === 'waiting' || current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      return { ...task, status: current.status as TaskStatus, currentRunId: current.run?.id };
    }
    const blockedByTaskIds = task.dependsOn.filter((id) => base.get(id)?.status !== 'completed');
    if (blockedByTaskIds.length) {
      const failedDependency = blockedByTaskIds.some((id) => (['failed', 'cancelled'] as (string | undefined)[]).includes(base.get(id)?.status));
      return { ...task, status: 'blocked' as const, blockedByTaskIds, blockingReason: failedDependency ? 'dependency_failed' as const : 'dependency_incomplete' as const, currentRunId: current.run?.id };
    }
    return { ...task, status: 'ready' as const, currentRunId: current.run?.id };
  });
};
const validateDependencies = (tasks: readonly Task[], taskId: string, jobId: string, dependsOn: readonly string[]): void => {
  const allById = new Map(tasks.map((task): [string, Task] => [task.id, task]));
  for (const dependencyId of dependsOn) {
    const dependency = allById.get(dependencyId);
    if (dependencyId === taskId) throw new ForemanStoreError('invalid_input', 'A task cannot depend on itself');
    if (!dependency || dependency.jobId !== jobId) throw new ForemanStoreError('invalid_input', `Dependency task ${dependencyId} does not exist in this Job`);
  }
  const edges = new Map(tasks.map((task): [string, readonly string[]] => [task.id, task.id === taskId ? dependsOn : task.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ForemanStoreError('invalid_input', 'Task dependencies cannot contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of edges.get(id) ?? []) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
};
const MEMORY_STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'and', 'are', 'because', 'before', 'been', 'being', 'but', 'can', 'could', 'does', 'from', 'have', 'into', 'more', 'only', 'other', 'should', 'some', 'such', 'that', 'their', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'using', 'was', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would']);
const memoryTerms = (value: string): Set<string> => new Set(
  value.toLowerCase().split(/[^a-z0-9_./-]+/).filter((term) => term.length >= 3 && !MEMORY_STOP_WORDS.has(term)),
);
const scoreMemory = (entry: Memory, query: string, queryTerms: ReadonlySet<string>): number => {
  const content = entry.content.toLowerCase();
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  let score = 0;
  for (const term of queryTerms) {
    if (tags.some((tag) => tag === term || tag.includes(term))) score += 4;
    else if (content.includes(term)) score += term.includes('/') ? 5 : 1;
  }
  // Full path mentions are stronger evidence than words that happen to overlap.
  for (const path of [...tags, ...(content.match(/(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+/g) ?? [])]) {
    if (path.length >= 5 && query.includes(path)) score += 8;
  }
  return score;
};

export interface ForemanStoreOptions {
  dataDir: string;
  globalConcurrency?: number;
  fsPromises?: typeof fsDefault.promises;
  path?: typeof pathDefault;
  now?: () => number;
  randomUUID?: () => string;
  warn?: (message: string) => void;
}

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {number} [options.globalConcurrency] Effective global Task Run cap for the UI.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 * @param {() => string} [options.randomUUID]
 * @param {(message: string) => void} [options.warn]
 */
export const createForemanStore = ({
  dataDir,
  globalConcurrency = 3,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
  randomUUID = () => cryptoDefault.randomUUID(),
  warn = (message) => console.warn(message),
}: ForemanStoreOptions) => {
  const filePath = path.join(dataDir, FOREMAN_FILE_NAME);

  /** @type {{ version: number, jobs: object[], tasks: object[], runs: object[], memories: object[] } | null} */
  let state: ForemanState | null = null;
  /** Set when the file on disk was written by a newer OpenChamber. */
  let unsupportedVersion: number | null = null;
  let loadPromise: Promise<void> | null = null;
  /** One mutation at a time, so two writes cannot interleave their renames. */
  let queue: Promise<unknown> = Promise.resolve();

  const readFile = async (): Promise<string | null> => {
    try {
      return await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && (error as { code?: unknown }).code === 'ENOENT') return null;
      throw error;
    }
  };

  const load = async (): Promise<void> => {
    const raw = await readFile();
    if (raw === null) {
      state = emptyState();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const versioned = versionedFileSchema.safeParse(parsed);
    if (versioned.success && versioned.data.version > FOREMAN_STATE_VERSION) {
      unsupportedVersion = versioned.data.version;
      state = emptyState();
      return;
    }
    const stored = foremanFileSchema.safeParse(parsed);
    if (stored.success) {
      state = stored.data;
      return;
    }
    // Converted in memory only; the file is rewritten as v5 on the next
    // mutation, so a read alone never changes what is on disk.
    const v1 = foremanFileV1Schema.safeParse(parsed);
    if (v1.success) {
      state = migrateV1(v1.data);
      return;
    }
    const v2 = foremanFileV2Schema.safeParse(parsed);
    if (v2.success) {
      state = migrateV2(v2.data);
      return;
    }
    const v3 = foremanFileV3Schema.safeParse(parsed);
    if (v3.success) {
      state = migrateV3(v3.data);
      return;
    }
    const v4 = foremanFileV4Schema.safeParse(parsed);
    if (v4.success) {
      state = migrateV4(v4.data);
      return;
    }
    // Unreadable: keep the bytes for the person to look at, start empty. The
    // backup is the rollback; nothing is overwritten until the next mutation.
    const backup = `${filePath}.corrupt-${now()}`;
    await fsPromises.rename(filePath, backup).catch(() => undefined);
    warn(`Foreman state at ${filePath} was unreadable and was moved to ${backup}`);
    state = emptyState();
  };

  const ensureLoaded = async (): Promise<void> => {
    if (state) return;
    if (!loadPromise) {
      loadPromise = load().catch((error: unknown) => {
        loadPromise = null;
        throw error;
      });
    }
    await loadPromise;
  };

  const assertWritable = (): void => {
    if (unsupportedVersion !== null) {
      throw new ForemanStoreError(
        'unsupported_version',
        `Foreman state was written by a newer OpenChamber (version ${unsupportedVersion}); update to use it`,
      );
    }
  };

  const persist = async (): Promise<void> => {
    await fsPromises.mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
      await fsPromises.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    } catch (error) {
      await fsPromises.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  };

  /**
   * Runs one mutation against the in-memory state and persists the result.
   * A failed write restores the previous state, so memory never claims what
   * disk does not hold.
   */
  const mutate = <Result>(change: (draft: ForemanState) => Result | Promise<Result>): Promise<Result> => {
    const run = async (): Promise<Result> => {
      await ensureLoaded();
      assertWritable();
      const previous = state!;
      state = { ...previous, jobs: [...previous.jobs], tasks: [...previous.tasks], runs: [...previous.runs], memories: [...previous.memories] };
      try {
        const result = await change(state);
        await persist();
        return result;
      } catch (error) {
        state = previous;
        throw error;
      }
    };
    const pending = queue.then(run, run);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

  /**
   * A run's status and everything that must agree with it. Attention exists
   * only while waiting for a person, an error only while failed, a finish
   * time only while finished: leaving the state clears what described it.
   */
  const applyRunStatus = (run: Run, status: RunStatus, at: number): void => {
    run.status = status;
    if (status === 'running' && run.startedAt === undefined) run.startedAt = at;
    if (RUN_TERMINAL_STATUSES.has(status)) {
      if (run.finishedAt === undefined) run.finishedAt = at;
    } else {
      delete run.finishedAt;
    }
    if (status !== 'waiting_for_user') delete run.attention;
    if (status !== 'failed') delete run.error;
  };

  const findOrThrow = (list: readonly { id: string }[], id: string, kind: string): number => {
    const index = list.findIndex((entry) => entry.id === id);
    if (index < 0) throw new ForemanStoreError('not_found', `${kind} ${id} does not exist`);
    return index;
  };

  return {
    /** The whole state, for the client to render. Never a partial read. */
    async snapshot() {
      await ensureLoaded();
      assertWritable();
      return clone({ version: FOREMAN_PUBLIC_STATE_VERSION, globalConcurrency, jobs: state!.jobs, tasks: derivedTasks(state!.tasks, state!.runs), runs: state!.runs });
    },

    async jobContext(jobId: JobId) {
      await ensureLoaded();
      assertWritable();
      const job = state!.jobs.find((entry) => entry.id === jobId);
      if (!job) throw new ForemanStoreError('not_found', `job ${jobId} does not exist`);
      return clone({ job });
    },

    async listMemoriesForJob(jobId: JobId, workspaceId: string) {
      await ensureLoaded();
      assertWritable();
      const job = state!.jobs.find((entry) => entry.id === jobId);
      if (!job) throw new ForemanStoreError('not_found', `job ${jobId} does not exist`);
      return clone(state!.memories.filter((entry) => entry.workspaceId === workspaceId
        && (entry.scope === 'workspace' || (entry.scope === 'job' && entry.jobId === jobId))));
    },

    async createMemory(jobId: JobId, workspaceId: string, input: unknown) {
      const parsed = parse(createMemorySchema, input);
      return mutate((draft) => {
        const job = draft.jobs.find((entry) => entry.id === jobId);
        if (!job) throw new ForemanStoreError('not_found', `job ${jobId} does not exist`);
        if (!job.directory) throw new ForemanStoreError('invalid_input', 'This job has no workspace directory');
        if (job.directory !== workspaceId) throw new ForemanStoreError('invalid_input', 'Workspace does not match the job directory');
        const at = now();
        const entry: Memory = {
          id: randomUUID() as MemoryId,
          scope: parsed.scope,
          workspaceId,
          ...(parsed.scope === 'job' ? { jobId } : {}),
          type: parsed.type,
          content: parsed.content,
          tags: parsed.tags,
          source: parsed.source,
          confidence: parsed.confidence,
          createdAt: at,
          updatedAt: at,
          lastVerifiedAt: at,
        };
        draft.memories.push(entry);
        return clone(entry);
      });
    },

    async updateMemory(memoryId: MemoryId, patch: unknown) {
      const parsed = parse(updateMemorySchema, patch);
      return mutate((draft) => {
        const index = findOrThrow(draft.memories, memoryId, 'memory');
        const at = now();
        const entry = { ...draft.memories[index]!, ...parsed, updatedAt: at, lastVerifiedAt: at } as Memory;
        draft.memories[index] = entry;
        return clone(entry);
      });
    },

    async deleteRun(runId: RunId) {
      return mutate((draft) => {
        const index = findOrThrow(draft.runs, runId, 'run');
        const [run] = draft.runs.splice(index, 1);
        return clone(run);
      });
    },

    async deleteMemory(memoryId: MemoryId) {
      return mutate((draft) => {
        const index = findOrThrow(draft.memories, memoryId, 'memory');
        const [entry] = draft.memories.splice(index, 1);
        return clone(entry);
      });
    },

    async relevantMemories({ jobId, workspaceId, query, limit = 8 }: { jobId: JobId; workspaceId: string; query: unknown; limit?: number }) {
      await ensureLoaded();
      assertWritable();
      const queryText = typeof query === 'string' ? query.toLowerCase() : '';
      const queryTerms = memoryTerms(queryText);
      if (queryTerms.size === 0) return [];
      const boundedLimit = Math.max(0, Math.min(12, Math.floor(limit)));
      const ranked = state!.memories
        .filter((entry) => entry.workspaceId === workspaceId
          && (entry.scope === 'workspace' || (entry.scope === 'job' && entry.jobId === jobId)))
        .map((entry) => ({ entry, score: scoreMemory(entry, queryText, queryTerms) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score
          || right.entry.confidence - left.entry.confidence
          || right.entry.lastVerifiedAt - left.entry.lastVerifiedAt);
      return clone(ranked.slice(0, boundedLimit).map(({ entry }) => entry));
    },

    async createJob(input: unknown) {
      const { title, goal, directory, maxParallelTasks } = parse(createJobSchema, input);
      return mutate((draft) => {
        const at = now();
        const job: Job = { id: randomUUID() as JobId, title, status: 'pending', maxParallelTasks, createdAt: at, updatedAt: at };
        if (goal) job.goal = goal;
        if (directory) job.directory = directory;
        draft.jobs.push(job);
        return clone(job);
      });
    },

    async updateJob(jobId: JobId, patch: unknown) {
      const { title, goal, status, maxParallelTasks } = parse(jobPatchSchema, patch);
      return mutate((draft) => {
        const index = findOrThrow(draft.jobs, jobId, 'job');
        const job = { ...draft.jobs[index]!, updatedAt: now() };
        if (title !== undefined) job.title = title;
        if (goal === null) delete job.goal;
        else if (goal !== undefined) job.goal = goal;
        if (status !== undefined) job.status = status;
        if (maxParallelTasks !== undefined) job.maxParallelTasks = maxParallelTasks;
        draft.jobs[index] = job;
        return clone(job);
      });
    },

    async deleteTask(taskId: TaskId, cleanupWorkspace: (task: Task) => Promise<void> = async () => {}) {
      return mutate(async (draft) => {
        const index = findOrThrow(draft.tasks, taskId, 'task');
        if (draft.runs.some((run) => run.taskId === taskId && ['queued', 'running', 'waiting_for_user'].includes(run.status))) {
          throw new ForemanStoreError('conflict', 'Stop the active Run before deleting this Task');
        }
        await cleanupWorkspace(clone(draft.tasks[index]!));
        const [task] = draft.tasks.splice(index, 1);
        draft.runs = draft.runs.filter((run) => run.taskId !== taskId);
        for (const dependent of draft.tasks) {
          if (dependent.dependsOn.includes(taskId)) dependent.dependsOn = dependent.dependsOn.filter((id) => id !== taskId);
        }
        return clone(task);
      });
    },

    async deleteJob(jobId: JobId, cleanupWorkspace: (task: Task) => Promise<void> = async () => {}) {
      return mutate(async (draft) => {
        const index = findOrThrow(draft.jobs, jobId, 'job');
        const tasks = draft.tasks.filter((task) => task.jobId === jobId);
        const taskIds = new Set(tasks.map((task) => task.id));
        if (draft.runs.some((run) => taskIds.has(run.taskId) && ['queued', 'running', 'waiting_for_user'].includes(run.status))) {
          throw new ForemanStoreError('conflict', 'Stop all active Runs before deleting this Job');
        }
        for (const task of tasks) await cleanupWorkspace(clone(task));
        const [job] = draft.jobs.splice(index, 1);
        draft.tasks = draft.tasks.filter((task) => task.jobId !== jobId);
        draft.runs = draft.runs.filter((run) => !taskIds.has(run.taskId));
        draft.memories = draft.memories.filter((entry) => entry.scope !== 'job' || entry.jobId !== jobId);
        for (const task of draft.tasks) task.dependsOn = task.dependsOn.filter((id) => !taskIds.has(id));
        return clone(job);
      });
    },

    async createTask(jobId: JobId, input: unknown) {
      const { title, instructions, dependsOn } = parse(createTaskSchema, input);
      return mutate((draft) => {
        findOrThrow(draft.jobs, jobId, 'job');
        const at = now();
        const task = { id: randomUUID() as TaskId, jobId, title, status: 'pending', createdAt: at, updatedAt: at } as Task;
        if (instructions) task.instructions = instructions;
        task.dependsOn = dependsOn;
        validateDependencies(draft.tasks, task.id, jobId, dependsOn);
        draft.tasks.push(task);
        return clone(derivedTasks(draft.tasks, draft.runs).find((entry) => entry.id === task.id));
      });
    },

    async updateTask(taskId: TaskId, patch: unknown) {
        const { title, instructions, dependsOn } = parse(taskPatchSchema, patch);
      return mutate((draft) => {
        const index = findOrThrow(draft.tasks, taskId, 'task');
        const task = { ...draft.tasks[index]!, updatedAt: now() };
        if (dependsOn !== undefined) validateDependencies(draft.tasks, taskId, task.jobId, dependsOn);
        if (title !== undefined) task.title = title;
        if (instructions === null) delete task.instructions;
        else if (instructions !== undefined) task.instructions = instructions;
        if (dependsOn !== undefined) task.dependsOn = dependsOn;
        draft.tasks[index] = task;
        return clone(derivedTasks(draft.tasks, draft.runs).find((entry) => entry.id === task.id));
      });
    },

    async createRun(taskId: TaskId, input: unknown = {}) {
      const { requestId } = parse(createRunSchema, input);
      return mutate((draft) => {
        findOrThrow(draft.tasks, taskId, 'task');
        if (requestId) {
          const existing = draft.runs.find((entry) => entry.taskId === taskId && entry.requestId === requestId);
          if (existing) return clone(existing);
        }
        if (draft.runs.some((entry) => entry.taskId === taskId && ['queued', 'running', 'waiting_for_user'].includes(entry.status))) {
          throw new ForemanStoreError('conflict', 'This Task already has an active Run');
        }
        const dependencyStates = derivedTasks(draft.tasks, draft.runs);
        const dependenciesReady = draft.tasks.find((entry) => entry.id === taskId)!.dependsOn
          .every((dependencyId) => dependencyStates.find((entry) => entry.id === dependencyId)?.status === 'completed');
        if (!dependenciesReady) throw new ForemanStoreError('conflict', 'This Task is waiting for its dependencies');
        const completedRuns = draft.runs.filter((entry) => entry.taskId === taskId && entry.status === 'completed');
        const latestCompletedRun = completedRuns.at(-1);
        const latestRun = latestRunByTask(draft.runs).get(taskId);
        if (latestCompletedRun && latestRun?.status === 'completed') {
          throw new ForemanStoreError('conflict', 'This Task is already completed');
        }
        const at = now();
        const run = { id: randomUUID() as RunId, taskId, status: 'queued', createdAt: at, updatedAt: at } as Run;
        if (requestId) run.requestId = requestId;
        draft.runs.push(run);
        return clone(run);
      });
    },

    /** The run, its task and its job, read together. */
    async runContext(runId: RunId) {
      await ensureLoaded();
      assertWritable();
      const run = state!.runs.find((entry) => entry.id === runId);
      if (!run) throw new ForemanStoreError('not_found', `run ${runId} does not exist`);
      const task = derivedTasks(state!.tasks, state!.runs).find((entry) => entry.id === run.taskId) ?? null;
      const job = task ? state!.jobs.find((entry) => entry.id === task.jobId) ?? null : null;
      return clone({ run, task, job });
    },

    async taskContext(taskId: TaskId) {
      await ensureLoaded();
      assertWritable();
      const task = state!.tasks.find((entry) => entry.id === taskId);
      if (!task) throw new ForemanStoreError('not_found', `task ${taskId} does not exist`);
      const job = state!.jobs.find((entry) => entry.id === task.jobId) ?? null;
      const latestRun = latestRunByTask(state!.runs).get(taskId) ?? null;
      return clone({ task: derivedTasks(state!.tasks, state!.runs).find((entry) => entry.id === taskId), job, latestRun });
    },

    async setTaskWorkspace(taskId: TaskId, workspace: TaskWorkspace) {
      return mutate((draft) => {
        const index = findOrThrow(draft.tasks, taskId, 'task');
        const existing = draft.tasks[index]!.workspace;
        if (existing) {
          if (existing.kind !== workspace.kind || existing.directory !== workspace.directory) throw new ForemanStoreError('conflict', 'This Task already has a different workspace');
          return clone(draft.tasks[index]);
        }
        draft.tasks[index] = { ...draft.tasks[index]!, workspace, updatedAt: now() };
        return clone(draft.tasks[index]);
      });
    },

    async activityForRun(runId: RunId) {
      await ensureLoaded();
      assertWritable();
      const run = state!.runs.find((entry) => entry.id === runId);
      if (!run) throw new ForemanStoreError('not_found', `run ${runId} does not exist`);
      return clone(run.activity ?? []);
    },

    /** Runs whose execution is the given session. */
    async runsForExecution(type: string, id: SessionId) {
      await ensureLoaded();
      if (unsupportedVersion !== null) return [];
      return clone(state!.runs.filter((run) => run.execution?.type === type && run.execution.id === id));
    },

    /** Runs that own an execution and have not finished, for reconciliation. */
    async activeExecutions() {
      await ensureLoaded();
      if (unsupportedVersion !== null) return [];
      return clone(state!.runs.filter((run) => run.execution?.id && !RUN_TERMINAL_STATUSES.has(run.status)));
    },

    /**
     * The execution side's single write path: `change` receives a copy of the
     * run and returns the fields to set (`status`, `attention`, `error`,
     * `execution`, `stoppedAt`), or null to leave the run alone. Everything the status
     * implies is applied by `applyRunStatus`, so the invariants hold here too.
     */
    async applyExecutionChange(runId: RunId, change: (run: Run) => ExecutionChange | null | undefined | false) {
      return mutate((draft) => {
        const index = findOrThrow(draft.runs, runId, 'run');
        const current = draft.runs[index]!;
        const next = change(clone(current));
        if (!next) return { run: clone(current), changed: false };
        const at = now();
        const run = { ...current, updatedAt: at };
        run.activity = [...(current.activity ?? [])];
        if (next.stoppedAt !== undefined) run.stoppedAt = next.stoppedAt;
        if (next.execution === null) delete run.execution;
        else if (next.execution !== undefined) run.execution = next.execution;
        if (next.status !== undefined) {
          const previousStatus = run.status;
          const previousAttention = run.attention;
          applyRunStatus(run, next.status, at);
          const previousTerminal = RUN_TERMINAL_STATUSES.has(previousStatus);
          const nextTerminal = RUN_TERMINAL_STATUSES.has(next.status);
          if (next.status === 'waiting_for_user' && previousStatus !== 'waiting_for_user') {
            appendActivity(run, 'attention_required', activityMessageForStatus(next.status, next.attention), at);
          } else if (previousStatus === 'waiting_for_user' && next.status !== 'waiting_for_user') {
            appendActivity(run, 'attention_resolved', previousAttention?.type === 'permission' ? 'Permission resolved' : 'Question resolved', at);
          }
          const redundantRunning = next.status === 'running' && (
            RUN_TERMINAL_STATUSES.has(previousStatus)
            || (previousStatus === 'queued' && !current.execution?.id)
            || previousStatus === 'waiting_for_user'
          );
          if (previousStatus !== next.status && !nextTerminal && next.status !== 'waiting_for_user' && !redundantRunning) {
            appendStatusActivity(run, next.status, activityMessageForStatus(next.status), at);
          }
          if (!previousTerminal && nextTerminal) {
            const terminalType = next.status === 'completed' ? 'run_completed' : next.status === 'failed' ? 'run_failed' : 'run_cancelled';
            appendActivity(run, terminalType, activityMessageForStatus(next.status, next.error), at);
          }
        }
        if (next.attention !== undefined && run.status === 'waiting_for_user') run.attention = next.attention;
        if (next.error !== undefined && run.status === 'failed') run.error = next.error;
        if (next.activityEvent) appendActivity(run, next.activityEvent.type, next.activityEvent.message, at, next.activityEvent.metadata);
        draft.runs[index] = run;
        return { run: clone(run), changed: true };
      });
    },

    async addRunActivity(runId: RunId, input: unknown) {
      const parsed = parse(createActivitySchema, input);
      return mutate((draft) => {
        const index = findOrThrow(draft.runs, runId, 'run');
        const run = { ...draft.runs[index]!, activity: [...(draft.runs[index]!.activity ?? [])] };
        const event = appendActivity(run, parsed.type, parsed.message, now(), parsed.metadata);
        if (event === null) return null;
        run.updatedAt = event.timestamp;
        draft.runs[index] = run;
        return clone(event);
      });
    },

    async updateRun(runId: RunId, patch: unknown) {
      const { status, attention } = parse(runPatchSchema, patch);
      return mutate((draft) => {
        const index = findOrThrow(draft.runs, runId, 'run');
        // Once a run owns an execution, its status follows that execution;
        // a hand-written status would be contradicted by the next event.
        if (draft.runs[index]!.execution) {
          throw new ForemanStoreError('conflict', 'This run is executing; its status follows the session');
        }
        const at = now();
        const run = { ...draft.runs[index]!, updatedAt: at };
        run.activity = [...(run.activity ?? [])];
        if (status !== undefined) {
          const previousStatus = run.status;
          const previousAttention = run.attention;
          applyRunStatus(run, status, at);
          if (status === 'waiting_for_user' && previousStatus !== 'waiting_for_user') appendActivity(run, 'attention_required', activityMessageForStatus(status, attention), at);
          else if (previousStatus === 'waiting_for_user' && status !== 'waiting_for_user') appendActivity(run, 'attention_resolved', previousAttention?.type === 'permission' ? 'Permission resolved' : 'Question resolved', at);
          if (previousStatus !== status && status !== 'waiting_for_user' && !RUN_TERMINAL_STATUSES.has(status)
            && !(status === 'running' && (RUN_TERMINAL_STATUSES.has(previousStatus) || previousStatus === 'waiting_for_user'))) appendStatusActivity(run, status, activityMessageForStatus(status), at);
          if (!RUN_TERMINAL_STATUSES.has(previousStatus) && RUN_TERMINAL_STATUSES.has(status)) appendActivity(run, status === 'completed' ? 'run_completed' : status === 'failed' ? 'run_failed' : 'run_cancelled', activityMessageForStatus(status), at);
        }
        if (attention === null) delete run.attention;
        else if (attention !== undefined) {
          if (run.status !== 'waiting_for_user') {
            throw new ForemanStoreError('invalid_input', 'attention can only be set while status is waiting_for_user');
          }
          run.attention = attention;
        }
        // The invariant: no attention outside waiting_for_user, ever.
        if (run.status !== 'waiting_for_user') delete run.attention;
        draft.runs[index] = run;
        return clone(run);
      });
    },
  };
};

export type ForemanStore = ReturnType<typeof createForemanStore>;
