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
    app: { get: register('GET'), post: register('POST'), patch: register('PATCH') },
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

const setup = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-routes-'));
  const store = createForemanStore({ dataDir, warn: () => {} });
  const sessions = [];
  const execution = createForemanExecution({
    store,
    sessionService: {
      create: async ({ directory }) => { sessions.push(directory); return { sessionId: `ses_${sessions.length}`, directory }; },
      send: async () => ({ promptDispatched: true }),
    },
    validateDirectoryPath: async (directory) => ({ ok: Boolean(directory), directory }),
    activityProbe: { fetchActiveSessionStatuses: async () => ({}), hasWorkingChildren: async () => false },
    readSessionOutcome: async () => 'unknown',
    warn: () => {},
  });
  const harness = createApp();
  registerForemanRoutes(harness.app, { store, execution });
  return { ...harness, dataDir, sessions };
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
    const { call, sessions } = setup();
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
    expect((await call('PATCH', '/api/foreman/runs/:runId', { params: { runId: run.id }, body: { status: 'completed' } })).statusCode).toBe(409);
    expect((await call('POST', '/api/foreman/runs/:runId/start', { params: { runId: 'nope' } })).statusCode).toBe(404);
  });
});
