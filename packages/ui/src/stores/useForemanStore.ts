import { create } from 'zustand';

import { foremanApi, type ForemanApi } from '@/lib/foreman/api';
import type {
  CreateJobInput,
  CreateRunInput,
  CreateTaskInput,
  Job,
  JobPatch,
  Run,
  RunPatch,
  Task,
  TaskPatch,
} from '@/lib/foreman/model';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

/**
 * The client-side copy of Foreman's jobs, tasks and runs.
 *
 * The server is the record; this store is a cache of the last authoritative
 * read plus the entities the server returned for each mutation. Nothing is
 * invented locally: a create waits for the server's id. A failed load keeps
 * whatever was loaded before and says so in `loadError` — an unreachable
 * server is not an empty job list. A runtime switch drops everything.
 */

type ForemanLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ForemanStoreState {
  loadStatus: ForemanLoadStatus;
  loadError: string | null;
  jobs: Job[];
  tasks: Task[];
  runs: Run[];
}

interface ForemanStoreActions {
  /** Reads the whole state from the server; concurrent callers share one request. */
  load: () => Promise<void>;
  createJob: (input: CreateJobInput) => Promise<Job>;
  updateJob: (jobId: string, patch: JobPatch) => Promise<Job>;
  createTask: (jobId: string, input: CreateTaskInput) => Promise<Task>;
  updateTask: (taskId: string, patch: TaskPatch) => Promise<Task>;
  createRun: (taskId: string, input?: CreateRunInput) => Promise<Run>;
  updateRun: (runId: string, patch: RunPatch) => Promise<Run>;
  /** Starts a queued run; the server makes its session. Safe to repeat. */
  startRun: (runId: string) => Promise<Run>;
  /** Stops an active run; its session is interrupted by the server. Safe to repeat. */
  stopRun: (runId: string) => Promise<Run>;
  /** Forget everything; the next `load` starts from nothing. */
  reset: () => void;
}

type ForemanStore = ForemanStoreState & ForemanStoreActions;

const initialState: ForemanStoreState = {
  loadStatus: 'idle',
  loadError: null,
  jobs: [],
  tasks: [],
  runs: [],
};

const upsert = <T extends { id: string }>(list: readonly T[], entity: T): T[] => {
  const index = list.findIndex((entry) => entry.id === entity.id);
  if (index < 0) return [...list, entity];
  const next = list.slice();
  next[index] = entity;
  return next;
};

const describe = (error: Error | string): string => (error instanceof Error ? error.message : String(error));

/** The store over any client, so tests can supply an in-memory one. */
export const createForemanStore = (api: ForemanApi) => {
  let inFlight: Promise<void> | null = null;
  /** Bumped by `reset`, so a load that started before it cannot land after it. */
  let generation = 0;

  return create<ForemanStore>()((set) => ({
    ...initialState,

    load: () => {
      if (inFlight) return inFlight;
      const started = generation;
      set({ loadStatus: 'loading' });
      inFlight = api.fetchState()
        .then((state) => {
          if (started !== generation) return;
          set({ loadStatus: 'ready', loadError: null, jobs: state.jobs, tasks: state.tasks, runs: state.runs });
        })
        .catch((error: Error) => {
          if (started !== generation) return;
          set({ loadStatus: 'error', loadError: describe(error) });
        })
        .finally(() => {
          if (started === generation) inFlight = null;
        });
      return inFlight;
    },

    createJob: async (input) => {
      const job = await api.createJob(input);
      set((state) => ({ jobs: upsert(state.jobs, job) }));
      return job;
    },

    updateJob: async (jobId, patch) => {
      const job = await api.updateJob(jobId, patch);
      set((state) => ({ jobs: upsert(state.jobs, job) }));
      return job;
    },

    createTask: async (jobId, input) => {
      const task = await api.createTask(jobId, input);
      set((state) => ({ tasks: upsert(state.tasks, task) }));
      return task;
    },

    updateTask: async (taskId, patch) => {
      const task = await api.updateTask(taskId, patch);
      set((state) => ({ tasks: upsert(state.tasks, task) }));
      return task;
    },

    createRun: async (taskId, input = {}) => {
      const run = await api.createRun(taskId, input);
      set((state) => ({ runs: upsert(state.runs, run) }));
      return run;
    },

    updateRun: async (runId, patch) => {
      const run = await api.updateRun(runId, patch);
      set((state) => ({ runs: upsert(state.runs, run) }));
      return run;
    },

    startRun: async (runId) => {
      const { run } = await api.startRun(runId);
      set((state) => ({ runs: upsert(state.runs, run) }));
      return run;
    },

    stopRun: async (runId) => {
      const { run } = await api.stopRun(runId);
      set((state) => ({ runs: upsert(state.runs, run) }));
      return run;
    },

    reset: () => {
      generation += 1;
      inFlight = null;
      set({ ...initialState });
    },
  }));
};

export const useForemanStore = createForemanStore(foremanApi);

subscribeRuntimeEndpointChanged(() => useForemanStore.getState().reset());

// The server moves runs on as their sessions progress and says so; the store
// re-reads rather than trusting the event's contents, so a missed or
// reordered event cannot leave it stale. Only a store someone has loaded
// listens, so an app that never opens Jobs never asks.
let unsubscribeForemanEvents: (() => void) | null = null;
useForemanStore.subscribe((state) => {
  if (state.loadStatus === 'idle') {
    unsubscribeForemanEvents?.();
    unsubscribeForemanEvents = null;
    return;
  }
  if (unsubscribeForemanEvents) return;
  unsubscribeForemanEvents = subscribeOpenchamberEvents((event) => {
    if (event.type === 'foreman-changed') void useForemanStore.getState().load();
  });
});
