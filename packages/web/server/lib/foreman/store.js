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

export const FOREMAN_FILE_NAME = 'foreman.json';
const FOREMAN_STATE_VERSION = 2;

const JOB_STATUSES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'];
const TASK_STATUSES = ['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled'];
const RUN_STATUSES = ['queued', 'running', 'waiting_for_user', 'failed', 'completed', 'cancelled'];
const ATTENTION_TYPES = ['permission', 'question', 'conflict'];

const RUN_TERMINAL_STATUSES = new Set(['failed', 'completed', 'cancelled']);
/** Where a Run's attempt went wrong: finding the workspace, making the
 * session, handing it the task, or during the work itself. */
const RUN_ERROR_STAGES = ['workspace', 'session', 'dispatch', 'execution'];
/** The only execution kind today. A Run is an attempt; an OpenCode session is
 * one way to carry it out, so the reference names its kind. */
const EXECUTION_TYPES = ['opencode-session'];

const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;

export class ForemanStoreError extends Error {
  /**
   * @param {'invalid_input' | 'not_found' | 'unsupported_version' | 'conflict' | 'abort_failed'} code
   * @param {string} message
   */
  constructor(code, message) {
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

const createJobSchema = z.object({ title, goal: optionalText, directory: optionalText }).strict();
const jobPatchSchema = z.object({ title: title.optional(), goal: clearableText, status: z.enum(JOB_STATUSES).optional() }).strict();
const createTaskSchema = z.object({ title, instructions: optionalText }).strict();
const taskPatchSchema = z.object({
  title: title.optional(),
  instructions: clearableText,
  status: z.enum(TASK_STATUSES).optional(),
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

const parse = (schema, value) => {
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
  id: z.string(),
  title: z.string(),
  goal: z.string().optional(),
  directory: z.string().optional(),
  status: z.enum(JOB_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const storedTaskSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  title: z.string(),
  instructions: z.string().optional(),
  status: z.enum(TASK_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const executionSchema = z.object({
  type: z.enum(EXECUTION_TYPES),
  /** Absent while the session is being created: a start is in progress. */
  id: z.string().min(1).optional(),
  directory: z.string().optional(),
  createdAt: timestamp,
  /** Set when OpenCode no longer has the session; the reference stays for the record. */
  deletedAt: timestamp.optional(),
});
const runErrorSchema = z.object({ stage: z.enum(RUN_ERROR_STAGES), message: z.string() });
const storedRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
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
});
export const foremanFileSchema = z.object({
  version: z.literal(FOREMAN_STATE_VERSION),
  jobs: z.array(storedJobSchema),
  tasks: z.array(storedTaskSchema),
  runs: z.array(storedRunSchema),
});
/**
 * Version 1 kept an optional bare `sessionId` on a run. It becomes an
 * execution reference; nothing else changed.
 */
const storedRunV1Schema = storedRunSchema.omit({ error: true, execution: true, requestId: true }).extend({
  sessionId: z.string().optional(),
});
const foremanFileV1Schema = z.object({
  version: z.literal(1),
  jobs: z.array(storedJobSchema),
  tasks: z.array(storedTaskSchema),
  runs: z.array(storedRunV1Schema),
});
const migrateV1 = (v1) => ({
  version: FOREMAN_STATE_VERSION,
  jobs: v1.jobs,
  tasks: v1.tasks,
  runs: v1.runs.map(({ sessionId, ...run }) => (sessionId
    ? { ...run, execution: { type: 'opencode-session', id: sessionId, createdAt: run.createdAt } }
    : run)),
});
/** Only the version, to tell "written by a newer OpenChamber" from "unreadable". */
const versionedFileSchema = z.object({ version: z.number().finite() });

const emptyState = () => ({ version: FOREMAN_STATE_VERSION, jobs: [], tasks: [], runs: [] });

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 * @param {() => string} [options.randomUUID]
 * @param {(message: string) => void} [options.warn]
 */
export const createForemanStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
  randomUUID = () => cryptoDefault.randomUUID(),
  warn = (message) => console.warn(message),
}) => {
  const filePath = path.join(dataDir, FOREMAN_FILE_NAME);

  /** @type {{ version: number, jobs: object[], tasks: object[], runs: object[] } | null} */
  let state = null;
  /** Set when the file on disk was written by a newer OpenChamber. */
  let unsupportedVersion = null;
  let loadPromise = null;
  /** One mutation at a time, so two writes cannot interleave their renames. */
  let queue = Promise.resolve();

  const readFile = async () => {
    try {
      return await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  };

  const load = async () => {
    const raw = await readFile();
    if (raw === null) {
      state = emptyState();
      return;
    }
    let parsed;
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
    // Converted in memory only; the file is rewritten as v2 on the next
    // mutation, so a read alone never changes what is on disk.
    const v1 = foremanFileV1Schema.safeParse(parsed);
    if (v1.success) {
      state = migrateV1(v1.data);
      return;
    }
    // Unreadable: keep the bytes for the person to look at, start empty. The
    // backup is the rollback; nothing is overwritten until the next mutation.
    const backup = `${filePath}.corrupt-${now()}`;
    await fsPromises.rename(filePath, backup).catch(() => undefined);
    warn(`Foreman state at ${filePath} was unreadable and was moved to ${backup}`);
    state = emptyState();
  };

  const ensureLoaded = async () => {
    if (state) return;
    if (!loadPromise) {
      loadPromise = load().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    await loadPromise;
  };

  const assertWritable = () => {
    if (unsupportedVersion !== null) {
      throw new ForemanStoreError(
        'unsupported_version',
        `Foreman state was written by a newer OpenChamber (version ${unsupportedVersion}); update to use it`,
      );
    }
  };

  const persist = async () => {
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
  const mutate = (change) => {
    const run = async () => {
      await ensureLoaded();
      assertWritable();
      const previous = state;
      state = { ...previous, jobs: [...previous.jobs], tasks: [...previous.tasks], runs: [...previous.runs] };
      try {
        const result = change(state);
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

  const clone = (value) => JSON.parse(JSON.stringify(value));

  /**
   * A run's status and everything that must agree with it. Attention exists
   * only while waiting for a person, an error only while failed, a finish
   * time only while finished: leaving the state clears what described it.
   */
  const applyRunStatus = (run, status, at) => {
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

  const findOrThrow = (list, id, kind) => {
    const index = list.findIndex((entry) => entry.id === id);
    if (index < 0) throw new ForemanStoreError('not_found', `${kind} ${id} does not exist`);
    return index;
  };

  return {
    /** The whole state, for the client to render. Never a partial read. */
    async snapshot() {
      await ensureLoaded();
      assertWritable();
      return clone(state);
    },

    async createJob(input) {
      const { title, goal, directory } = parse(createJobSchema, input);
      return mutate((draft) => {
        const at = now();
        const job = { id: randomUUID(), title, status: 'pending', createdAt: at, updatedAt: at };
        if (goal) job.goal = goal;
        if (directory) job.directory = directory;
        draft.jobs.push(job);
        return clone(job);
      });
    },

    async updateJob(jobId, patch) {
      const { title, goal, status } = parse(jobPatchSchema, patch);
      return mutate((draft) => {
        const index = findOrThrow(draft.jobs, jobId, 'job');
        const job = { ...draft.jobs[index], updatedAt: now() };
        if (title !== undefined) job.title = title;
        if (goal === null) delete job.goal;
        else if (goal !== undefined) job.goal = goal;
        if (status !== undefined) job.status = status;
        draft.jobs[index] = job;
        return clone(job);
      });
    },

    async createTask(jobId, input) {
      const { title, instructions } = parse(createTaskSchema, input);
      return mutate((draft) => {
        findOrThrow(draft.jobs, jobId, 'job');
        const at = now();
        const task = { id: randomUUID(), jobId, title, status: 'pending', createdAt: at, updatedAt: at };
        if (instructions) task.instructions = instructions;
        draft.tasks.push(task);
        return clone(task);
      });
    },

    async updateTask(taskId, patch) {
      const { title, instructions, status } = parse(taskPatchSchema, patch);
      return mutate((draft) => {
        const index = findOrThrow(draft.tasks, taskId, 'task');
        const task = { ...draft.tasks[index], updatedAt: now() };
        if (title !== undefined) task.title = title;
        if (instructions === null) delete task.instructions;
        else if (instructions !== undefined) task.instructions = instructions;
        if (status !== undefined) task.status = status;
        draft.tasks[index] = task;
        return clone(task);
      });
    },

    async createRun(taskId, input = {}) {
      const { requestId } = parse(createRunSchema, input);
      return mutate((draft) => {
        findOrThrow(draft.tasks, taskId, 'task');
        if (requestId) {
          const existing = draft.runs.find((entry) => entry.taskId === taskId && entry.requestId === requestId);
          if (existing) return clone(existing);
        }
        const at = now();
        const run = { id: randomUUID(), taskId, status: 'queued', createdAt: at, updatedAt: at };
        if (requestId) run.requestId = requestId;
        draft.runs.push(run);
        return clone(run);
      });
    },

    /** The run, its task and its job, read together. */
    async runContext(runId) {
      await ensureLoaded();
      assertWritable();
      const run = state.runs.find((entry) => entry.id === runId);
      if (!run) throw new ForemanStoreError('not_found', `run ${runId} does not exist`);
      const task = state.tasks.find((entry) => entry.id === run.taskId) ?? null;
      const job = task ? state.jobs.find((entry) => entry.id === task.jobId) ?? null : null;
      return clone({ run, task, job });
    },

    /** Runs whose execution is the given session. */
    async runsForExecution(type, id) {
      await ensureLoaded();
      if (unsupportedVersion !== null) return [];
      return clone(state.runs.filter((run) => run.execution?.type === type && run.execution.id === id));
    },

    /** Runs that own an execution and have not finished, for reconciliation. */
    async activeExecutions() {
      await ensureLoaded();
      if (unsupportedVersion !== null) return [];
      return clone(state.runs.filter((run) => run.execution?.id && !RUN_TERMINAL_STATUSES.has(run.status)));
    },

    /**
     * The execution side's single write path: `change` receives a copy of the
     * run and returns the fields to set (`status`, `attention`, `error`,
     * `execution`), or null to leave the run alone. Everything the status
     * implies is applied by `applyRunStatus`, so the invariants hold here too.
     */
    async applyExecutionChange(runId, change) {
      return mutate((draft) => {
        const index = findOrThrow(draft.runs, runId, 'run');
        const current = draft.runs[index];
        const next = change(clone(current));
        if (!next) return { run: clone(current), changed: false };
        const at = now();
        const run = { ...current, updatedAt: at };
        if (next.stoppedAt !== undefined) run.stoppedAt = next.stoppedAt;
        if (next.execution === null) delete run.execution;
        else if (next.execution !== undefined) run.execution = next.execution;
        if (next.status !== undefined) applyRunStatus(run, next.status, at);
        if (next.attention !== undefined && run.status === 'waiting_for_user') run.attention = next.attention;
        if (next.error !== undefined && run.status === 'failed') run.error = next.error;
        draft.runs[index] = run;
        return { run: clone(run), changed: true };
      });
    },

    async updateRun(runId, patch) {
      const { status, attention } = parse(runPatchSchema, patch);
      return mutate((draft) => {
        const index = findOrThrow(draft.runs, runId, 'run');
        // Once a run owns an execution, its status follows that execution;
        // a hand-written status would be contradicted by the next event.
        if (draft.runs[index].execution) {
          throw new ForemanStoreError('conflict', 'This run is executing; its status follows the session');
        }
        const at = now();
        const run = { ...draft.runs[index], updatedAt: at };
        if (status !== undefined) applyRunStatus(run, status, at);
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
