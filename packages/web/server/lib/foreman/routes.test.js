import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerForemanRoutes } from './routes.js';
import { createForemanStore } from './store.js';
import { createForemanExecution } from './execution.js';

// Express is not started: handlers are captured and invoked directly, the
// body parser skipped, as the other route tests in this server do.
const createApp = () => {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return {
    app: { get: register('GET'), post: register('POST'), patch: register('PATCH'), delete: register('DELETE') },
    async call(method, routePath, { params = {}, body } = {}) {
      const handler = routes.get(`${method} ${routePath}`);
      if (!handler) throw new Error(`no route ${method} ${routePath}`);
      const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
      };
      await handler({ params, body }, res);
      return res;
    },
  };
};

const setup = ({ removeWorkspace = async () => {} } = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-routes-'));
  const store = createForemanStore({ dataDir, warn: () => {} });
  const sessions = [];
  const prompts = [];
  const interrupts = [];
  const execution = createForemanExecution({
    store,
    sessionService: {
      create: async ({ directory }) => { sessions.push(directory); return { sessionId: `ses_${sessions.length}`, directory }; },
      send: async (_sessionId, { prompt }) => { prompts.push(prompt); return { promptDispatched: true }; },
      interrupt: async (sessionId) => { interrupts.push(sessionId); return { interrupted: true, missing: false }; },
    },
    validateDirectoryPath: async (directory) => ({ ok: Boolean(directory), directory }),
    activityProbe: { fetchActiveSessionStatuses: async () => ({}), hasWorkingChildren: async () => false },
    readSessionOutcome: async () => 'unknown',
    warn: () => {},
  });
  const harness = createApp();
  registerForemanRoutes(harness.app, {
    store, execution, taskWorkspaceManager: { remove: removeWorkspace },
    validateDirectoryPath: async (directory) => ({ ok: Boolean(directory), directory }),
  });
  return { ...harness, dataDir, store, sessions, prompts, interrupts };
};

describe('foreman routes', () => {
  it('walks the hierarchy: job → task → run, then reads the whole state back', async () => {
    const { call } = setup();
    const job = await call('POST', '/api/foreman/jobs', { body: { title: 'Job', goal: 'Goal' } });
    expect(job.statusCode).toBe(201);
    const task = await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.body.id }, body: { title: 'Task' } });
    expect(task.statusCode).toBe(201);
    expect(task.body.jobId).toBe(job.body.id);
    const run = await call('POST', '/api/foreman/tasks/:taskId/runs', { params: { taskId: task.body.id }, body: {} });
    expect(run.statusCode).toBe(201);
    expect(run.body).toMatchObject({ taskId: task.body.id, status: 'queued' });

    const state = await call('GET', '/api/foreman/state');
    expect(state.body.jobs).toHaveLength(1);
    expect(state.body.tasks[0].jobId).toBe(job.body.id);
    expect(state.body.runs[0].taskId).toBe(task.body.id);
  });

  it('maps store errors to status codes', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/foreman/jobs', { body: { goal: 'no title' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/foreman/jobs', { body: 'not an object' })).statusCode).toBe(400);
    expect((await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: 'missing' }, body: { title: 't' } })).statusCode).toBe(404);
    expect((await call('PATCH', '/api/foreman/runs/:runId', { params: { runId: 'missing' }, body: { status: 'running' } })).statusCode).toBe(404);
  });

  it('lists, edits, and deletes workspace and job memory through the job workspace boundary', async () => {
    const { call } = setup();
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'API', directory: '/repo' } })).body;
    const created = await call('POST', '/api/foreman/jobs/:jobId/memories', { params: { jobId: job.id }, body: { scope: 'workspace', type: 'architecture', content: 'API client in packages/ui', tags: ['api'] } });
    expect(created.statusCode).toBe(201);
    expect((await call('GET', '/api/foreman/jobs/:jobId/memories', { params: { jobId: job.id } })).body.memories).toEqual([created.body]);
    const updated = await call('PATCH', '/api/foreman/memories/:memoryId', { params: { memoryId: created.body.id }, body: { content: 'Updated API client location' } });
    expect(updated.body.content).toBe('Updated API client location');
    expect((await call('DELETE', '/api/foreman/memories/:memoryId', { params: { memoryId: created.body.id } })).body.memory.id).toBe(created.body.id);
    const missing = await call('GET', '/api/foreman/jobs/:jobId/memories', { params: { jobId: 'missing' } });
    expect(missing.statusCode).toBe(404);
  });

  it('does not save memory under an unvalidated workspace path', async () => {
    const { call, dataDir } = setup();
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job', directory: '/repo' } })).body;
    // The test validator accepts nonempty paths; a missing directory is rejected before store access.
    const noWorkspace = (await call('POST', '/api/foreman/jobs', { body: { title: 'No workspace' } })).body;
    expect((await call('POST', '/api/foreman/jobs/:jobId/memories', { params: { jobId: noWorkspace.id }, body: { scope: 'workspace', type: 'fact', content: 'x' } })).statusCode).toBe(400);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'foreman.json'), 'utf8')).memories).toEqual([]);
    expect(job.directory).toBe('/repo');
  });

  it('reads and appends activity for only the requested Run', async () => {
    const { call } = setup();
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job', directory: '/repo' } })).body;
    const task = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Task' } })).body;
    const first = (await call('POST', '/api/foreman/tasks/:taskId/runs', { params: { taskId: task.id }, body: {} })).body;
    const otherTask = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Other task' } })).body;
    const second = (await call('POST', '/api/foreman/tasks/:taskId/runs', { params: { taskId: otherTask.id }, body: {} })).body;
    const added = await call('POST', '/api/foreman/runs/:runId/activity', { params: { runId: first.id }, body: { type: 'progress', message: 'Inspecting Foreman execution flow' } });
    expect(added.statusCode).toBe(201);
    expect((await call('GET', '/api/foreman/runs/:runId/activity', { params: { runId: first.id } })).body.activity).toEqual([added.body]);
    expect((await call('GET', '/api/foreman/runs/:runId/activity', { params: { runId: second.id } })).body.activity).toEqual([]);
  });

  it('Task deletion removes its inactive worktree and preserves Foreman state if cleanup fails', async () => {
    const removed = [];
    const { call, store } = setup({ removeWorkspace: async (value) => { removed.push(value); } });
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job' } })).body;
    const task = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Task' } })).body;
    const workspace = { kind: 'git-worktree', directory: '/managed/task-worktree', createdAt: 1 };
    await store.setTaskWorkspace(task.id, workspace);
    const deleted = await call('DELETE', '/api/foreman/tasks/:taskId', { params: { taskId: task.id } });
    expect(deleted.statusCode).toBe(200);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ taskId: task.id, workspace });
    expect((await call('GET', '/api/foreman/state')).body.tasks).toEqual([]);

    const failing = setup({ removeWorkspace: async () => { throw new Error('worktree busy'); } });
    const retainedJob = (await failing.call('POST', '/api/foreman/jobs', { body: { title: 'Retain on failure' } })).body;
    const retained = (await failing.call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: retainedJob.id }, body: { title: 'Retained' } })).body;
    const failure = await failing.call('DELETE', '/api/foreman/tasks/:taskId', { params: { taskId: retained.id } });
    expect(failure.statusCode).toBe(500);
    expect((await failing.call('GET', '/api/foreman/state')).body.tasks[0].id).toBe(retained.id);
  });

  it('refuses Task deletion while its Run is active before calling cleanup', async () => {
    let cleanupCalls = 0;
    const { call, store } = setup({ removeWorkspace: async () => { cleanupCalls += 1; } });
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job' } })).body;
    const task = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Task' } })).body;
    await store.setTaskWorkspace(task.id, { kind: 'git-worktree', directory: '/managed/task-worktree', createdAt: 1 });
    await call('POST', '/api/foreman/tasks/:taskId/runs', { params: { taskId: task.id }, body: {} });
    const result = await call('DELETE', '/api/foreman/tasks/:taskId', { params: { taskId: task.id } });
    expect(result.statusCode).toBe(409);
    expect(cleanupCalls).toBe(0);
    expect((await call('GET', '/api/foreman/state')).body.tasks).toHaveLength(1);
  });

  it('Job deletion removes all Task worktrees and retains the Job on a cleanup failure', async () => {
    const removed = [];
    const { call, store } = setup({ removeWorkspace: async (value) => { removed.push(value); } });
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job' } })).body;
    const first = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'One' } })).body;
    const second = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Two' } })).body;
    await store.setTaskWorkspace(first.id, { kind: 'git-worktree', directory: '/managed/one', createdAt: 1 });
    await store.setTaskWorkspace(second.id, { kind: 'git-worktree', directory: '/managed/two', createdAt: 1 });
    const deleted = await call('DELETE', '/api/foreman/jobs/:jobId', { params: { jobId: job.id } });
    expect(deleted.statusCode).toBe(200);
    expect(removed).toHaveLength(2);
    expect(new Set(removed.map((entry) => entry.taskId))).toEqual(new Set([first.id, second.id]));
    expect((await call('GET', '/api/foreman/state')).body.jobs).toEqual([]);

    const failing = setup({ removeWorkspace: async () => { throw new Error('disk busy'); } });
    const keep = (await failing.call('POST', '/api/foreman/jobs', { body: { title: 'Keep' } })).body;
    const keepTask = (await failing.call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: keep.id }, body: { title: 'Keep task' } })).body;
    const failure = await failing.call('DELETE', '/api/foreman/jobs/:jobId', { params: { jobId: keep.id } });
    expect(failure.statusCode).toBe(500);
    expect((await failing.call('GET', '/api/foreman/state')).body.jobs).toHaveLength(1);
    expect((await failing.call('GET', '/api/foreman/state')).body.tasks[0].id).toBe(keepTask.id);
  });

  it('a state file from a newer version answers 409 everywhere and stays untouched', async () => {
    const { call, dataDir } = setup();
    fs.writeFileSync(path.join(dataDir, 'foreman.json'), JSON.stringify({ version: 9 }));
    const state = await call('GET', '/api/foreman/state');
    expect(state.statusCode).toBe(409);
    expect(state.body.code).toBe('unsupported_version');
    expect((await call('POST', '/api/foreman/jobs', { body: { title: 'x' } })).statusCode).toBe(409);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'foreman.json'), 'utf8'))).toEqual({ version: 9 });
  });

  it('run status patches carry attention only while waiting', async () => {
    const { call } = setup();
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job' } })).body;
    const task = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Task' } })).body;
    const run = (await call('POST', '/api/foreman/tasks/:taskId/runs', { params: { taskId: task.id }, body: {} })).body;
    const waiting = await call('PATCH', '/api/foreman/runs/:runId', {
      params: { runId: run.id }, body: { status: 'waiting_for_user', attention: { type: 'permission', message: 'ok?' } },
    });
    expect(waiting.body.attention).toEqual({ type: 'permission', message: 'ok?' });
    const done = await call('PATCH', '/api/foreman/runs/:runId', { params: { runId: run.id }, body: { status: 'completed' } });
    expect(done.body.attention).toBeUndefined();
    expect(done.body.finishedAt).toBeGreaterThan(0);
  });

  it('start answers 201 the first time and 200 with the same session after that', async () => {
    const { call, sessions, prompts } = setup();
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job', directory: '/repo' } })).body;
    const task = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Task' } })).body;
    const run = (await call('POST', '/api/foreman/tasks/:taskId/runs', { params: { taskId: task.id }, body: { requestId: 'r1' } })).body;
    const first = await call('POST', '/api/foreman/runs/:runId/start', { params: { runId: run.id } });
    expect(first.statusCode).toBe(201);
    expect(first.body.run).toMatchObject({ status: 'running', execution: { id: 'ses_1' } });
    const second = await call('POST', '/api/foreman/runs/:runId/start', { params: { runId: run.id } });
    expect(second.statusCode).toBe(200);
    expect(second.body.alreadyStarted).toBe(true);
    expect(sessions).toEqual(['/repo']);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('LSP/language-server or other structured code-intelligence tools first');
    expect(prompts[0]).toContain('search for and read only files relevant to this task');
    expect(prompts[0]).toContain('Use shell for execution, tests, builds, Git, and runtime commands');
    expect((await call('PATCH', '/api/foreman/runs/:runId', { params: { runId: run.id }, body: { status: 'completed' } })).statusCode).toBe(409);
    expect((await call('POST', '/api/foreman/runs/:runId/start', { params: { runId: 'nope' } })).statusCode).toBe(404);
  });

  it('stop interrupts the session once and answers the same on a repeat', async () => {
    const { call, interrupts } = setup();
    const job = (await call('POST', '/api/foreman/jobs', { body: { title: 'Job', directory: '/repo' } })).body;
    const task = (await call('POST', '/api/foreman/jobs/:jobId/tasks', { params: { jobId: job.id }, body: { title: 'Task' } })).body;
    const run = (await call('POST', '/api/foreman/tasks/:taskId/runs', { params: { taskId: task.id }, body: {} })).body;
    const queued = await call('POST', '/api/foreman/runs/:runId/stop', { params: { runId: run.id } });
    expect(queued.statusCode).toBe(409);
    await call('POST', '/api/foreman/runs/:runId/start', { params: { runId: run.id } });
    const first = await call('POST', '/api/foreman/runs/:runId/stop', { params: { runId: run.id } });
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ stopped: true, run: { status: 'cancelled' } });
    const second = await call('POST', '/api/foreman/runs/:runId/stop', { params: { runId: run.id } });
    expect(second.body).toMatchObject({ stopped: false, run: { status: 'cancelled' } });
    expect(interrupts).toEqual(['ses_1']);
  });
});
