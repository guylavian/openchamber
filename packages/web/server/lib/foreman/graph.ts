/**
 * Foreman dependency graph: which tasks may start now, and why the rest do not.
 *
 * A task's status is never written by hand. It is computed here from two facts
 * — the task's own runs, and the status of the tasks it depends on — so the
 * scheduler and the UI cannot disagree about what is ready. The store
 * recomputes every job's statuses inside each mutation and persists them, so a
 * restart shows the workflow as it actually is.
 *
 * The statuses:
 *
 *   running    an attempt of this task has not finished
 *   completed  its latest finished attempt completed
 *   failed     its latest finished attempt failed, nothing blocks it
 *   cancelled  a person stopped it
 *   waiting    a dependency has not completed, or has failed
 *   ready      nothing blocks it, it can start now
 *   pending    nothing blocks it, but the job is not running its workflow yet
 *
 * `ready` and `pending` are the same thing with a different question asked:
 * `ready` means "start me", `pending` means "not part of a live workflow yet",
 * which is how a freshly created job reads before anything starts.
 *
 * A dependency that failed blocks like an unfinished one. That is the point of
 * the distinction: a task whose dependency failed waits, and a successful retry
 * of that dependency releases it without anything else changing.
 */

import type { JobStatus, RunStatus, TaskStatus } from './types.js';

type GraphTask = { id: string; jobId: string; title: string; dependsOn: string[] };
type GraphRun = { id: string; taskId: string; status: RunStatus };
type GraphJob = { id: string; status: JobStatus; startMode?: string };
type GraphState = { jobs: GraphJob[]; tasks: GraphTask[]; runs: GraphRun[] };
type TaskGraphCounts = Record<'total' | TaskStatus, number>;
type DependencyProblem = { taskId: string; dependencyId: string; kind: 'self' | 'missing' };
type GraphResult = {
  statuses: Map<string, TaskStatus>;
  reasons: Map<string, string>;
  ready: GraphTask[];
  active: GraphTask[];
  cyclic: string[];
  counts: TaskGraphCounts;
};

/** A run that has not finished and still holds the task. */
const ACTIVE_RUN_STATUSES = new Set<RunStatus>(['queued', 'running', 'waiting_for_user']);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['completed', 'failed', 'cancelled']);

/** Task statuses that mean "this task will not run again as it is". */
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

const titleOf = (task: Pick<GraphTask, 'title'> | null | undefined): string => task?.title.trim() ?? '';

const labelOf = (task: Pick<GraphTask, 'title'> | null, fallbackId: string): string => titleOf(task) || `Task ${fallbackId}`;

/**
 * Orders a job's tasks so every task comes after the ones it depends on.
 * Dependencies that are missing, or that point outside this job, are left
 * alone: they are reported as blockers rather than silently dropped, so a
 * dangling reference shows up in the UI instead of letting a task start.
 *
 * A cycle cannot be written through the store, but a hand-edited or migrated
 * file can carry one. Its members are collected instead of thrown away, and the
 * caller keeps them waiting so the file still loads.
 *
 * @returns {{ order: object[], cyclic: string[] }}
 */
const topologicalOrder = (tasks: readonly GraphTask[]): { order: GraphTask[]; cyclic: string[] } => {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: GraphTask[] = [];
  const cyclic = new Set<string>();

  const visit = (taskId: string): void => {
    const current = state.get(taskId);
    if (current === 'done') return;
    if (current === 'visiting') {
      // Everything on the path that got us here is part of the cycle.
      cyclic.add(taskId);
      return;
    }
    state.set(taskId, 'visiting');
    const task = tasksById.get(taskId);
    for (const dependencyId of task?.dependsOn ?? []) {
      if (!tasksById.has(dependencyId)) continue; // reported as a blocker
      if (state.get(dependencyId) === 'visiting') cyclic.add(dependencyId);
      visit(dependencyId);
    }
    state.set(taskId, 'done');
    if (task) order.push(task);
  };

  for (const task of tasks) {
    if (state.get(task.id) !== 'done') visit(task.id);
  }
  return { order, cyclic: [...cyclic] };
};

/**
 * The tasks blocking one task, split by why. A missing or cross-job dependency
 * counts as unfinished: an unreadable reference must not read as satisfied.
 */
type DependencyBlocker = { id: string; task: GraphTask | null };
const blockersFor = (
  task: GraphTask,
  tasksById: ReadonlyMap<string, GraphTask>,
  statuses: ReadonlyMap<string, TaskStatus>,
): { failed: DependencyBlocker[]; incomplete: DependencyBlocker[] } => {
  const failed: DependencyBlocker[] = [];
  const incomplete: DependencyBlocker[] = [];
  for (const dependencyId of task.dependsOn) {
    const dependency = tasksById.get(dependencyId);
    const status = dependency ? statuses.get(dependencyId) : undefined;
    // The id travels with the task: a missing dependency has no title, and
    // the reason still has to name what the task is waiting on.
    const entry = { id: dependencyId, task: dependency ?? null };
    if (status === 'completed') continue;
    if (status === 'failed' || status === 'cancelled') failed.push(entry);
    else incomplete.push(entry);
  }
  return { failed, incomplete };
};

/**
 * Why a task is waiting, in the words the job view shows. Derived, never
 * stored: the answer changes the moment a dependency settles, and a stored
 * string would go stale without anyone touching it.
 */
const waitReasonFor = (
  task: GraphTask,
  tasksById: ReadonlyMap<string, GraphTask>,
  statuses: ReadonlyMap<string, TaskStatus>,
  reason: 'cycle' | null,
): string | null => {
  const { failed, incomplete } = blockersFor(task, tasksById, statuses);
  const names = (entries: DependencyBlocker[]): string[] => entries.map((entry) => labelOf(entry.task, entry.id)).filter(Boolean);
  if (failed.length > 0) {
    const failedNames = names(failed);
    return reason === 'cycle'
      ? `Waiting on a dependency cycle${failedNames.length ? ` (${failedNames.join(', ')})` : ''}`
      : `Dependency failed${failedNames.length ? `: ${failedNames.join(', ')}` : ''}`;
  }
  if (incomplete.length > 0) {
    return `Waiting for ${names(incomplete).join(' + ')}`;
  }
  return null;
};

/**
 * Computes one job's workflow. Pure: the same state in, the same answers out.
 *
 * @param {object} input
 * @param {object[]} input.tasks the job's tasks, in any order
 * @param {object[]} input.runs every run of those tasks
 * @param {boolean} input.executing whether the job's workflow is live
 * @returns {{
 *   statuses: Map<string, string>,
 *   reasons: Map<string, string>,
 *   ready: object[],
 *   active: object[],
 *   cyclic: string[],
 *   counts: Record<string, number>,
 * }}
 */
export const computeJobGraph = ({ tasks, runs, executing }: {
  tasks: GraphTask[];
  runs: GraphRun[];
  executing: boolean;
}): GraphResult => {
  const runsByTask = new Map<string, GraphRun[]>();
  for (const run of runs) {
    const list = runsByTask.get(run.taskId);
    if (list) list.push(run);
    else runsByTask.set(run.taskId, [run]);
  }

  const { order, cyclic } = topologicalOrder(tasks);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const statuses = new Map<string, TaskStatus>();
  const reasons = new Map<string, string>();
  const counts: TaskGraphCounts = { total: tasks.length, completed: 0, running: 0, failed: 0, waiting: 0, ready: 0, pending: 0, cancelled: 0, blocked: 0 };
  const ready: GraphTask[] = [];
  const active: GraphTask[] = [];

  for (const task of order) {
    const history = runsByTask.get(task.id) ?? [];
    // An attempt that has not finished holds the task, whichever attempt it is.
    const unfinished = history.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
    const latestFinished = [...history].reverse().find((run) => TERMINAL_RUN_STATUSES.has(run.status));
    const inCycle = cyclic.includes(task.id);

    let status: TaskStatus;
    if (inCycle) {
      // Reported, never started: a cycle has no valid first task.
      status = 'waiting';
    } else if (unfinished) {
      status = 'running';
    } else if (latestFinished?.status === 'completed') {
      status = 'completed';
    } else if (latestFinished?.status === 'cancelled') {
      status = 'cancelled';
    } else if (latestFinished?.status === 'failed') {
      // It ran, so its own dependencies were satisfied when it did. A
      // dependency that has since been edited back to unfinished keeps it
      // waiting rather than reporting a failure that could still be retried.
      const blocked = blockersFor(task, tasksById, statuses);
      status = blocked.failed.length > 0 || blocked.incomplete.length > 0 ? 'waiting' : 'failed';
    } else if (blockersFor(task, tasksById, statuses).failed.length > 0
      || blockersFor(task, tasksById, statuses).incomplete.length > 0) {
      status = 'waiting';
    } else {
      status = executing ? 'ready' : 'pending';
    }

    statuses.set(task.id, status);
    counts[status] += 1;
    if (status === 'waiting') {
      const reason = waitReasonFor(task, tasksById, statuses, inCycle ? 'cycle' : null);
      if (reason) reasons.set(task.id, reason);
    }
    if (status === 'ready') ready.push(task);
    if (status === 'running') active.push(task);
  }

  return { statuses, reasons, ready, active, cyclic, counts };
};

/**
 * Every job's graph at once, over a whole state snapshot. Keeps the store's
 * one recompute pass a single call.
 *
 * @param {{ jobs: object[], tasks: object[], runs: object[] }} state
 * @returns {Map<string, ReturnType<typeof computeJobGraph>>} keyed by job id
 */
export const computeStateGraphs = (state: GraphState): Map<string, GraphResult> => {
  const tasksByJob = new Map<string, GraphTask[]>();
  for (const task of state.tasks) {
    const list = tasksByJob.get(task.jobId);
    if (list) list.push(task);
    else tasksByJob.set(task.jobId, [task]);
  }
  const graphs = new Map<string, GraphResult>();
  for (const job of state.jobs) {
    const tasks = tasksByJob.get(job.id) ?? [];
    const taskIds = new Set(tasks.map((task) => task.id));
    const runs = state.runs.filter((run) => taskIds.has(run.taskId));
    // A job is "executing" once its workflow is live: it is running, it is
    // waiting on a person, or any of its tasks has ever had a run.
    const executing = job.status === 'running'
      || job.status === 'waiting'
      || job.startMode === 'auto'
      || runs.length > 0;
    graphs.set(job.id, computeJobGraph({ tasks, runs, executing }));
  }
  return graphs;
};

/** Tasks whose dependencies point outside the job, missing, or at themselves. */
export const findDependencyProblems = (tasks: readonly GraphTask[]): DependencyProblem[] => {
  const byId = new Set(tasks.map((task) => task.id));
  const problems: DependencyProblem[] = [];
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        problems.push({ taskId: task.id, dependencyId, kind: 'self' });
      } else if (!byId.has(dependencyId)) {
        problems.push({ taskId: task.id, dependencyId, kind: 'missing' });
      }
    }
  }
  return problems;
};

/**
 * Would adding these dependencies to `task` close a loop? Checked on write so
 * a cycle never reaches the file, where it would have no valid first task.
 *
 * @param {object[]} tasks every task of the job, with the new edges applied
 * @param {string} taskId
 * @returns {boolean}
 */
export const wouldCreateCycle = (tasks: readonly GraphTask[], taskId: string): boolean => {
  const { cyclic } = topologicalOrder(tasks);
  return cyclic.includes(taskId);
};

export { TERMINAL_TASK_STATUSES, ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES };
