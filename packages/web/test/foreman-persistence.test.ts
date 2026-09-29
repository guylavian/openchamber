/**
 * Foreman persistence golden test.
 *
 * Every Foreman file version the store has ever written (1 to 5), a file from
 * a newer OpenChamber, and unreadable files are loaded through the store; every
 * read it offers is recorded, then one mutation makes it write the file back.
 * A scripted scenario drives each mutation path on top of a version 5 file.
 * The recordings, including the exact bytes written, must match the expected
 * files in fixtures/foreman-persistence/expected byte for byte. They were
 * produced by the JavaScript store before its TypeScript migration. Every id
 * is deterministic (injected generator, and a fixed crypto.randomUUID sequence
 * for activity events), so field order, ids and where they appear, defaults,
 * migrations, serialization and mutation behaviour are all compared. A
 * difference means persisted state would change for someone who already uses
 * Foreman.
 *
 * Regenerate only for an intended persistence change:
 *   FOREMAN_GOLDEN_UPDATE=1 bunx vitest run test/foreman-persistence.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FOREMAN_FILE_NAME, createForemanStore } from '../server/lib/foreman/store.js';
import type { JobId, MemoryId, RunId, SessionId, TaskId } from '../server/lib/foreman/types.js';

const root = fileURLToPath(new URL('./fixtures/foreman-persistence/', import.meta.url));
const inputDir = path.join(root, 'input');
const expectedDir = path.join(root, 'expected');
const UPDATE = process.env.FOREMAN_GOLDEN_UPDATE === '1';

/** A value a store read threw: an error, or whatever else was thrown. */
interface Thrown {
  code?: unknown;
  name?: unknown;
  message?: unknown;
}

const prepare = (fixture: string | null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-golden-'));
  if (fixture) fs.copyFileSync(path.join(inputDir, fixture), path.join(dir, FOREMAN_FILE_NAME));
  let tick = 10_000;
  let ids = 0;
  const warnings: string[] = [];
  const store = createForemanStore({
    dataDir: dir,
    now: () => (tick += 1),
    randomUUID: () => `gen-${(ids += 1)}`,
    warn: (message) => warnings.push(message.replaceAll(dir, '<dir>')),
  });
  const recording: Record<string, unknown> = {};
  const record = async (label: string, read: () => unknown): Promise<void> => {
    try {
      recording[label] = await read();
    } catch (error) {
      recording[label] = { thrown: (error as Thrown | null | undefined)?.code ?? (error as Thrown | null | undefined)?.name, message: String((error as Thrown | null | undefined)?.message).replaceAll(dir, '<dir>') };
    }
  };
  const finish = () => {
    const file = path.join(dir, FOREMAN_FILE_NAME);
    recording.fileAfter = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    recording.dataDirEntries = fs.readdirSync(dir).sort();
    recording.warnings = warnings;
    fs.rmSync(dir, { recursive: true, force: true });
    return recording;
  };
  return { store, record, finish };
};

const observeFixture = async (fixture: string | null) => {
  const { store, record, finish } = prepare(fixture);
  await record('snapshot', () => store.snapshot());
  const state = await store.snapshot().catch(() => null);
  if (state) {
    for (const run of state.runs) {
      await record(`runContext:${run.id}`, () => store.runContext(run.id));
      await record(`activity:${run.id}`, () => store.activityForRun(run.id));
      if (run.execution?.id) await record(`runsForExecution:${run.execution.id}`, () => store.runsForExecution('opencode-session', run.execution!.id!));
    }
    for (const task of state.tasks) await record(`taskContext:${task.id}`, () => store.taskContext(task.id));
    for (const job of state.jobs) {
      await record(`jobContext:${job.id}`, () => store.jobContext(job.id));
      if (job.directory) {
        await record(`memories:${job.id}`, () => store.listMemoriesForJob(job.id, job.directory!));
        await record(`relevantMemories:${job.id}`, () => store.relevantMemories({
          jobId: job.id,
          workspaceId: job.directory!,
          query: `${job.title} ${job.goal ?? ''} persistence tests scripts/test.sh lib/foreman/store.js`,
        }));
      }
    }
    await record('activeExecutions', () => store.activeExecutions());
  }
  const firstJob = state?.jobs[0];
  await record('mutation', () => (firstJob ? store.updateJob(firstJob.id, { title: firstJob.title }) : store.createJob({ title: 'First write' })));
  await record('snapshotAfterMutation', () => store.snapshot());
  return finish();
};

const observeScenario = async () => {
  const { store, record, finish } = prepare('v5.json');
  await record('createTask', () => store.createTask('job-g' as JobId, { title: '  Verify  ', instructions: 'Check the build', dependsOn: ['task-g5'] }));
  await record('updateTask', () => store.updateTask('task-g3' as TaskId, { instructions: null, dependsOn: ['task-g1'] }));
  await record('updateTaskCycle', () => store.updateTask('task-g1' as TaskId, { dependsOn: ['task-g4'] }));
  await record('createRun', () => store.createRun('task-g3' as TaskId, { requestId: 'req-g3' }));
  await record('createRunAgain', () => store.createRun('task-g3' as TaskId, { requestId: 'req-g3' }));
  await record('startIntent', () => store.applyExecutionChange('gen-2' as RunId, () => ({ execution: { type: 'opencode-session', createdAt: 1 } })));
  await record('sessionLinked', () => store.applyExecutionChange('gen-2' as RunId, (current) => ({ execution: { type: 'opencode-session', id: 'ses_g3' as SessionId, directory: '/repo/g', createdAt: current.execution!.createdAt } })));
  await record('running', () => store.applyExecutionChange('gen-2' as RunId, () => ({ status: 'running' })));
  await record('waiting', () => store.applyExecutionChange('gen-2' as RunId, () => ({ status: 'waiting_for_user', attention: { type: 'permission', message: 'Allow npm publish?' } })));
  await record('resolved', () => store.applyExecutionChange('gen-2' as RunId, () => ({ status: 'running' })));
  await record('progress', () => store.addRunActivity('gen-2' as RunId, { type: 'progress', message: 'Packing', metadata: { step: 2, dryRun: false } }));
  await record('failed', () => store.applyExecutionChange('gen-2' as RunId, () => ({ status: 'failed', error: { stage: 'execution', message: 'npm ERR! 403' } })));
  await record('deleted', () => store.applyExecutionChange('gen-2' as RunId, (current) => ({ execution: { ...current.execution!, deletedAt: 2 }, activityEvent: { type: 'progress', message: 'OpenCode session deleted' } })));
  await record('manualRunBlocked', () => store.createRun('task-g5' as TaskId));
  await record('updateRunExecuting', () => store.updateRun('run-g5-1' as RunId, { status: 'completed' }));
  const manualTask = await store.createTask('job-g' as JobId, { title: 'Manual check' });
  const manualRun = await store.createRun(manualTask!.id);
  await record('updateRunWaiting', () => store.updateRun(manualRun.id, { status: 'waiting_for_user', attention: { type: 'question', message: 'Looks right?' } }));
  await record('updateRunAttentionOutsideWaiting', () => store.updateRun(manualRun.id, { status: 'running', attention: { type: 'question' } }));
  await record('updateRunRunning', () => store.updateRun(manualRun.id, { status: 'running' }));
  await record('updateRunCompleted', () => store.updateRun(manualRun.id, { status: 'completed' }));
  await record('setWorkspace', () => store.setTaskWorkspace('task-g3' as TaskId, { kind: 'shared-directory', directory: '/repo/g', createdAt: 3 }));
  await record('createMemory', () => store.createMemory('job-g' as JobId, '/repo/g', { scope: 'job', type: 'decision', content: 'Publish from CI only', tags: ['ci', 'ci', 'release'] }));
  await record('createMemoryWrongWorkspace', () => store.createMemory('job-g' as JobId, '/elsewhere', { scope: 'workspace', type: 'fact', content: 'x' }));
  await record('updateMemory', () => store.updateMemory('mem-g' as MemoryId, { confidence: 0.95, tags: ['tests'] }));
  const scratch = await store.createMemory('job-g' as JobId, '/repo/g', { scope: 'workspace', type: 'fact', content: 'Temporary note' });
  await record('deleteMemory', () => store.deleteMemory(scratch.id));
  await record('updateJob', () => store.updateJob('job-g' as JobId, { goal: null, maxParallelTasks: 4, status: 'waiting' }));
  await record('createJob', () => store.createJob({ title: 'Follow-up', directory: '/repo/g', maxParallelTasks: 1 }));
  await record('deleteTask', () => store.deleteTask('task-g4' as TaskId));
  await record('snapshot', () => store.snapshot());
  return finish();
};

const FIXTURES = ['v1.json', 'v2.json', 'v3.json', 'v4.json', 'v5.json', 'v6-future.json', 'corrupt.json', 'invalid-memory.json', null];

const compare = (name: string, value: unknown): void => {
  const actual = `${JSON.stringify(value, null, 2)}\n`;
  const expectedPath = path.join(expectedDir, `${name}.json`);
  if (UPDATE) {
    fs.mkdirSync(expectedDir, { recursive: true });
    fs.writeFileSync(expectedPath, actual);
    return;
  }
  expect(actual).toBe(fs.readFileSync(expectedPath, 'utf8'));
};

describe('foreman persistence golden files', () => {
  // Run and memory ids come from the store's injected generator (see prepare).
  // Activity event ids come from crypto.randomUUID() itself, so it is replaced
  // here with a fixed sequence, for this test only; production is untouched.
  beforeEach(() => {
    let next = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String((next += 1)).padStart(12, '0')}`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const fixture of FIXTURES) {
    const name = fixture ? fixture.replace(/\.json$/, '') : 'no-file';
    it(`loads, reads and rewrites ${name} exactly as before`, async () => {
      compare(name, await observeFixture(fixture));
    });
  }

  it('applies every mutation path to a version 5 file exactly as before', async () => {
    compare('scenario-v5', await observeScenario());
  });
});
