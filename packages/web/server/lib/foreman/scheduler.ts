import { ForemanStoreError } from './store.js';
import type { ForemanStore } from './store.js';
import type { JobId, RunId, TaskId } from './types.js';

export const GLOBAL_TASK_CONCURRENCY = 3;
export const foremanGlobalConcurrency = (configuredValue: string | undefined): number => {
  if (configuredValue === undefined || configuredValue.trim() === '') return GLOBAL_TASK_CONCURRENCY;
  const parsed = Number(configuredValue);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 32 ? parsed : GLOBAL_TASK_CONCURRENCY;
};
const occupiesCapacity = (run: { status: string; execution?: unknown }): boolean => run.status === 'running' || run.status === 'waiting_for_user' || (run.status === 'queued' && Boolean(run.execution));

/** Deterministic capacity and dependency gate for manual Task starts. */
interface Reservation { jobId: JobId; taskId: TaskId; baseDirectory: string | undefined }

export const createForemanScheduler = ({ store, globalLimit = GLOBAL_TASK_CONCURRENCY }: { store: Pick<ForemanStore, 'snapshot'>; globalLimit?: number }) => {
  const reservations = new Map<string, Reservation>();
  let reconcilePromise: Promise<{ release: () => void } | null> | null = null;
  return {
    async reconcile() {
      if (reconcilePromise) return reconcilePromise;
      reconcilePromise = (async () => {
        const state = await store.snapshot();
        const pending = state.runs.filter((run) => run.status === 'queued' && !run.execution && !reservations.has(run.id));
        for (const run of pending) {
          try {
            const reservation = await this.reserve(run.id);
            return reservation;
          } catch {
            // Manual mode records readiness and never creates a Run on recovery.
          }
        }
        return null;
      })().finally(() => { reconcilePromise = null; });
      return reconcilePromise;
    },
    async reserve(runId: RunId): Promise<{ release: () => void }> {
      const state = await store.snapshot();
      const run = state.runs.find((entry) => entry.id === runId);
      const task = run && state.tasks.find((entry) => entry.id === run.taskId);
      const job = task && state.jobs.find((entry) => entry.id === task.jobId);
      if (!run || !task || !job) throw new ForemanStoreError('not_found', `Run ${runId} does not exist`);
      if (reservations.has(runId)) throw new ForemanStoreError('conflict', 'This Run is already starting');
      const taskState = task.status;
      if (taskState !== 'ready' && taskState !== 'pending') throw new ForemanStoreError('conflict', task.blockingReason === 'dependency_failed' ? 'A dependency failed or was cancelled' : 'This Task is not ready');
      if (state.runs.some((entry) => entry.taskId === task.id && entry.id !== runId && occupiesCapacity(entry))) {
        throw new ForemanStoreError('conflict', 'This Task already has an active Run');
      }
      const active = state.runs.filter(occupiesCapacity);
      const reserved = [...reservations.values()];
      const globalCount = active.length + reserved.length;
      const jobCount = active.filter((entry) => state.tasks.find((owner) => owner.id === entry.taskId)?.jobId === job.id).length
        + reserved.filter((entry) => entry.jobId === job.id).length;
      if (globalCount >= globalLimit) throw new ForemanStoreError('conflict', `Foreman is at its global parallel limit (${globalLimit})`);
      if (jobCount >= job.maxParallelTasks) throw new ForemanStoreError('conflict', `This Job is at its parallel limit (${job.maxParallelTasks})`);
      if ((!task.workspace || task.workspace.kind === 'shared-directory') && job.directory) {
        const sharing = active.some((entry) => {
          const activeTask = state.tasks.find((candidate) => candidate.id === entry.taskId);
          return activeTask?.id !== task.id && activeTask?.workspace?.directory === job.directory && activeTask!.workspace!.kind === 'shared-directory';
        }) || reserved.some((entry) => entry.baseDirectory === job.directory && entry.taskId !== task.id);
        if (sharing) throw new ForemanStoreError('conflict', 'This workspace is not a Git repository; only one Task can run in it at a time');
      }
      const reservation: Reservation = { jobId: job.id, taskId: task.id, baseDirectory: job.directory };
      reservations.set(runId, reservation);
      let released = false;
      return { release: () => { if (!released) { released = true; reservations.delete(runId); } } };
    },
    async capacity() {
      const state = await store.snapshot();
      const active = state.runs.filter(occupiesCapacity).length + reservations.size;
      return { active, globalLimit, available: Math.max(0, globalLimit - active) };
    },
  };
};
