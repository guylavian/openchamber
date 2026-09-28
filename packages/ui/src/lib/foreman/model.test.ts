import { describe, expect, test } from 'bun:test';

import { foremanMemorySchema, foremanStateSchema, jobSchema, runSchema, runsForTask, tasksForJob } from './model';

describe('foreman model parsing', () => {
  const job = { id: 'j1', title: 'Job', status: 'pending', createdAt: 1, updatedAt: 1 };
  const task = { id: 't1', jobId: 'j1', title: 'Task', dependsOn: [], status: 'pending', createdAt: 1, updatedAt: 1 };
  const run = { id: 'r1', taskId: 't1', status: 'queued', createdAt: 1, updatedAt: 1 };

  test('accepts what the server writes, optionals absent', () => {
    const parsed = foremanStateSchema.parse({ version: 2, jobs: [job], tasks: [task], runs: [run] });
    expect(parsed.globalConcurrency).toBe(3);
    expect(parsed.jobs[0].goal).toBeUndefined();
    expect(parsed.runs[0].execution).toBeUndefined();
  });

  test('memory requires a job id only for Job scope', () => {
    const base = { id: 'm1', workspaceId: '/repo', type: 'fact', content: 'API client lives under ui.', tags: [], source: 'user', confidence: 0.8, createdAt: 1, updatedAt: 1, lastVerifiedAt: 1 };
    expect(foremanMemorySchema.safeParse({ ...base, scope: 'workspace' }).success).toBe(true);
    expect(foremanMemorySchema.safeParse({ ...base, scope: 'job', jobId: 'j1' }).success).toBe(true);
    expect(foremanMemorySchema.safeParse({ ...base, scope: 'job' }).success).toBe(false);
    expect(foremanMemorySchema.safeParse({ ...base, scope: 'workspace', jobId: 'j1' }).success).toBe(false);
  });

  test('accepts a run waiting with attention and an execution reference', () => {
    const parsed = runSchema.parse({
      ...run,
      status: 'waiting_for_user',
      attention: { type: 'permission', message: 'ok?' },
      execution: { type: 'opencode-session', id: 'ses_1', directory: '/repo', createdAt: 2 },
      startedAt: 2,
    });
    expect(parsed.attention?.type).toBe('permission');
    expect(parsed.execution?.id).toBe('ses_1');
  });

  test('accepts a failed run with its reason, and a start in progress with no session id yet', () => {
    const failed = runSchema.parse({ ...run, status: 'failed', error: { stage: 'dispatch', message: 'no model' } });
    expect(failed.error?.stage).toBe('dispatch');
    const starting = runSchema.parse({ ...run, execution: { type: 'opencode-session', createdAt: 3 } });
    expect(starting.execution?.id).toBeUndefined();
    expect(runSchema.safeParse({ ...run, execution: { type: 'docker', id: 'x', createdAt: 3 } }).success).toBe(false);
  });

  test('rejects unknown statuses and versions instead of guessing', () => {
    expect(jobSchema.safeParse({ ...job, status: 'blocked' }).success).toBe(false);
    expect(runSchema.safeParse({ ...run, status: 'waiting' }).success).toBe(false);
    expect(foremanStateSchema.safeParse({ version: 3, jobs: [], tasks: [], runs: [] }).success).toBe(false);
  });

  test('tasks and runs are found by their parent', () => {
    const tasks = [task, { ...task, id: 't2', jobId: 'j2' }];
    const runs = [run, { ...run, id: 'r2', taskId: 't2' }, { ...run, id: 'r3' }];
    expect(tasksForJob(tasks.map((t) => ({ ...t, status: 'pending' as const })), 'j1').map((t) => t.id)).toEqual(['t1']);
    expect(runsForTask(runs.map((r) => ({ ...r, status: 'queued' as const })), 't1').map((r) => r.id)).toEqual(['r1', 'r3']);
  });
});
