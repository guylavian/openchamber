/**
 * Foreman's status vocabulary, owned by the server.
 *
 * These are the lists `store.js` validates persisted state against. The UI keeps
 * its own copy for its client-side schemas (`packages/ui/src/lib/foreman/model.ts`);
 * server code never imports UI source.
 */

export const JOB_STATUSES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
export const TASK_STATUSES = ['pending', 'ready', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export const RUN_STATUSES = ['queued', 'running', 'waiting_for_user', 'failed', 'completed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
