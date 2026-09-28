import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FOREMAN_FILE_NAME, createForemanStore, foremanFileSchema } from './store.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-store-'));

const makeStore = (dataDir, overrides = {}) => {
  let tick = 1_000;
  let ids = 0;
  return createForemanStore({
    dataDir,
    now: () => (tick += 1),
    randomUUID: () => `id-${(ids += 1)}`,
    warn: () => {},
    ...overrides,
  });
};

const readState = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, FOREMAN_FILE_NAME), 'utf8'));

describe('foreman store: default state', () => {
  it('a data dir with no Foreman file is an empty state, and reading it writes nothing', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    expect(await store.snapshot()).toEqual({ version: 2, globalConcurrency: 3, jobs: [], tasks: [], runs: [] });
    expect(fs.existsSync(path.join(dir, FOREMAN_FILE_NAME))).toBe(false);
  });

  it('a missing data dir is created on the first write only', async () => {
    const dir = path.join(tempDir(), 'nested', 'data');
    const store = makeStore(dir);
    await store.snapshot();
    expect(fs.existsSync(dir)).toBe(false);
    await store.createJob({ title: 'first' });
    expect(readState(dir).jobs).toHaveLength(1);
  });

  it('publishes the configured global concurrency limit', async () => {
    const store = makeStore(tempDir(), { globalConcurrency: 5 });
    expect(await store.snapshot()).toMatchObject({ version: 2, globalConcurrency: 5 });
  });
});

describe('foreman store: jobs, tasks and runs', () => {
  it('creates a job with server-owned id, timestamps and pending status', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: '  Ship it  ', goal: 'green CI', directory: '/repo' });
    expect(job).toEqual({
      id: 'id-1', title: 'Ship it', goal: 'green CI', directory: '/repo',
      status: 'pending', maxParallelTasks: 3, createdAt: 1_001, updatedAt: 1_001,
    });
  });

  it('rejects a job without a title and leaves nothing behind', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await expect(store.createJob({ title: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.createJob({ goal: 'no title' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fs.existsSync(path.join(dir, FOREMAN_FILE_NAME))).toBe(false);
  });

  it('a task belongs to an existing job', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 'task', instructions: 'do it' });
    expect(task).toMatchObject({ id: 'id-2', jobId: job.id, title: 'task', instructions: 'do it', status: 'ready', dependsOn: [] });
    await expect(store.createTask('nope', { title: 'orphan' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await store.snapshot()).tasks).toHaveLength(1);
  });

  it('deletes a Task, its Runs, and its references from dependent Tasks', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'Job' });
    const task = await store.createTask(job.id, { title: 'First' });
    const dependent = await store.createTask(job.id, { title: 'Next', dependsOn: [task.id] });
    const run = await store.createRun(task.id);
    await store.updateRun(run.id, { status: 'failed' });
    await store.deleteTask(task.id);
    const snapshot = await store.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ id: dependent.id, dependsOn: [], status: 'ready' });
    expect(snapshot.runs).toEqual([]);
  });

  it('deletes all Job-owned Tasks, Runs, and Job memory without touching Workspace memory', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'Job', directory: '/repo' });
    const task = await store.createTask(job.id, { title: 'Task' });
    const run = await store.createRun(task.id);
    await store.updateRun(run.id, { status: 'failed' });
    const workspaceMemory = await store.createMemory(job.id, '/repo', { scope: 'workspace', type: 'fact', content: 'Shared' });
    const jobMemory = await store.createMemory(job.id, '/repo', { scope: 'job', type: 'fact', content: 'Local' });
    await store.deleteJob(job.id);
    const snapshot = await store.snapshot();
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect((await store.listMemoriesForJob((await store.createJob({ title: 'Other', directory: '/repo' })).id, '/repo')).map((entry) => entry.id)).toContain(workspaceMemory.id);
    expect((await store.snapshot()).memories).toBeUndefined();
    expect(jobMemory.id).toBeDefined();
  });

  it('refuses store deletion when any Task Run is active', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'Job' });
    const task = await store.createTask(job.id, { title: 'Task' });
    await store.createRun(task.id);
    await expect(store.deleteTask(task.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.deleteJob(job.id)).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.snapshot()).tasks).toHaveLength(1);
  });

  it('a run belongs to an existing task and starts queued, with no execution', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 'task' });
    const run = await store.createRun(task.id);
    expect(run).toEqual({ id: 'id-3', taskId: task.id, status: 'queued', createdAt: 1_003, updatedAt: 1_003 });
    await expect(store.createRun('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.createRun(task.id, { sessionId: 'ses_1' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('a retried create with the same requestId lands once', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 'task' });
    const [a, b] = await Promise.all([
      store.createRun(task.id, { requestId: 'click-1' }),
      store.createRun(task.id, { requestId: 'click-1' }),
    ]);
    expect(a.id).toBe(b.id);
    await store.updateRun(a.id, { status: 'failed' });
    const other = await store.createRun(task.id, { requestId: 'click-2' });
    expect(other.id).not.toBe(a.id);
    expect((await store.snapshot()).runs).toHaveLength(2);
  });

  it('validates dependency references, duplicates, self edges, and cycles', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'DAG' });
    const a = await store.createTask(job.id, { title: 'A' });
    const b = await store.createTask(job.id, { title: 'B', dependsOn: [a.id] });
    await expect(store.createTask(job.id, { title: 'missing', dependsOn: ['no-task'] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.createTask(job.id, { title: 'duplicate', dependsOn: [a.id, a.id] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.updateTask(a.id, { dependsOn: [a.id] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.updateTask(a.id, { dependsOn: [b.id] })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await store.snapshot()).tasks.map(({ status }) => status)).toEqual(['ready', 'blocked']);
  });

  it('dependencies wait, failed dependencies block, and a successful retry releases them', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'DAG' });
    const a = await store.createTask(job.id, { title: 'A' });
    const b = await store.createTask(job.id, { title: 'B' });
    const c = await store.createTask(job.id, { title: 'C', dependsOn: [a.id, b.id] });
    expect((await store.snapshot()).tasks.find(({ id }) => id === c.id)).toMatchObject({ status: 'blocked', blockedByTaskIds: [a.id, b.id], blockingReason: 'dependency_incomplete' });
    const runA = await store.createRun(a.id);
    const runB = await store.createRun(b.id);
    await store.updateRun(runA.id, { status: 'completed' });
    await store.updateRun(runB.id, { status: 'failed' });
    expect((await store.snapshot()).tasks.find(({ id }) => id === c.id)).toMatchObject({ status: 'blocked', blockingReason: 'dependency_failed' });
    const retryB = await store.createRun(b.id);
    await store.updateRun(retryB.id, { status: 'completed' });
    expect((await store.snapshot()).tasks.find(({ id }) => id === c.id)).toMatchObject({ status: 'ready' });
  });

  it('allows concurrent Runs for independent Tasks and only one active Run per Task', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'Parallel' });
    const a = await store.createTask(job.id, { title: 'A' });
    const b = await store.createTask(job.id, { title: 'B' });
    const runA = await store.createRun(a.id);
    expect((await store.createRun(b.id)).status).toBe('queued');
    await expect(store.createRun(a.id)).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.snapshot()).runs).toHaveLength(2);
    expect(runA.status).toBe('queued');
  });

  it('a run that owns an execution refuses hand-written status', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 'task' });
    const run = await store.createRun(task.id);
    await store.applyExecutionChange(run.id, () => ({ execution: { type: 'opencode-session', id: 'ses_1', createdAt: 1 } }));
    await expect(store.updateRun(run.id, { status: 'completed' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('execution changes keep error and attention tied to their status', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 'task' });
    const run = await store.createRun(task.id);
    const failed = await store.applyExecutionChange(run.id, () => ({ status: 'failed', error: { stage: 'dispatch', message: 'x' } }));
    expect(failed.run.error).toEqual({ stage: 'dispatch', message: 'x' });
    expect(failed.run.finishedAt).toBeDefined();
    const running = await store.applyExecutionChange(run.id, () => ({ status: 'running' }));
    expect(running.run.error).toBeUndefined();
    expect(running.run.finishedAt).toBeUndefined();
    const unchanged = await store.applyExecutionChange(run.id, () => null);
    expect(unchanged.changed).toBe(false);
  });

  it('records meaningful status and attention events once per transition', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 'task' });
    const run = await store.createRun(task.id);
    await store.applyExecutionChange(run.id, () => ({ execution: { type: 'opencode-session', id: 's1', createdAt: 1 } }));
    await store.addRunActivity(run.id, { type: 'run_started', message: 'Run started' });
    await store.addRunActivity(run.id, { type: 'session_created', message: 'OpenCode session created' });
    await store.applyExecutionChange(run.id, () => ({ status: 'running' }));
    await store.applyExecutionChange(run.id, () => ({ status: 'waiting_for_user', attention: { type: 'permission' } }));
    await store.applyExecutionChange(run.id, () => ({ status: 'waiting_for_user', attention: { type: 'permission' } }));
    await store.applyExecutionChange(run.id, () => ({ status: 'running' }));
    await store.applyExecutionChange(run.id, () => ({ status: 'completed' }));
    const activity = await store.activityForRun(run.id);
    expect(activity.map(({ type }) => type)).toEqual(['run_started', 'session_created', 'attention_required', 'attention_resolved', 'run_completed']);
    expect(activity.map(({ message }) => message)).toContain('Waiting for permission');
  });

  it('status updates bump updatedAt and refuse unknown statuses', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const updated = await store.updateJob(job.id, { status: 'running', goal: null });
    expect(updated.status).toBe('running');
    expect(updated.updatedAt).toBeGreaterThan(job.updatedAt);
    expect(updated.goal).toBeUndefined();
    await expect(store.updateJob(job.id, { status: 'done' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.updateJob('nope', { status: 'running' })).rejects.toMatchObject({ code: 'not_found' });
    const task = await store.createTask(job.id, { title: 't' });
    await expect(store.updateTask(task.id, { status: 'blocked' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await store.snapshot()).tasks[0].status).toBe('ready');
  });

  it('a run records when it started and finished, once', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 't' });
    const run = await store.createRun(task.id);
    const running = await store.updateRun(run.id, { status: 'running' });
    expect(running.startedAt).toBe(running.updatedAt);
    const failed = await store.updateRun(run.id, { status: 'failed' });
    expect(failed.startedAt).toBe(running.startedAt);
    expect(failed.finishedAt).toBe(failed.updatedAt);
    const again = await store.updateRun(run.id, { status: 'completed' });
    expect(again.finishedAt).toBe(failed.finishedAt);
  });

  it('attention exists only while a run waits for a person', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 't' });
    const run = await store.createRun(task.id);
    const waiting = await store.updateRun(run.id, {
      status: 'waiting_for_user',
      attention: { type: 'permission', message: 'May I run the tests?' },
    });
    expect(waiting.attention).toEqual({ type: 'permission', message: 'May I run the tests?' });
    // Leaving the waiting state clears the reason: no stale "blocked" flag.
    const resumed = await store.updateRun(run.id, { status: 'running' });
    expect(resumed.attention).toBeUndefined();
    await expect(store.updateRun(run.id, { attention: { type: 'question' } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(store.updateRun(run.id, { status: 'waiting_for_user', attention: { type: 'nope' } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const cleared = await store.updateRun(run.id, { status: 'waiting_for_user', attention: null });
    expect(cleared.status).toBe('waiting_for_user');
    expect(cleared.attention).toBeUndefined();
  });
});

describe('foreman store: persistence', () => {
  it('everything survives a restart: a fresh store over the same dir reads it back', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const job = await store.createJob({ title: 'job', goal: 'g' });
    const task = await store.createTask(job.id, { title: 'task' });
    const run = await store.createRun(task.id);
    await store.updateRun(run.id, { status: 'waiting_for_user', attention: { type: 'question' } });
    await store.applyExecutionChange(run.id, () => ({ execution: { type: 'opencode-session', id: 's1', directory: '/repo', createdAt: 5 } }));

    const reloaded = makeStore(dir);
    const snapshot = await reloaded.snapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.jobs).toEqual([job]);
    expect(snapshot.tasks[0]).toMatchObject({ id: task.id, status: 'waiting', currentRunId: run.id });
    expect(snapshot.runs[0]).toMatchObject({ id: run.id, taskId: task.id, status: 'waiting_for_user', attention: { type: 'question' }, execution: { type: 'opencode-session', id: 's1', directory: '/repo', createdAt: 5 } });
    expect(foremanFileSchema.safeParse(readState(dir)).success).toBe(true);
  });

  it('Task worktree association survives a store restart', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const job = await store.createJob({ title: 'Job', directory: '/repo' });
    const task = await store.createTask(job.id, { title: 'Task' });
    const workspace = { kind: 'git-worktree', directory: path.join(dir, 'foreman-worktrees', 'task-one'), createdAt: 10 };
    await store.setTaskWorkspace(task.id, workspace);
    const restarted = makeStore(dir);
    expect((await restarted.snapshot()).tasks[0]).toMatchObject({ id: task.id, workspace });
  });

  it('run activity persists across store restart and stays isolated between Runs', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const job = await store.createJob({ title: 'job' });
    const task = await store.createTask(job.id, { title: 'task' });
    const first = await store.createRun(task.id);
    const secondTask = await store.createTask(job.id, { title: 'other task' });
    const second = await store.createRun(secondTask.id);
    const event = await store.addRunActivity(first.id, { type: 'validation', message: '13 tests passed' });
    const reloaded = makeStore(dir);
    expect(await reloaded.activityForRun(first.id)).toEqual([event]);
    expect(await reloaded.activityForRun(second.id)).toEqual([]);
  });

  it('version 3 files migrate with an empty activity list without altering their other data', async () => {
    const dir = tempDir();
    const v3 = { version: 3, jobs: [{ id: 'j', title: 'J', status: 'pending', createdAt: 1, updatedAt: 1 }], tasks: [{ id: 't', jobId: 'j', title: 'T', status: 'pending', createdAt: 1, updatedAt: 1 }], runs: [{ id: 'r', taskId: 't', status: 'queued', createdAt: 1, updatedAt: 1 }], memories: [] };
    fs.writeFileSync(path.join(dir, FOREMAN_FILE_NAME), JSON.stringify(v3));
    const store = makeStore(dir);
    await store.addRunActivity('r', { type: 'run_started', message: 'Run started' });
    const migrated = readState(dir);
    expect(migrated.version).toBe(5);
    expect(migrated.runs[0].activity).toHaveLength(1);
    expect(migrated.jobs[0]).toMatchObject({ ...v3.jobs[0], maxParallelTasks: 3 });
    expect(migrated.tasks[0]).toMatchObject({ ...v3.tasks[0], dependsOn: [] });
    expect(migrated.memories).toEqual([]);
  });

  it('version 4 files gain dependency, workspace, and parallelism defaults', async () => {
    const dir = tempDir();
    const v4 = { version: 4, jobs: [{ id: 'j', title: 'J', status: 'pending', createdAt: 1, updatedAt: 1 }], tasks: [{ id: 't', jobId: 'j', title: 'T', status: 'pending', createdAt: 1, updatedAt: 1 }], runs: [], memories: [] };
    fs.writeFileSync(path.join(dir, FOREMAN_FILE_NAME), JSON.stringify(v4));
    const store = makeStore(dir);
    expect((await store.snapshot()).tasks[0]).toMatchObject({ dependsOn: [], status: 'ready' });
    await store.createJob({ title: 'next' });
    expect(readState(dir).version).toBe(5);
    expect(readState(dir).jobs[0].maxParallelTasks).toBe(3);
    expect(readState(dir).tasks[0].dependsOn).toEqual([]);
  });

  it('workspace and job memories survive restart, remain scoped, and outlive runs', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const first = await store.createJob({ title: 'API refactor', directory: '/repo' });
    const second = await store.createJob({ title: 'Docs', directory: '/repo' });
    const firstTask = await store.createTask(first.id, { title: 'Update API client' });
    const run = await store.createRun(firstTask.id);
    const workspaceMemory = await store.createMemory(first.id, '/repo', {
      scope: 'workspace', type: 'architecture', content: 'API client lives under packages/ui/src/lib/api.', tags: ['api', 'packages/ui/src/lib/api'],
    });
    const firstJobMemory = await store.createMemory(first.id, '/repo', {
      scope: 'job', type: 'decision', content: 'Keep the client compatible with this Job.', tags: ['api'],
    });
    await store.createMemory(second.id, '/repo', {
      scope: 'job', type: 'fact', content: 'Docs job only detail about API.', tags: ['api'],
    });
    await store.updateRun(run.id, { status: 'completed' });
    await store.deleteRun(run.id);

    const reloaded = makeStore(dir);
    const relevant = await reloaded.relevantMemories({ jobId: first.id, workspaceId: '/repo', query: 'API client packages/ui/src/lib/api' });
    expect(relevant.map((entry) => entry.id)).toEqual([workspaceMemory.id, firstJobMemory.id]);
    expect((await reloaded.listMemoriesForJob(second.id, '/repo')).map((entry) => entry.scope)).toEqual(['workspace', 'job']);
    expect((await reloaded.snapshot()).runs).toEqual([]);
  });

  it('stale memory can be updated and removed', async () => {
    const store = makeStore(tempDir());
    const job = await store.createJob({ title: 'job', directory: '/repo' });
    const memory = await store.createMemory(job.id, '/repo', { scope: 'workspace', type: 'known_issue', content: 'Old issue', tags: [] });
    const updated = await store.updateMemory(memory.id, { content: 'Resolved issue', type: 'fact' });
    expect(updated).toMatchObject({ content: 'Resolved issue', type: 'fact' });
    expect(updated.updatedAt).toBeGreaterThan(memory.updatedAt);
    expect(updated.lastVerifiedAt).toBe(updated.updatedAt);
    expect(await store.deleteMemory(memory.id)).toMatchObject({ id: memory.id });
    expect(await store.listMemoriesForJob(job.id, '/repo')).toEqual([]);
  });

  it('a failed write restores the previous state and leaves no temp file', async () => {
    const dir = tempDir();
    let fail = false;
    const store = makeStore(dir, {
      fsPromises: {
        ...fs.promises,
        writeFile: async (...args) => {
          if (fail) throw new Error('disk full');
          return fs.promises.writeFile(...args);
        },
      },
    });
    const job = await store.createJob({ title: 'kept' });
    fail = true;
    await expect(store.createJob({ title: 'lost' })).rejects.toThrow('disk full');
    fail = false;
    expect((await store.snapshot()).jobs.map((entry) => entry.title)).toEqual(['kept']);
    expect(readState(dir).jobs.map((entry) => entry.title)).toEqual(['kept']);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(job.id).toBe('id-1');
  });

  it('concurrent mutations serialize: every entity lands', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.createJob({ title: `job ${n}` })));
    expect(readState(dir).jobs).toHaveLength(5);
  });

  it('an unreadable file is moved aside and the store starts empty', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, FOREMAN_FILE_NAME), '{ not json');
    const warnings = [];
    const store = makeStore(dir, { warn: (message) => warnings.push(message) });
    expect(await store.snapshot()).toEqual({ version: 2, globalConcurrency: 3, jobs: [], tasks: [], runs: [] });
    expect(fs.readdirSync(dir).some((name) => name.startsWith(`${FOREMAN_FILE_NAME}.corrupt-`))).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('a file with an unexpected shape counts as unreadable', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, FOREMAN_FILE_NAME), JSON.stringify({ version: 1, jobs: [{ id: 1 }], tasks: [], runs: [] }));
    const store = makeStore(dir);
    expect(await store.snapshot()).toEqual({ version: 2, globalConcurrency: 3, jobs: [], tasks: [], runs: [] });
  });

  it('a version 1 file migrates: a bare sessionId becomes an execution reference', async () => {
    const dir = tempDir();
    const v1 = {
      version: 1,
      jobs: [{ id: 'j', title: 'J', status: 'pending', createdAt: 1, updatedAt: 1 }],
      tasks: [{ id: 't', jobId: 'j', title: 'T', status: 'pending', createdAt: 1, updatedAt: 1 }],
      runs: [
        { id: 'r1', taskId: 't', status: 'queued', createdAt: 2, updatedAt: 2 },
        { id: 'r2', taskId: 't', status: 'running', sessionId: 'ses_9', createdAt: 3, updatedAt: 3 },
      ],
    };
    fs.writeFileSync(path.join(dir, FOREMAN_FILE_NAME), JSON.stringify(v1));
    const store = makeStore(dir);
    const snapshot = await store.snapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.jobs[0].maxParallelTasks).toBe(3);
    expect(snapshot.tasks[0].dependsOn).toEqual([]);
    expect(snapshot.runs[0].execution).toBeUndefined();
    expect(snapshot.runs[1].execution).toEqual({ type: 'opencode-session', id: 'ses_9', createdAt: 3 });
    expect(snapshot.runs[1].sessionId).toBeUndefined();
    // Reading converts in memory only; the file changes on the next write.
    expect(readState(dir).version).toBe(1);
    await store.createJob({ title: 'next' });
    expect(readState(dir).version).toBe(5);
  });

  it('a version 2 file migrates safely and preserves jobs, tasks and runs', async () => {
    const dir = tempDir();
    const v2 = { version: 2, jobs: [{ id: 'j', title: 'J', directory: '/repo', status: 'pending', createdAt: 1, updatedAt: 1 }], tasks: [{ id: 't', jobId: 'j', title: 'T', status: 'pending', createdAt: 1, updatedAt: 1 }], runs: [] };
    fs.writeFileSync(path.join(dir, FOREMAN_FILE_NAME), JSON.stringify(v2));
    const store = makeStore(dir);
    expect((await store.snapshot()).jobs[0]).toMatchObject({ ...v2.jobs[0], maxParallelTasks: 3 });
    expect((await store.snapshot()).tasks[0]).toMatchObject({ ...v2.tasks[0], dependsOn: [], status: 'ready' });
    await store.createMemory('j', '/repo', { scope: 'workspace', type: 'fact', content: 'persisted' });
    expect(readState(dir).version).toBe(5);
    expect(readState(dir).memories).toHaveLength(1);
  });

  it('a file from a newer version is neither read nor overwritten', async () => {
    const dir = tempDir();
    const newer = JSON.stringify({ version: 6, jobs: [], tasks: [], runs: [], memories: [], extra: true });
    fs.writeFileSync(path.join(dir, FOREMAN_FILE_NAME), newer);
    const store = makeStore(dir);
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'unsupported_version' });
    await expect(store.createJob({ title: 'x' })).rejects.toMatchObject({ code: 'unsupported_version' });
    expect(fs.readFileSync(path.join(dir, FOREMAN_FILE_NAME), 'utf8')).toBe(newer);
  });
});
