/**
 * Type-level regression tests. These fail at type-check time
 * (`tsc -p tsconfig.server.json`), not at run time: they pin that Foreman's
 * identifiers cannot stand in for each other, that each store, scheduler and
 * execution entry point takes the identifier of its own kind, and the unions.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { createForemanExecution, EventRunChange } from './execution.js';
import type { ExecutionTruth } from './execution-truth.js';
import type { createForemanScheduler } from './scheduler.js';
import type { ForemanStore, RunStatus } from './store.js';
import type { JobId, MemoryId, RunId, SessionId, TaskId } from './types.js';

type ForemanExecution = ReturnType<typeof createForemanExecution>;
type ForemanScheduler = ReturnType<typeof createForemanScheduler>;

describe('Foreman identifiers', () => {
  it('each kind is distinct from every other kind and from a bare string', () => {
    expectTypeOf<JobId>().not.toExtend<TaskId>();
    expectTypeOf<TaskId>().not.toExtend<JobId>();
    expectTypeOf<RunId>().not.toExtend<TaskId>();
    expectTypeOf<SessionId>().not.toExtend<RunId>();
    expectTypeOf<MemoryId>().not.toExtend<JobId>();
    expectTypeOf<string>().not.toExtend<JobId>();
    // Still strings wherever a string is wanted (logs, JSON, comparisons).
    expectTypeOf<JobId>().toExtend<string>();
  });

  it('store methods take the identifier of their own kind', () => {
    expectTypeOf<Parameters<ForemanStore['jobContext']>[0]>().toEqualTypeOf<JobId>();
    expectTypeOf<Parameters<ForemanStore['createTask']>[0]>().toEqualTypeOf<JobId>();
    expectTypeOf<Parameters<ForemanStore['taskContext']>[0]>().toEqualTypeOf<TaskId>();
    expectTypeOf<Parameters<ForemanStore['createRun']>[0]>().toEqualTypeOf<TaskId>();
    expectTypeOf<Parameters<ForemanStore['runContext']>[0]>().toEqualTypeOf<RunId>();
    expectTypeOf<Parameters<ForemanStore['applyExecutionChange']>[0]>().toEqualTypeOf<RunId>();
    expectTypeOf<Parameters<ForemanStore['runsForExecution']>[1]>().toEqualTypeOf<SessionId>();
    expectTypeOf<Parameters<ForemanStore['updateMemory']>[0]>().toEqualTypeOf<MemoryId>();
    // The mix-ups the brands exist to stop.
    expectTypeOf<TaskId>().not.toExtend<Parameters<ForemanStore['jobContext']>[0]>();
    expectTypeOf<JobId>().not.toExtend<Parameters<ForemanStore['runContext']>[0]>();
    expectTypeOf<RunId>().not.toExtend<Parameters<ForemanStore['taskContext']>[0]>();
  });

  it('starting, stopping and reserving a run take a run id', () => {
    expectTypeOf<Parameters<ForemanExecution['startRun']>[0]>().toEqualTypeOf<RunId>();
    expectTypeOf<Parameters<ForemanExecution['stopRun']>[0]>().toEqualTypeOf<RunId>();
    expectTypeOf<Parameters<ForemanScheduler['reserve']>[0]>().toEqualTypeOf<RunId>();
    expectTypeOf<TaskId>().not.toExtend<Parameters<ForemanExecution['startRun']>[0]>();
  });

  it('stored entities carry branded identifiers', () => {
    type Snapshot = Awaited<ReturnType<ForemanStore['snapshot']>>;
    expectTypeOf<Snapshot['jobs'][number]['id']>().toEqualTypeOf<JobId>();
    expectTypeOf<Snapshot['tasks'][number]['jobId']>().toEqualTypeOf<JobId>();
    expectTypeOf<Snapshot['tasks'][number]['dependsOn']>().toEqualTypeOf<TaskId[]>();
    expectTypeOf<Snapshot['runs'][number]['taskId']>().toEqualTypeOf<TaskId>();
  });
});

describe('Foreman unions', () => {
  it('an execution-truth verdict is exactly blocked, idle or unknown', () => {
    expectTypeOf<ExecutionTruth['verdict']>().toEqualTypeOf<'blocked' | 'idle' | 'unknown'>();
  });

  it('an event change either names a run status or says the session was deleted', () => {
    type WithStatus = Extract<EventRunChange, { status: RunStatus }>;
    expectTypeOf<WithStatus['status']>().toEqualTypeOf<'running' | 'completed' | 'cancelled' | 'failed' | 'waiting_for_user'>();
    expectTypeOf<Exclude<EventRunChange, WithStatus>['sessionDeleted']>().toEqualTypeOf<true>();
  });

  it('a switch over every run status is exhaustive', () => {
    const describeStatus = (status: RunStatus): string => {
      switch (status) {
        case 'queued': return 'queued';
        case 'running': return 'running';
        case 'waiting_for_user': return 'waiting';
        case 'failed': return 'failed';
        case 'completed': return 'completed';
        case 'cancelled': return 'cancelled';
        default: {
          const unhandled: never = status;
          return unhandled;
        }
      }
    };
    expect((['queued', 'running', 'waiting_for_user', 'failed', 'completed', 'cancelled'] as const).map(describeStatus))
      .toEqual(['queued', 'running', 'waiting', 'failed', 'completed', 'cancelled']);
  });
});
