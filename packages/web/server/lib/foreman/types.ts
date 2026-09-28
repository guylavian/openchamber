/**
 * Foreman's status vocabulary, owned by the server.
 *
 * These are the lists `store.js` validates persisted state against. The UI keeps
 * its own copy for its client-side schemas (`packages/ui/src/lib/foreman/model.ts`);
 * server code never imports UI source.
 */

import type { z } from 'zod';

export const JOB_STATUSES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
export const TASK_STATUSES = ['pending', 'ready', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export const RUN_STATUSES = ['queued', 'running', 'waiting_for_user', 'failed', 'completed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export type AttentionType = 'permission' | 'question' | 'conflict';

/** Why a run needs a person. */
export interface Attention {
  type: AttentionType;
  message?: string;
}

/**
 * Identifiers. Each kind is a distinct type, so a job id cannot be passed where
 * a task id is expected. The brand exists only for the type checker: stored and
 * wire values are plain strings, and branding never adds a run-time check (the
 * stored schemas use Zod's `.brand()`, which returns the same schema).
 */
export type JobId = string & z.$brand<'JobId'>;
export type TaskId = string & z.$brand<'TaskId'>;
export type RunId = string & z.$brand<'RunId'>;
export type SessionId = string & z.$brand<'SessionId'>;
export type MemoryId = string & z.$brand<'MemoryId'>;

export type ForemanErrorCode = 'invalid_input' | 'not_found' | 'unsupported_version' | 'conflict' | 'abort_failed';
