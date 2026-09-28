/**
 * HTTP surface for the Foreman store. Thin by design: parse the request,
 * call the store, map its errors to status codes. Domain rules live in
 * `store.js`.
 */

import express from 'express';

import { ForemanStoreError } from './store.js';

const parseJsonBody = express.json({ limit: '1mb' });

const STATUS_BY_CODE = {
  invalid_input: 400,
  not_found: 404,
  unsupported_version: 409,
  conflict: 409,
  abort_failed: 502,
};

const respondError = (res, error) => {
  if (error instanceof ForemanStoreError) {
    return res.status(STATUS_BY_CODE[error.code] ?? 500).json({ error: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : 'Foreman request failed';
  return res.status(500).json({ error: message });
};

/**
 * @param {import('express').Express} app
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createForemanStore>,
 *   execution: ReturnType<typeof import('./execution.js').createForemanExecution>,
 *   taskWorkspaceManager: { remove: (args: { jobId: string, taskId: string, workspace?: object }) => Promise<void> },
 *   validateDirectoryPath: (directory: string) => Promise<{ ok: boolean, directory?: string, error?: string }>,
 * }} dependencies
 */
export const registerForemanRoutes = (app, { store, execution, validateDirectoryPath, taskWorkspaceManager = { remove: async () => {} } }) => {
  const workspaceForJob = async (jobId) => {
    const { job } = await store.jobContext(jobId);
    if (!job.directory) throw new ForemanStoreError('invalid_input', 'This job has no workspace directory');
    const validated = await validateDirectoryPath(job.directory);
    if (!validated?.ok || !validated.directory) {
      throw new ForemanStoreError('invalid_input', `The job's workspace is not usable: ${validated?.error || job.directory}`);
    }
    return validated.directory;
  };
  app.get('/api/foreman/state', async (_req, res) => {
    try {
      return res.json(await store.snapshot());
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.post('/api/foreman/jobs', parseJsonBody, async (req, res) => {
    try {
      return res.status(201).json(await store.createJob(req.body));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.patch('/api/foreman/jobs/:jobId', parseJsonBody, async (req, res) => {
    try {
      return res.json(await store.updateJob(req.params.jobId, req.body));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.post('/api/foreman/jobs/:jobId/tasks', parseJsonBody, async (req, res) => {
    try {
      return res.status(201).json(await store.createTask(req.params.jobId, req.body));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.patch('/api/foreman/tasks/:taskId', parseJsonBody, async (req, res) => {
    try {
      return res.json(await store.updateTask(req.params.taskId, req.body));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.delete('/api/foreman/tasks/:taskId', async (req, res) => {
    try {
      const task = await store.deleteTask(req.params.taskId, (entry) => taskWorkspaceManager.remove({
        jobId: entry.jobId, taskId: entry.id, workspace: entry.workspace,
      }));
      return res.json({ task });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.delete('/api/foreman/jobs/:jobId', async (req, res) => {
    try {
      const job = await store.deleteJob(req.params.jobId, (task) => taskWorkspaceManager.remove({
        jobId: task.jobId, taskId: task.id, workspace: task.workspace,
      }));
      return res.json({ job });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.post('/api/foreman/tasks/:taskId/runs', parseJsonBody, async (req, res) => {
    try {
      return res.status(201).json(await store.createRun(req.params.taskId, req.body ?? {}));
    } catch (error) {
      return respondError(res, error);
    }
  });

  // Starts a queued run: one OpenCode session, the task sent to it. Safe to
  // repeat: a run that has a session answers with it and makes no other.
  app.post('/api/foreman/runs/:runId/start', async (req, res) => {
    try {
      const { run, alreadyStarted } = await execution.startRun(req.params.runId);
      return res.status(alreadyStarted ? 200 : 201).json({ run, alreadyStarted });
    } catch (error) {
      return respondError(res, error);
    }
  });

  // Stops an active run by interrupting its session. Safe to repeat: a run
  // that is not running answers with itself and nothing is interrupted.
  app.post('/api/foreman/runs/:runId/stop', async (req, res) => {
    try {
      return res.json(await execution.stopRun(req.params.runId));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.get('/api/foreman/runs/:runId/activity', async (req, res) => {
    try {
      return res.json({ activity: await store.activityForRun(req.params.runId) });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.post('/api/foreman/runs/:runId/activity', parseJsonBody, async (req, res) => {
    try {
      return res.status(201).json(await store.addRunActivity(req.params.runId, req.body));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.patch('/api/foreman/runs/:runId', parseJsonBody, async (req, res) => {
    try {
      return res.json(await store.updateRun(req.params.runId, req.body));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.get('/api/foreman/jobs/:jobId/memories', async (req, res) => {
    try {
      const workspaceId = await workspaceForJob(req.params.jobId);
      const memories = await store.listMemoriesForJob(req.params.jobId, workspaceId);
      return res.json({ memories });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.post('/api/foreman/jobs/:jobId/memories', parseJsonBody, async (req, res) => {
    try {
      const workspaceId = await workspaceForJob(req.params.jobId);
      const memory = await store.createMemory(req.params.jobId, workspaceId, req.body);
      return res.status(201).json(memory);
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.patch('/api/foreman/memories/:memoryId', parseJsonBody, async (req, res) => {
    try {
      return res.json(await store.updateMemory(req.params.memoryId, req.body));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.delete('/api/foreman/memories/:memoryId', async (req, res) => {
    try {
      return res.json({ memory: await store.deleteMemory(req.params.memoryId) });
    } catch (error) {
      return respondError(res, error);
    }
  });
};
