import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createForemanExecution, runChangeForEvent, taskPrompt } from './execution.js';
import { createForemanStore } from './store.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-exec-'));

/**
 * The session service as the server has it: create makes a session in a
 * directory, send queues a prompt. Records every call, so a test can count
 * sessions and read what each one was sent.
 */
const createFakeSessionService = ({ failCreate = false, failSend = false, notQueued = false, createDelayMs = 0 } = {}) => {
  const sessions = [];
  const sends = [];
  return {
    sessions,
    sends,
    async create({ directory, title }) {
      if (createDelayMs) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
      if (failCreate) throw new Error('OpenCode is not running');
      const sessionId = `ses_${sessions.length + 1}`;
      sessions.push({ sessionId, directory, title });
      return { sessionId, directory };
    },
    async send(sessionId, { prompt, directory }) {
      if (failSend) throw new Error('No model is configured or available for the requested directory');
      sends.push({ sessionId, prompt, directory });
      return notQueued
        ? { promptDispatched: false, promptError: 'OpenCode accepted the prompt but returned no queued message' }
        : { promptDispatched: true };
    },
  };
};

const createFakeProbe = ({ active = {}, workingChildren = false } = {}) => ({
  active,
  workingChildren,
  async fetchActiveSessionStatuses() { return this.active; },
  async hasWorkingChildren() { return this.workingChildren; },
});

const setup = async ({ directory, service = createFakeSessionService(), probe = createFakeProbe(), outcome = 'unknown', jobDirectory } = {}) => {
  const dataDir = tempDir();
  const workspace = directory ?? tempDir();
  const store = createForemanStore({ dataDir, warn: () => {} });
  const broadcasts = [];
  const make = (overrides = {}) => createForemanExecution({
    store,
    sessionService: service,
    validateDirectoryPath: async (dir) => (dir && fs.existsSync(dir)
      ? { ok: true, directory: dir }
      : { ok: false, error: 'Directory does not exist' }),
    activityProbe: probe,
    readSessionOutcome: async () => outcome,
    broadcast: (event) => broadcasts.push(event),
    warn: () => {},
    ...overrides,
  });
  const execution = make();
  const job = await store.createJob({ title: 'Fix average', directory: jobDirectory === undefined ? workspace : jobDirectory || undefined });
  const task = await store.createTask(job.id, { title: 'Empty list', instructions: 'Make average([]) return None and run the tests.' });
  const run = await store.createRun(task.id);
  return { dataDir, workspace, store, execution, make, service, probe, broadcasts, job, task, run };
};

/** Lets the per-session event queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const event = (type, properties) => ({ type, properties });

describe('starting a run', () => {
  it('creates exactly one session in the job directory, sends the task instructions, and records the link', async () => {
    const { execution, service, store, run, workspace, broadcasts } = await setup();
    const { run: started, alreadyStarted } = await execution.startRun(run.id);
    expect(alreadyStarted).toBe(false);
    expect(service.sessions).toEqual([{ sessionId: 'ses_1', directory: workspace, title: 'Fix average: Empty list' }]);
    expect(service.sends).toEqual([{ sessionId: 'ses_1', prompt: 'Make average([]) return None and run the tests.', directory: workspace }]);
    expect(started.status).toBe('running');
    expect(started.startedAt).toBeGreaterThan(0);
    expect(started.execution).toMatchObject({ type: 'opencode-session', id: 'ses_1', directory: workspace });
    expect((await store.snapshot()).runs[0].execution.id).toBe('ses_1');
    expect(broadcasts.length).toBeGreaterThan(0);
  });

  it('a task without instructions sends its title', () => {
    expect(taskPrompt({ title: 'Do the thing' })).toBe('Do the thing');
    expect(taskPrompt({ title: 'T', instructions: '  exact words  ' })).toBe('exact words');
  });

  it('concurrent starts (double click, retry) make one session', async () => {
    const service = createFakeSessionService({ createDelayMs: 30 });
    const { execution, run } = await setup({ service });
    const results = await Promise.all([execution.startRun(run.id), execution.startRun(run.id), execution.startRun(run.id)]);
    expect(service.sessions).toHaveLength(1);
    expect(service.sends).toHaveLength(1);
    expect(new Set(results.map((result) => result.run.execution.id))).toEqual(new Set(['ses_1']));
    expect(results.filter((result) => !result.alreadyStarted)).toHaveLength(1);
  });

  it('a started run answers with its session and never makes another', async () => {
    const { execution, service, run } = await setup();
    await execution.startRun(run.id);
    const again = await execution.startRun(run.id);
    expect(again.alreadyStarted).toBe(true);
    expect(again.run.execution.id).toBe('ses_1');
    expect(service.sessions).toHaveLength(1);
  });

  it('after a restart the same start request still makes no second session', async () => {
    const { execution, service, run, make } = await setup();
    await execution.startRun(run.id);
    const restarted = make();
    const again = await restarted.startRun(run.id);
    expect(again.alreadyStarted).toBe(true);
    expect(service.sessions).toHaveLength(1);
  });

  it('a job without a workspace is refused and the run stays queued', async () => {
    const { execution, service, store, run } = await setup({ jobDirectory: '' });
    await expect(execution.startRun(run.id)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(service.sessions).toHaveLength(0);
    const stored = (await store.snapshot()).runs[0];
    expect(stored.status).toBe('queued');
    expect(stored.execution).toBeUndefined();
  });

  it('a workspace that no longer exists is refused before anything is recorded', async () => {
    const { execution, service, store, run } = await setup({ jobDirectory: '/definitely/not/here' });
    await expect(execution.startRun(run.id)).rejects.toThrow('not usable');
    expect(service.sessions).toHaveLength(0);
    expect((await store.snapshot()).runs[0].status).toBe('queued');
  });

  it('session creation failing gives a failed run with no link, never running', async () => {
    const { execution, run } = await setup({ service: createFakeSessionService({ failCreate: true }) });
    const { run: result } = await execution.startRun(run.id);
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({ stage: 'session', message: 'OpenCode is not running' });
    expect(result.execution).toBeUndefined();
    expect(result.startedAt).toBeUndefined();
  });

  it('the send failing keeps the session linked and says the task never reached it', async () => {
    const service = createFakeSessionService({ failSend: true });
    const { execution, run } = await setup({ service });
    const { run: result } = await execution.startRun(run.id);
    expect(service.sessions).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.error.stage).toBe('dispatch');
    expect(result.execution.id).toBe('ses_1');
    expect(result.startedAt).toBeUndefined();
  });

  it('a prompt OpenCode did not queue is a failed dispatch, not running', async () => {
    const { execution, run } = await setup({ service: createFakeSessionService({ notQueued: true }) });
    const { run: result } = await execution.startRun(run.id);
    expect(result.status).toBe('failed');
    expect(result.error.message).toMatch(/no queued message/);
  });

  it('only a queued run starts: a finished one needs a new run', async () => {
    const { execution, store, run } = await setup();
    await store.updateRun(run.id, { status: 'cancelled' });
    await expect(execution.startRun(run.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a start interrupted before its session was recorded is closed, not repeated', async () => {
    const { execution, service, store, run } = await setup();
    await store.applyExecutionChange(run.id, () => ({ execution: { type: 'opencode-session', createdAt: 1 } }));
    const { run: result } = await execution.startRun(run.id);
    expect(service.sessions).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.error.stage).toBe('session');
  });
});

describe('status follows the session', () => {
  const startedRun = async (options) => {
    const context = await setup(options);
    await context.execution.startRun(context.run.id);
    const current = async () => (await context.store.snapshot()).runs[0];
    return { ...context, current };
  };

  it('a permission request waits for the user, the reply resumes it', async () => {
    const { execution, current } = await startedRun();
    execution.processPayload(event('permission.asked', { sessionID: 'ses_1', id: 'p1', action: 'edit average.py' }));
    await settle();
    expect(await current()).toMatchObject({ status: 'waiting_for_user', attention: { type: 'permission', message: 'edit average.py' } });
    // A busy signal while waiting does not answer the question.
    execution.processPayload(event('session.status', { sessionID: 'ses_1', status: { type: 'busy' } }));
    await settle();
    expect((await current()).status).toBe('waiting_for_user');
    execution.processPayload(event('permission.replied', { sessionID: 'ses_1', requestID: 'p1' }));
    await settle();
    const resumed = await current();
    expect(resumed.status).toBe('running');
    expect(resumed.attention).toBeUndefined();
  });

  it('a question (form) waits for the user until it is settled', async () => {
    const { execution, current } = await startedRun();
    execution.processPayload(event('form.created', { sessionID: 'ses_1', form: { id: 'f1', title: 'Which file?' } }));
    await settle();
    expect(await current()).toMatchObject({ status: 'waiting_for_user', attention: { type: 'question', message: 'Which file?' } });
    execution.processPayload(event('form.settled', { sessionID: 'ses_1', formID: 'f1' }));
    await settle();
    expect((await current()).status).toBe('running');
  });

  it('the turn ending with no working subagents completes the run', async () => {
    const { execution, current } = await startedRun();
    execution.processPayload(event('session.idle', { sessionID: 'ses_1' }));
    await settle();
    const done = await current();
    expect(done.status).toBe('completed');
    expect(done.finishedAt).toBeGreaterThan(0);
  });

  it('a turn that pauses for a subagent is not the end', async () => {
    const probe = createFakeProbe({ workingChildren: true });
    const { execution, current } = await startedRun({ probe });
    execution.processPayload(event('session.idle', { sessionID: 'ses_1' }));
    await settle();
    expect((await current()).status).toBe('running');
  });

  it('when OpenCode cannot be asked about subagents, completion is not claimed', async () => {
    const probe = createFakeProbe({ active: null });
    const { execution, current } = await startedRun({ probe });
    execution.processPayload(event('session.idle', { sessionID: 'ses_1' }));
    await settle();
    expect((await current()).status).toBe('running');
  });

  it('a failed turn fails the run with the reason; a user stop cancels it', async () => {
    const { execution, current } = await startedRun();
    execution.processPayload(event('session.error', { sessionID: 'ses_1', error: { name: 'ProviderError', message: 'rate limited' } }));
    await settle();
    expect(await current()).toMatchObject({ status: 'failed', error: { stage: 'execution', message: 'rate limited' } });
    execution.processPayload(event('session.status', { sessionID: 'ses_1', status: { type: 'busy' } }));
    await settle();
    const again = await current();
    expect(again.status).toBe('running');
    expect(again.error).toBeUndefined();
    execution.processPayload(event('session.idle', { sessionID: 'ses_1', aborted: true, reason: 'user' }));
    await settle();
    expect((await current()).status).toBe('cancelled');
  });

  it('events for other sessions leave the run alone, and ordinary sessions are never tracked', async () => {
    const { execution, store, current } = await startedRun();
    execution.processPayload(event('session.idle', { sessionID: 'ses_other' }));
    execution.processPayload(event('permission.asked', { sessionID: 'ses_other', id: 'p' }));
    await settle();
    expect((await current()).status).toBe('running');
    expect(await store.runsForExecution('opencode-session', 'ses_other')).toEqual([]);
  });

  it('events apply in order even when one needs a slow OpenCode lookup', async () => {
    const probe = createFakeProbe();
    probe.fetchActiveSessionStatuses = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {};
    };
    const { execution, current } = await startedRun({ probe });
    execution.processPayload(event('session.idle', { sessionID: 'ses_1' }));
    execution.processPayload(event('session.status', { sessionID: 'ses_1', status: { type: 'busy' } }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await current()).status).toBe('running');
  });

  it('a deleted session fails an active run and marks the reference deleted', async () => {
    const { execution, current } = await startedRun();
    execution.processPayload(event('session.deleted', { sessionID: 'ses_1' }));
    await settle();
    const run = await current();
    expect(run).toMatchObject({ status: 'failed', error: { stage: 'execution' }, execution: { id: 'ses_1' } });
    expect(run.execution.deletedAt).toBeGreaterThan(0);
  });

  it('a deleted session leaves a finished run finished, but marks the reference deleted', async () => {
    const { execution, current } = await startedRun();
    execution.processPayload(event('session.idle', { sessionID: 'ses_1' }));
    await settle();
    execution.processPayload(event('session.deleted', { sessionID: 'ses_1' }));
    await settle();
    const run = await current();
    expect(run.status).toBe('completed');
    expect(run.execution.deletedAt).toBeGreaterThan(0);
  });

  it('the event mapping ignores what it cannot trust', () => {
    expect(runChangeForEvent(event('session.status', { sessionID: 's', status: { type: 'idle' } }))).toBeNull();
    expect(runChangeForEvent(event('message.updated', { sessionID: 's' }))).toBeNull();
    expect(runChangeForEvent(event('session.idle', {}))).toBeNull();
  });
});

describe('restart reconciliation', () => {
  const afterRestart = async ({ status = 'running', active = {}, outcome, workingChildren = false, execution: executionRef } = {}) => {
    const context = await setup({ outcome, probe: createFakeProbe({ active, workingChildren }) });
    await context.store.applyExecutionChange(context.run.id, () => {
      const next = { execution: executionRef ?? { type: 'opencode-session', id: 'ses_1', directory: context.workspace, createdAt: 1 } };
      if (status !== 'queued') next.status = status;
      return next;
    });
    const restarted = context.make();
    await restarted.reconcile();
    return { ...context, run: (await context.store.snapshot()).runs[0] };
  };

  it('a session still running keeps the run running', async () => {
    const { run, service } = await afterRestart({ active: { ses_1: { type: 'busy' } } });
    expect(run.status).toBe('running');
    expect(service.sessions).toHaveLength(0);
  });

  it('a session that finished while the server was down completes the run', async () => {
    const { run } = await afterRestart({ outcome: 'succeeded' });
    expect(run.status).toBe('completed');
  });

  it('a session that no longer exists fails the run and keeps the reference', async () => {
    const { run } = await afterRestart({ outcome: 'missing' });
    expect(run).toMatchObject({ status: 'failed', error: { stage: 'execution' }, execution: { id: 'ses_1' } });
    expect(run.execution.deletedAt).toBeGreaterThan(0);
  });

  it('an unknown outcome leaves the run as it was', async () => {
    const { run } = await afterRestart({ outcome: 'unknown' });
    expect(run.status).toBe('running');
  });

  it('a session with a working subagent is not settled', async () => {
    const { run } = await afterRestart({ outcome: 'succeeded', workingChildren: true });
    expect(run.status).toBe('running');
  });

  it('when OpenCode cannot be asked nothing changes', async () => {
    const context = await setup({ probe: createFakeProbe({ active: null }), outcome: 'missing' });
    await context.store.applyExecutionChange(context.run.id, () => ({
      execution: { type: 'opencode-session', id: 'ses_1', createdAt: 1 }, status: 'running',
    }));
    await context.make().reconcile();
    expect((await context.store.snapshot()).runs[0].status).toBe('running');
  });

  it('reconciliation never creates a session', async () => {
    const { service } = await afterRestart({ outcome: 'succeeded' });
    expect(service.sessions).toHaveLength(0);
    expect(service.sends).toHaveLength(0);
  });
});
