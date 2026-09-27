import { describe, expect, test } from 'bun:test';

import { foremanStateSchema, jobSchema, runSchema, runsForTask, tasksForJob } from './model';

describe('foreman model parsing', () => {
  const job = { id: 'j1', title: 'Job', status: 'pending', createdAt: 1, updatedAt: 1 };
  const task = { id: 't1', jobId: 'j1', title: 'Task', status: 'pending', createdAt: 1, updatedAt: 1 };
  const run = { id: 'r1', taskId: 't1', status: 'queued', createdAt: 1, updatedAt: 1 };

  test('accepts what the server writes, optionals absent', () => {
    const parsed = foremanStateSchema.parse({ version: 1, jobs: [job], tasks: [task], runs: [run] });
    expect(parsed.jobs[0].goal).toBeUndefined();
    expect(parsed.runs[0].sessionId).toBeUndefined();
  });

  test('accepts a run waiting with attention and a session reference', () => {
    const parsed = runSchema.parse({
      ...run, status: 'waiting_for_user', attention: { type: 'permission', message: 'ok?' }, sessionId: 'ses_1', startedAt: 2,
    });
    expect(parsed.attention?.type).toBe('permission');
    expect(parsed.sessionId).toBe('ses_1');
  });

  test('rejects unknown statuses and versions instead of guessing', () => {
    expect(jobSchema.safeParse({ ...job, status: 'blocked' }).success).toBe(false);
    expect(runSchema.safeParse({ ...run, status: 'waiting' }).success).toBe(false);
    expect(foremanStateSchema.safeParse({ version: 2, jobs: [], tasks: [], runs: [] }).success).toBe(false);
  });

  test('tasks and runs are found by their parent', () => {
    const tasks = [task, { ...task, id: 't2', jobId: 'j2' }];
    const runs = [run, { ...run, id: 'r2', taskId: 't2' }, { ...run, id: 'r3' }];
    expect(tasksForJob(tasks.map((t) => ({ ...t, status: 'pending' as const })), 'j1').map((t) => t.id)).toEqual(['t1']);
    expect(runsForTask(runs.map((r) => ({ ...r, status: 'queued' as const })), 't1').map((r) => r.id)).toEqual(['r1', 'r3']);
  });
});
