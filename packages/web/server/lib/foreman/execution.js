/**
 * Foreman execution: a Run carried out by one OpenCode session.
 *
 * A Run is a Foreman attempt at a Task; an OpenCode session is how this
 * module carries it out. The Run keeps a typed reference to the session
 * (`execution: { type: 'opencode-session', id, directory }`), never the other
 * way round, and ordinary sessions are never touched.
 *
 * Nothing here is a new execution path. The session is created and the task
 * handed to it through OpenChamber's own session service — the one the
 * agent tool and scheduled tasks use — and status follows the server's
 * existing OpenCode event stream, translated once for every server consumer.
 *
 * Status is the present state of the execution and only what OpenCode says
 * for certain:
 *
 *   execution started              → running
 *   permission asked / form asked  → waiting_for_user (+ attention)
 *   permission replied / form done → running
 *   turn succeeded, no subagents   → completed
 *   turn failed                    → failed (+ error)
 *   turn interrupted by the user   → cancelled
 *
 * A turn that ends while a subagent still works is a pause, not the end: the
 * run stays running until the session goes idle with no working children. If
 * OpenCode cannot be asked, the run stays as it is; "could not look" is never
 * reported as "finished".
 */

import { z } from 'zod';

import { ForemanStoreError } from './store.js';

const EXECUTION_TYPE = 'opencode-session';

/** Event and service fields arrive untyped; anything but text reads as empty. */
const textField = z.string().trim().catch('');
const trimmed = (value) => textField.parse(value);

const conflict = (message) => new ForemanStoreError('conflict', message);

/** What the task asks for, as the first message of the session. */
export const taskPrompt = (task) => trimmed(task.instructions) || trimmed(task.title);

const errorMessage = (error, fallback) => {
  const message = error instanceof Error ? error.message : trimmed(String(error ?? ''));
  return message || fallback;
};

/**
 * Maps one translated server event (see `event-stream/translate-v2.js`) onto
 * the change it makes to a run, or null when it says nothing about one.
 * Exported for tests; pure.
 */
export const runChangeForEvent = (payload) => {
  const type = payload?.type;
  const properties = payload?.properties ?? {};
  const sessionID = trimmed(properties.sessionID);
  if (!sessionID) return null;

  switch (type) {
    case 'session.status': {
      const statusType = properties.status?.type;
      // `idle` is reported again, with its reason, as session.idle/error.
      // Busy does not answer a question: a run waiting for the user stays
      // waiting until the permission or form is settled.
      if (statusType === 'busy' || statusType === 'retry') return { sessionID, status: 'running', unlessWaiting: true };
      return null;
    }
    case 'session.idle':
      if (properties.aborted === true) return { sessionID, status: 'cancelled' };
      return { sessionID, status: 'completed', unlessChildrenWork: true };
    case 'session.error':
      return {
        sessionID,
        status: 'failed',
        error: {
          stage: 'execution',
          message: trimmed(properties.error?.message) || trimmed(properties.error?.name) || 'The agent run failed',
        },
      };
    case 'permission.asked': {
      const attention = { type: 'permission' };
      const message = trimmed(properties.message) || trimmed(properties.action);
      if (message) attention.message = message;
      return { sessionID, status: 'waiting_for_user', attention };
    }
    case 'permission.replied':
      return { sessionID, status: 'running', onlyWhileAttention: 'permission' };
    case 'form.created': {
      const attention = { type: 'question' };
      const title = trimmed(properties.form?.title);
      if (title) attention.message = title;
      return { sessionID, status: 'waiting_for_user', attention };
    }
    case 'form.settled':
      return { sessionID, status: 'running', onlyWhileAttention: 'question' };
    case 'session.deleted':
      return { sessionID, status: 'failed', error: { stage: 'execution', message: 'The OpenCode session was deleted' }, onlyWhileActive: true };
    default:
      return null;
  }
};

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./store.js').createForemanStore>} deps.store
 * @param {{ create: Function, send: Function }} deps.sessionService OpenChamber's session service.
 * @param {(directory: string) => Promise<{ ok: boolean, directory?: string, error?: string }>} deps.validateDirectoryPath
 * @param {{ fetchActiveSessionStatuses: Function, hasWorkingChildren: Function }} deps.activityProbe
 * @param {(sessionId: string, directory: string) => Promise<'missing' | 'succeeded' | 'failed' | 'unknown'>} deps.readSessionOutcome
 * @param {(event: object) => void} [deps.broadcast]
 * @param {(message: string) => void} [deps.warn]
 */
export const createForemanExecution = ({
  store,
  sessionService,
  validateDirectoryPath,
  activityProbe,
  readSessionOutcome,
  broadcast = () => {},
  warn = (message) => console.warn(message),
  now = Date.now,
}) => {
  /** runId → the start in progress, so a second request joins it. */
  const starting = new Map();
  /** sessionId → the tail of its event chain; events for one session apply in order. */
  const sessionQueues = new Map();

  const announce = (runId) => {
    try {
      broadcast({ type: 'openchamber:foreman-changed', properties: { runId } });
    } catch {
      // A client that missed it re-reads on its next load.
    }
  };

  const change = async (runId, fn) => {
    const result = await store.applyExecutionChange(runId, fn);
    if (result.changed) announce(runId);
    return result.run;
  };

  const performStart = async (runId) => {
    const { run, task, job } = await store.runContext(runId);
    if (run.execution?.id) return { run, alreadyStarted: true };
    if (run.execution) {
      // A start recorded its intent and never its session: the server stopped
      // in between. A session may exist without a link, so this attempt is
      // closed honestly instead of quietly making a second one.
      const failed = await change(runId, () => ({
        status: 'failed',
        error: {
          stage: 'session',
          message: 'An earlier start stopped before its session was recorded. Start a new run.',
        },
      }));
      return { run: failed, alreadyStarted: true };
    }
    if (run.status !== 'queued') throw conflict(`A ${run.status} run cannot be started; start a new run`);
    if (!task || !job) throw new ForemanStoreError('not_found', 'The run has no task or job');

    const prompt = taskPrompt(task);
    const requested = trimmed(job.directory);
    if (!requested) {
      throw new ForemanStoreError('invalid_input', 'This job has no workspace directory to run in');
    }
    // Checked before anything is recorded: an unusable workspace leaves the
    // run queued, to start again once the workspace is fixed.
    const validated = await validateDirectoryPath(requested);
    if (!validated?.ok) {
      throw new ForemanStoreError('invalid_input', `The job's workspace is not usable: ${validated?.error || requested}`);
    }

    // Intent first, so a restart can tell "was starting" from "never started".
    await change(runId, (current) => (current.execution ? null : { execution: { type: EXECUTION_TYPE, createdAt: now() } }));

    let created;
    try {
      created = await sessionService.create({ directory: validated.directory, title: `${job.title}: ${task.title}` });
    } catch (error) {
      const failed = await change(runId, () => ({
        execution: null,
        status: 'failed',
        error: { stage: 'session', message: errorMessage(error, 'OpenCode could not create a session') },
      }));
      return { run: failed, alreadyStarted: false };
    }
    const sessionId = trimmed(created?.sessionId);
    const directory = trimmed(created?.directory) || validated.directory;
    if (!sessionId) {
      const failed = await change(runId, () => ({
        execution: null,
        status: 'failed',
        error: { stage: 'session', message: 'OpenCode created no session' },
      }));
      return { run: failed, alreadyStarted: false };
    }

    // The link is saved before the task is sent: whatever happens next, the
    // run knows its session and never makes another one.
    await change(runId, (current) => ({
      execution: { type: EXECUTION_TYPE, id: sessionId, directory, createdAt: current.execution?.createdAt ?? now() },
    }));

    let dispatchError = null;
    try {
      const sent = await sessionService.send(sessionId, { prompt, directory });
      if (!sent?.promptDispatched) dispatchError = trimmed(sent?.promptError) || 'OpenCode did not queue the task';
    } catch (error) {
      dispatchError = errorMessage(error, 'The task could not be sent to the session');
    }

    const finalRun = await change(runId, (current) => {
      if (dispatchError) {
        // The session exists and stays linked; the attempt to hand it the task failed.
        return { status: 'failed', error: { stage: 'dispatch', message: dispatchError } };
      }
      // An event may already have moved it further (a fast answer, a permission).
      return current.status === 'queued' ? { status: 'running' } : null;
    });
    return { run: finalRun, alreadyStarted: false };
  };

  /** Starts a queued run. Idempotent: a run that has a session never gets another. */
  const startRun = (runId) => {
    const inFlight = starting.get(runId);
    if (inFlight) return inFlight.then((result) => ({ ...result, alreadyStarted: true }));
    const promise = performStart(runId).finally(() => starting.delete(runId));
    starting.set(runId, promise);
    return promise;
  };

  const applyEventChange = async (eventChange) => {
    const runs = await store.runsForExecution(EXECUTION_TYPE, eventChange.sessionID);
    if (runs.length === 0) return;

    let status = eventChange.status;
    if (eventChange.unlessChildrenWork) {
      // Completed only when OpenCode says nothing of this session still runs.
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      const children = statuses ? await activityProbe.hasWorkingChildren(eventChange.sessionID, statuses) : null;
      if (children !== false) status = 'running';
    }

    for (const run of runs) {
      await change(run.id, (current) => {
        if (eventChange.onlyWhileAttention && current.attention?.type !== eventChange.onlyWhileAttention) return null;
        if (eventChange.onlyWhileActive && ['completed', 'failed', 'cancelled'].includes(current.status)) return null;
        if (eventChange.unlessWaiting && current.status === 'waiting_for_user') return null;
        if (current.status === status && !eventChange.attention && !eventChange.error) return null;
        const next = { status };
        if (eventChange.attention) next.attention = eventChange.attention;
        if (eventChange.error) next.error = eventChange.error;
        return next;
      });
    }
  };

  /** Feeds one translated server event. Events of one session apply in order. */
  const processPayload = (payload) => {
    const eventChange = runChangeForEvent(payload);
    if (!eventChange) return;
    const key = eventChange.sessionID;
    const previous = sessionQueues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => applyEventChange(eventChange))
      .catch((error) => warn(`[foreman] could not apply ${payload.type} to its run: ${errorMessage(error, 'unknown error')}`));
    sessionQueues.set(key, next);
    void next.finally(() => {
      if (sessionQueues.get(key) === next) sessionQueues.delete(key);
    });
  };

  /**
   * After a restart: settle runs whose session moved on while nobody
   * listened. Never starts anything, never creates a session.
   */
  const reconcile = async () => {
    const runs = await store.activeExecutions();
    if (runs.length === 0) return;
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return; // OpenCode could not be asked: change nothing.
    for (const run of runs) {
      const sessionId = run.execution.id;
      if (statuses[sessionId]) {
        if (run.status === 'queued') await change(run.id, () => ({ status: 'running' }));
        continue;
      }
      const children = await activityProbe.hasWorkingChildren(sessionId, statuses);
      if (children !== false) continue;
      const outcome = await readSessionOutcome(sessionId, run.execution.directory ?? '').catch(() => 'unknown');
      if (outcome === 'missing') {
        await change(run.id, () => ({ status: 'failed', error: { stage: 'execution', message: 'The OpenCode session no longer exists' } }));
      } else if (run.status === 'queued') {
        // The session was made but the server stopped before the task was
        // confirmed sent. Whether it arrived is visible in the session.
        await change(run.id, () => ({
          status: 'failed',
          error: { stage: 'dispatch', message: 'Foreman stopped while handing the task to the session; open the session to see whether it arrived' },
        }));
      } else if (outcome === 'succeeded' && run.status === 'running') {
        await change(run.id, () => ({ status: 'completed' }));
      } else if (outcome === 'failed') {
        await change(run.id, () => ({ status: 'failed', error: { stage: 'execution', message: 'The agent run failed while Foreman was not running' } }));
      }
      // 'unknown': the run keeps its last known state.
    }
  };

  return { startRun, processPayload, reconcile };
};
