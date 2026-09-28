import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createForemanScheduler, foremanGlobalConcurrency } from './scheduler.js';
import { createForemanStore } from './store.js';

const makeStore = () => createForemanStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-scheduler-')), warn: () => {} });

describe('Foreman task scheduler', () => {
  it('enforces per-Job and global capacity while allowing independent Tasks', async () => {
    const store = makeStore();
    const jobA = await store.createJob({ title: 'A', maxParallelTasks: 1 });
    const jobB = await store.createJob({ title: 'B' });
    const taskA = await store.createTask(jobA.id, { title: 'A1' });
    const taskA2 = await store.createTask(jobA.id, { title: 'A2' });
    const taskB = await store.createTask(jobB.id, { title: 'B1' });
    const runA = await store.createRun(taskA.id);
    const runA2 = await store.createRun(taskA2.id);
    const runB = await store.createRun(taskB.id);
    const scheduler = createForemanScheduler({ store, globalLimit: 2 });
    const reservationA = await scheduler.reserve(runA.id);
    await expect(scheduler.reserve(runA2.id)).rejects.toMatchObject({ code: 'conflict' });
    const reservationB = await scheduler.reserve(runB.id);
    await expect(scheduler.capacity()).resolves.toMatchObject({ active: 2, globalLimit: 2, available: 0 });
    await expect(scheduler.reserve(runB.id)).rejects.toMatchObject({ code: 'conflict' });
    reservationA.release();
    reservationB.release();
  });

  it('uses the conservative global default cap of three', async () => {
    expect(foremanGlobalConcurrency(undefined)).toBe(3);
    expect(foremanGlobalConcurrency('')).toBe(3);
  });

  it('parses configured global capacity and falls back for invalid values', () => {
    expect(foremanGlobalConcurrency('5')).toBe(5);
    expect(foremanGlobalConcurrency('0')).toBe(3);
    expect(foremanGlobalConcurrency('not-a-number')).toBe(3);
  });

  it('respects the configured global cap when reserving Runs', async () => {
    const store = makeStore();
    const job = await store.createJob({ title: 'Configured' });
    const first = await store.createTask(job.id, { title: 'First' });
    const second = await store.createTask(job.id, { title: 'Second' });
    const firstRun = await store.createRun(first.id);
    const secondRun = await store.createRun(second.id);
    const scheduler = createForemanScheduler({ store, globalLimit: foremanGlobalConcurrency('1') });
    const reservation = await scheduler.reserve(firstRun.id);
    await expect(scheduler.reserve(secondRun.id)).rejects.toThrow(/global parallel limit \(1\)/);
    reservation.release();
  });
});
