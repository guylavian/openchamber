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
 * @param {{ store: ReturnType<typeof import('./store.js').createForemanStore> }} dependencies
 */
export const registerForemanRoutes = (app, { store }) => {
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

  app.post('/api/foreman/tasks/:taskId/runs', parseJsonBody, async (req, res) => {
    try {
      return res.status(201).json(await store.createRun(req.params.taskId, req.body ?? {}));
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
};
