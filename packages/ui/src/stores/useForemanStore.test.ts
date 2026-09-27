import { describe, expect, test } from 'bun:test';

import type { ForemanApi } from '@/lib/foreman/api';
import type { ForemanState, Job, Run, Task } from '@/lib/foreman/model';
import { createForemanStore } from './useForemanStore';

/**
 * An in-memory server: the same rules the real one applies to ids and
 * timestamps, so the store is exercised against a faithful contract without
 * a network or a module mock.
 */
const createFakeApi = (): ForemanApi & { state: ForemanState; failNextFetch: () => void } => {
  const state: ForemanState = { version: 2, jobs: [], tasks: [], runs: [] };
  let ids = 0;
  let fail = false;
  const id = () => `id-${(ids += 1)}`;
  const at = () => 1_000 + ids;
  return {
    state,
    failNextFetch: () => { fail = true; },
    fetchState: async () => {
      if (fail) { fail = false; throw new Error('server unreachable'); }
      return structuredClone(state);
    },
    createJob: async (input) => {
      const job: Job = { id: id(), title: input.title, status: 'pending', createdAt: at(), updatedAt: at() };
      if (input.goal) job.goal = input.goal;
      state.jobs.push(job);
      return job;
    },
    updateJob: async (jobId, patch) => {
      const job = state.jobs.find((entry) => entry.id === jobId);
      if (!job) throw new Error('job not found');
      Object.assign(job, patch.status ? { status: patch.status } : {}, { updatedAt: at() });
      return { ...job };
    },
    createTask: async (jobId, input) => {
      if (!state.jobs.some((entry) => entry.id === jobId)) throw new Error('job not found');
      const task: Task = { id: id(), jobId, title: input.title, status: 'pending', createdAt: at(), updatedAt: at() };
      state.tasks.push(task);
      return task;
    },
    updateTask: async (taskId, patch) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) throw new Error('task not found');
      Object.assign(task, patch.status ? { status: patch.status } : {}, { updatedAt: at() });
      return { ...task };
    },
    createRun: async (taskId, input) => {
      if (!state.tasks.some((entry) => entry.id === taskId)) throw new Error('task not found');
      const existing = input.requestId ? state.runs.find((entry) => entry.taskId === taskId && entry.requestId === input.requestId) : undefined;
      if (existing) return { ...existing };
      const run: Run = { id: id(), taskId, status: 'queued', createdAt: at(), updatedAt: at() };
      if (input.requestId) run.requestId = input.requestId;
      state.runs.push(run);
      return run;
    },
    startRun: async (runId) => {
      const run = state.runs.find((entry) => entry.id === runId);
      if (!run) throw new Error('run not found');
      if (run.execution?.id) return { run: { ...run }, alreadyStarted: true };
      run.execution = { type: 'opencode-session', id: `ses_${runId}`, directory: '/repo', createdAt: at() };
      run.status = 'running';
      run.startedAt = at();
      return { run: { ...run }, alreadyStarted: false };
    },
    stopRun: async (runId) => {
      const run = state.runs.find((entry) => entry.id === runId);
      if (!run) throw new Error('run not found');
      if (run.status !== 'running' && run.status !== 'waiting_for_user') return { run: { ...run }, stopped: false };
      run.status = 'cancelled';
      run.stoppedAt = at();
      return { run: { ...run }, stopped: true };
    },
    updateRun: async (runId, patch) => {
      const run = state.runs.find((entry) => entry.id === runId);
      if (!run) throw new Error('run not found');
      if (patch.status) run.status = patch.status;
      if (patch.attention === null || run.status !== 'waiting_for_user') delete run.attention;
      else if (patch.attention) run.attention = patch.attention;
      run.updatedAt = at();
      return { ...run };
    },
  };
};

describe('useForemanStore', () => {
  test('starts empty and idle; a load makes it ready', async () => {
    const api = createFakeApi();
    const store = createForemanStore(api);
    expect(store.getState().loadStatus).toBe('idle');
    await store.getState().load();
    expect(store.getState().loadStatus).toBe('ready');
    expect(store.getState().jobs).toEqual([]);
  });

  test('a failed load keeps what was there and reports the error', async () => {
    const api = createFakeApi();
    const store = createForemanStore(api);
    await store.getState().createJob({ title: 'kept' });
    api.failNextFetch();
    await store.getState().load();
    expect(store.getState().loadStatus).toBe('error');
    expect(store.getState().loadError).toBe('server unreachable');
    expect(store.getState().jobs.map((job) => job.title)).toEqual(['kept']);
  });

  test('job → task → run: created through the server, related by id', async () => {
    const api = createFakeApi();
    const store = createForemanStore(api);
    const job = await store.getState().createJob({ title: 'Job', goal: 'Goal' });
    const task = await store.getState().createTask(job.id, { title: 'Task' });
    const run = await store.getState().createRun(task.id, { requestId: 'click-1' });
    const again = await store.getState().createRun(task.id, { requestId: 'click-1' });
    expect(task.jobId).toBe(job.id);
    expect(run.taskId).toBe(task.id);
    expect(again.id).toBe(run.id);
    const { jobs, tasks, runs } = store.getState();
    expect(jobs).toHaveLength(1);
    expect(tasks[0].jobId).toBe(jobs[0].id);
    expect(runs[0].taskId).toBe(tasks[0].id);
  });

  test('status updates replace the entity with the server\'s answer', async () => {
    const api = createFakeApi();
    const store = createForemanStore(api);
    const job = await store.getState().createJob({ title: 'Job' });
    const task = await store.getState().createTask(job.id, { title: 'Task' });
    const run = await store.getState().createRun(task.id);
    await store.getState().updateJob(job.id, { status: 'running' });
    await store.getState().updateTask(task.id, { status: 'blocked' });
    const waiting = await store.getState().updateRun(run.id, { status: 'waiting_for_user', attention: { type: 'question' } });
    expect(store.getState().jobs[0].status).toBe('running');
    expect(store.getState().tasks[0].status).toBe('blocked');
    expect(waiting.attention).toEqual({ type: 'question' });
    await store.getState().updateRun(run.id, { status: 'completed' });
    expect(store.getState().runs[0].attention).toBeUndefined();
    expect(store.getState().runs).toHaveLength(1);
  });

  test('reload rehydrates from the server, not from memory', async () => {
    const api = createFakeApi();
    const first = createForemanStore(api);
    const job = await first.getState().createJob({ title: 'Persisted' });
    await first.getState().createTask(job.id, { title: 'Task' });

    const second = createForemanStore(api);
    await second.getState().load();
    expect(second.getState().jobs.map((entry) => entry.title)).toEqual(['Persisted']);
    expect(second.getState().tasks[0].jobId).toBe(job.id);
  });

  test('reset drops everything and a load started before it cannot land after', async () => {
    const api = createFakeApi();
    const store = createForemanStore(api);
    await store.getState().createJob({ title: 'old runtime' });
    const pending = store.getState().load();
    store.getState().reset();
    await pending;
    expect(store.getState().loadStatus).toBe('idle');
    expect(store.getState().jobs).toEqual([]);
  });

  test('starting a run stores the server\'s answer: running, with its session', async () => {
    const api = createFakeApi();
    const store = createForemanStore(api);
    const job = await store.getState().createJob({ title: 'Job' });
    const task = await store.getState().createTask(job.id, { title: 'Task' });
    const run = await store.getState().createRun(task.id);
    const started = await store.getState().startRun(run.id);
    expect(started.status).toBe('running');
    expect(store.getState().runs[0].execution?.id).toBe(`ses_${run.id}`);
    const again = await store.getState().startRun(run.id);
    expect(again.execution?.id).toBe(started.execution?.id);
    expect(store.getState().runs).toHaveLength(1);
  });

  test('stopping a run stores the server\'s answer: cancelled, and a repeat changes nothing', async () => {
    const api = createFakeApi();
    const store = createForemanStore(api);
    const job = await store.getState().createJob({ title: 'Job' });
    const task = await store.getState().createTask(job.id, { title: 'Task' });
    const run = await store.getState().createRun(task.id);
    await store.getState().startRun(run.id);
    const stopped = await store.getState().stopRun(run.id);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.stoppedAt).toBeGreaterThan(0);
    const again = await store.getState().stopRun(run.id);
    expect(again.stoppedAt).toBe(stopped.stoppedAt);
    expect(store.getState().runs).toHaveLength(1);
  });
});
