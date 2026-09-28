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
 * Status is the present state of the execution, not of the outer turn, and only
 * what its owner says for certain:
 *
 *   execution started              → running
 *   permission asked / form asked  → waiting_for_user (+ attention)
 *   permission replied / form done → running
 *   turn succeeded, no subagents   → completed, once execution truth agrees
 *   turn failed                    → failed (+ error)
 *   turn interrupted by the user   → cancelled
 *
 * A turn that ends while a subagent still works is a pause, not the end: the
 * run stays running until the session goes idle with no working children.
 *
 * "The turn ended" is not "the work ended". A gateway-carried session (see
 * `execution-truth.js`) can finish its outer turn while Claude Code is still
 * holding a permission, so a completed claim is confirmed against execution
 * truth before it is made, and a truth nobody can read is never reported as a
 * finished run. If OpenCode cannot be asked at all, the run stays as it is:
 * "could not look" is never reported as "finished".
 */

/* ──► Imports. */

import { z } from 'zod';

import { ForemanStoreError } from './store.js';
import type { ExecutionChange, ForemanStore, Memory, Run } from './store.js';
import { createExecutionTruthProbe } from './execution-truth.js';
import type { ExecutionTruth } from './execution-truth.js';
import { createForemanScheduler } from './scheduler.js';
import type { TaskWorkspaceManager } from './task-workspaces.js';
import type { Attention, RunId, SessionId } from './types.js';

/* ──► Contracts: the shapes this module has always read, described, not checked. */

type Maybe<Value> = Value | null | undefined;
type RunError = NonNullable<Run['error']>;

/** One translated server event (see `event-stream/translate-v2.js`). */
export interface EventPayload {
  type?: unknown;
  properties?: Maybe<EventProperties>;
}
interface EventProperties {
  sessionID?: unknown;
  status?: Maybe<{ type?: unknown }>;
  aborted?: unknown;
  error?: Maybe<{ message?: unknown; name?: unknown }>;
  message?: unknown;
  action?: unknown;
  form?: Maybe<{ title?: unknown }>;
}

/** Every field an event change can carry; each member of the union below
 * names its own and leaves the rest absent, so they read as undefined. */
interface ChangeFields {
  status?: never;
  unlessWaiting?: never;
  unlessChildrenWork?: never;
  error?: never;
  attention?: never;
  onlyWhileAttention?: never;
  sessionDeleted?: never;
}
type Only<Fields> = Omit<ChangeFields, keyof Fields> & Fields;
/** What one event does to the runs of its session. */
export type EventRunChange = { sessionID: string } & (
  | Only<{ status: 'running'; unlessWaiting: true }>
  | Only<{ status: 'cancelled' }>
  | Only<{ status: 'completed'; unlessChildrenWork: true }>
  | Only<{ status: 'failed'; error: RunError }>
  | Only<{ status: 'waiting_for_user'; attention: Attention }>
  | Only<{ status: 'running'; onlyWhileAttention: 'permission' | 'question' }>
  | Only<{ sessionDeleted: true }>
);

/** What `validateDirectoryPath` answers. */
export type DirectoryValidation = { ok: true; directory: string; error?: undefined } | { ok: false; directory?: undefined; error?: string };

export interface ForemanSessionService {
  create: (request: { directory: string; title: string }) => Promise<Maybe<{ sessionId?: unknown; directory?: unknown }>>;
  send: (sessionId: string, request: { prompt: string; directory: string }) => Promise<Maybe<{ promptDispatched?: unknown; promptError?: unknown }>>;
  interrupt: (sessionId: string, request: { directory: string }) => Promise<Maybe<{ missing?: unknown }>>;
}
export interface ForemanActivityProbe {
  fetchActiveSessionStatuses: () => Promise<Maybe<Record<string, unknown>>>;
  hasWorkingChildren: (sessionId: string, statuses: Record<string, unknown>) => Promise<Maybe<boolean>>;
}
export interface ForemanExecutionOptions {
  store: ForemanStore;
  sessionService: ForemanSessionService;
  validateDirectoryPath: (directory: string) => Promise<Maybe<DirectoryValidation>>;
  activityProbe: ForemanActivityProbe;
  taskWorkspaceManager?: Pick<TaskWorkspaceManager, 'prepare'>;
  scheduler?: ReturnType<typeof createForemanScheduler> | undefined;
  globalConcurrency?: number | undefined;
  readSessionOutcome: (sessionId: string, directory: string) => Promise<string>;
  executionTruthProbe?: ReturnType<typeof createExecutionTruthProbe> | undefined;
  broadcast?: (event: { type: string; properties: { runId: string } }) => void;
  warn?: (message: string) => void;
  now?: () => number;
}

const EXECUTION_TYPE = 'opencode-session';

/* ──► Event → run change mapping (see `event-stream/translate-v2.js`). */

const textField = z.string().trim().catch('');
const trimmed = (value: unknown): string => textField.parse(value);
const errorMessage = (error: unknown, fallback: string): string => error instanceof Error ? error.message : trimmed(error) || fallback;

const conflict = (message: string): ForemanStoreError => new ForemanStoreError('conflict', message);
const CODE_INTELLIGENCE_INSTRUCTION = 'For code work, use available LSP/language-server or other structured code-intelligence tools first. If none are available, search for and read only files relevant to this task. Use shell for execution, tests, builds, Git, and runtime commands. Do not start with repository-wide discovery.';
/** A Run-only prompt context. Ordinary OpenChamber session prompts never pass here. */
export const taskPrompt = (task: { title: string; instructions?: string | undefined }, memories: readonly Memory[] = []): string => {
  const request = trimmed(task.instructions) || trimmed(task.title);
  const workspace = memories.filter((entry) => entry.scope === 'workspace').slice(0, 6);
  const job = memories.filter((entry) => entry.scope === 'job').slice(0, 6);
  const section: string[] = [];
  if (workspace.length) section.push('Workspace memory:', ...workspace.map((entry) => `- [${entry.type}] ${entry.content.slice(0, 700)}`));
  if (job.length) section.push('Job memory:', ...job.map((entry) => `- [${entry.type}] ${entry.content.slice(0, 700)}`));
  if (section.length) section.push('Treat memory as a hint. Verify it against the current repository; current code wins.');
  return [CODE_INTELLIGENCE_INSTRUCTION, ...(section.length ? ['', ...section] : []), '', request].join('\n');
};

/**
 * Maps one translated server event (see `event-stream/translate-v2.js`) onto
 * the change it makes to a run, or null when it says nothing about one.
 * Exported for tests; pure.
 */
export const runChangeForEvent = (payload: Maybe<EventPayload>): EventRunChange | null => {
  const type = payload?.type;
  const properties: EventProperties = payload?.properties ?? {};
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
      const attention: Attention = { type: 'permission' };
      const message = trimmed(properties.message) || trimmed(properties.action);
      if (message) attention.message = message;
      return { sessionID, status: 'waiting_for_user', attention };
    }
    case 'permission.replied':
      return { sessionID, status: 'running', onlyWhileAttention: 'permission' };
    case 'form.created': {
      const attention: Attention = { type: 'question' };
      const title = trimmed(properties.form?.title);
      if (title) attention.message = title;
      return { sessionID, status: 'waiting_for_user', attention };
    }
    case 'form.settled':
      return { sessionID, status: 'running', onlyWhileAttention: 'question' };
    case 'session.deleted':
      return { sessionID, sessionDeleted: true };
    default:
      return null;
  }
};

/* ──► Runtime creation. */

export const createForemanExecution = ({
  store,
  sessionService,
  validateDirectoryPath,
  activityProbe,
  taskWorkspaceManager = { prepare: async ({ baseDirectory }) => ({ kind: 'shared-directory', directory: baseDirectory, createdAt: Date.now() }) },
  scheduler = undefined,
  globalConcurrency = undefined,
  readSessionOutcome,
  executionTruthProbe,
  broadcast = () => {},
  warn = (message) => console.warn(message),
  now = Date.now,
}: ForemanExecutionOptions) => {
  const taskScheduler = scheduler ?? createForemanScheduler({ store, ...(globalConcurrency ? { globalLimit: globalConcurrency } : {}) });
  const truthProbe = executionTruthProbe ?? { readExecutionTruth: async () => ({ verdict: 'idle' }) as ExecutionTruth };
  /** runId → the start in progress, so a second request joins it. */
  const starting = new Map<string, Promise<{ run: Run; alreadyStarted: boolean }>>();
  /** runId → the stop in progress, likewise. */
  const stopping = new Map<string, Promise<{ run: Run; stopped: boolean }>>();
  /** sessionId → the tail of its event chain; events for one session apply in order. */
  const sessionQueues = new Map<string, Promise<void>>();

  const announce = (runId: string): void => {
    try {
      broadcast({ type: 'openchamber:foreman-changed', properties: { runId } });
    } catch {
      // A client that missed it re-reads on its next load.
    }
  };

  const change = async (runId: RunId, fn: (run: Run) => ExecutionChange | null): Promise<Run> => {
    const result = await store.applyExecutionChange(runId, fn);
    if (result.changed) announce(runId);
    return result.run;
  };

  const recordActivity = async (runId: RunId, type: 'run_started' | 'session_created', message: string, metadata?: Record<string, string | number | boolean>) => {
    const event = await store.addRunActivity(runId, { type, message, ...(metadata ? { metadata } : {}) });
    if (event) announce(runId);
    return event;
  };

  const performStart = async (runId: RunId): Promise<{ run: Run; alreadyStarted: boolean }> => {
    const { run, task, job } = await store.runContext(runId);
    if (run.execution?.id) return { run, alreadyStarted: true };
    if (run.status !== 'queued') throw conflict(`A ${run.status} run cannot be started; start a new run`);
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

    const reservation = await taskScheduler.reserve(runId);
    try {

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
    const taskWorkspace = await taskWorkspaceManager.prepare({
      jobId: job.id,
      taskId: task.id,
      baseDirectory: validated.directory,
      existing: task.workspace,
    });
    await store.setTaskWorkspace(task.id, taskWorkspace);
    const executionWorkspace = await validateDirectoryPath(taskWorkspace.directory);
    if (!executionWorkspace?.ok || !executionWorkspace.directory) {
      throw new ForemanStoreError('invalid_input', `The Task workspace is not usable: ${executionWorkspace?.error || taskWorkspace.directory}`);
    }
    const memories = await store.relevantMemories({
      jobId: job.id,
      workspaceId: validated.directory,
      query: [job.title, job.goal, task.title, task.instructions].filter(Boolean).join('\n'),
    });
    const prompt = taskPrompt(task, memories);

    // Intent first, so a restart can tell "was starting" from "never started".
    await change(runId, (current) => (current.execution ? null : { execution: { type: EXECUTION_TYPE, createdAt: now() } }));
    await recordActivity(runId, 'run_started', 'Run started');

    let created;
    try {
      created = await sessionService.create({ directory: executionWorkspace.directory, title: `${job.title}: ${task.title}` });
    } catch (error) {
      const failed = await change(runId, () => ({
        execution: null,
        status: 'failed',
        error: { stage: 'session', message: errorMessage(error, 'OpenCode could not create a session') },
      }));
      return { run: failed, alreadyStarted: false };
    }
    const sessionId = trimmed(created?.sessionId);
    const directory = trimmed(created?.directory) || executionWorkspace.directory;
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
      execution: { type: EXECUTION_TYPE, id: sessionId as SessionId, directory, createdAt: current.execution?.createdAt ?? now() },
    }));
    await recordActivity(runId, 'session_created', 'OpenCode session created');

    let dispatchError: string | null = null;
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
    } finally {
      reservation.release();
    }
  };

  /**
   * The session is gone. The reference is kept, marked deleted, so the run
   * still says what carried it out; an unfinished run cannot go on without
   * it, and one that already finished keeps its outcome.
   */
  const sessionGone = (current: Run, message: string): ExecutionChange | null => {
    if (!current.execution || current.execution.deletedAt) return null;
    const next: ExecutionChange = { execution: { ...current.execution, deletedAt: now() } };
    if (!['completed', 'failed', 'cancelled'].includes(current.status)) {
      next.status = 'failed';
      next.error = { stage: 'execution', message };
    }
    next.activityEvent = { type: 'progress', message: 'OpenCode session deleted' };
    return next;
  };

  /** Starts a queued run. Idempotent: a run that has a session never gets another. */
  const startRun = (runId: RunId): Promise<{ run: Run; alreadyStarted: boolean }> => {
    const inFlight = starting.get(runId);
    if (inFlight) return inFlight.then((result) => ({ ...result, alreadyStarted: true }));
    const promise = performStart(runId).finally(() => starting.delete(runId));
    starting.set(runId, promise);
    return promise;
  };

  const TERMINAL = ['completed', 'failed', 'cancelled'];
  const ACTIVE = ['running', 'waiting_for_user'];

  const performStop = async (runId: RunId): Promise<{ run: Run; stopped: boolean }> => {
    const { run } = await store.runContext(runId);
    // Finished runs are left exactly as they are: nothing to interrupt.
    if (TERMINAL.includes(run.status)) return { run, stopped: false };
    if (!ACTIVE.includes(run.status) || !run.execution?.id) {
      throw conflict('This run has not started; there is nothing to stop');
    }
    const cancel = (extra: ExecutionChange = {}): Promise<Run> => change(runId, (current) => (TERMINAL.includes(current.status)
      ? null
      : { status: 'cancelled', stoppedAt: now(), ...extra }));

    if (run.execution.deletedAt) return { run: await cancel({ execution: { ...run.execution, deletedAt: now() } }), stopped: true };

    let result;
    try {
      result = await sessionService.interrupt(run.execution.id, { directory: run.execution.directory ?? '' });
    } catch (error) {
      // The session may still be working: the run keeps its status, and the
      // person is told the stop did not happen.
      throw new ForemanStoreError('abort_failed', `The session could not be stopped: ${errorMessage(error, 'unknown error')}`);
    }
    if (result?.missing) {
      return { run: await cancel({ execution: { ...run.execution, deletedAt: now() } }), stopped: true };
    }
    // Interrupted, or already idle: either way nothing runs for this attempt
    // now, and the person asked for it to end.
    return { run: await cancel(), stopped: true };
  };

  /**
   * Stops an active run by interrupting its OpenCode session. Idempotent:
   * concurrent stops share one interrupt, and a run that is no longer active
   * answers with itself.
   */
  const stopRun = (runId: RunId): Promise<{ run: Run; stopped: boolean }> => {
    const inFlight = stopping.get(runId);
    if (inFlight) return inFlight;
    const promise = performStop(runId).finally(() => stopping.delete(runId));
    stopping.set(runId, promise);
    return promise;
  };

  const applyEventChange = async (eventChange: EventRunChange): Promise<void> => {
    const runs = await store.runsForExecution(EXECUTION_TYPE, eventChange.sessionID as SessionId);
    if (runs.length === 0) return;

      if (eventChange.sessionDeleted) {
      for (const run of runs) await change(run.id, (current) => sessionGone(current, 'The OpenCode session was deleted'));
      return;
    }

    let status = eventChange.status;
    if (eventChange.unlessChildrenWork) {
      // Completed only when OpenCode says nothing of this session still runs.
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      const children = statuses ? await activityProbe.hasWorkingChildren(eventChange.sessionID, statuses) : null;
      if (children !== false) status = 'running';
    }

    for (const run of runs) {
      if (eventChange.status === 'waiting_for_user' && run.status === 'waiting_for_user'
        && run.attention?.type === eventChange.attention?.type
        && run.attention?.message === eventChange.attention?.message) continue;
      if (eventChange.status === 'running' && run.status === 'running'
        && !eventChange.attention && !eventChange.error) continue;
      await change(run.id, (current) => {
        // A run a person stopped stays stopped, whatever its session does next.
        if (current.stoppedAt) return null;
        if (eventChange.onlyWhileAttention && current.attention?.type !== eventChange.onlyWhileAttention) return null;
        if (eventChange.unlessWaiting && current.status === 'waiting_for_user') return null;
        if (current.status === status && !eventChange.attention && !eventChange.error) return null;
        const next: ExecutionChange = { status };
        if (eventChange.attention) next.attention = eventChange.attention;
        if (eventChange.error) next.error = eventChange.error;
        return next;
      });
    }
  };

  /** Feeds one translated server event. Events of one session apply in order. */
  const processPayload = (payload: EventPayload): void => {
    const eventChange = runChangeForEvent(payload);
    if (!eventChange) return;
    const key = eventChange.sessionID;
    const previous = sessionQueues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => applyEventChange(eventChange))
      .catch((error: unknown) => warn(`[foreman] could not apply ${payload.type} to its run: ${errorMessage(error, 'unknown error')}`));
    sessionQueues.set(key, next);
    void next.finally(() => {
      if (sessionQueues.get(key) === next) sessionQueues.delete(key);
    });
  };

  /**
   * After a restart: settle runs whose session moved on while nobody
   * listened. Never starts anything, never creates a session.
   *
   * For each active run, after the existing `readSessionOutcome` check,
   * also consult the execution truth probe. For gateway-carried sessions
   * (model provider `claude-code`), the probe checks whether an underlying
   * permission is still waiting. If so, the run stays `waiting_for_user`;
   * if not, it may become `completed`.
   */
  const reconcile = async (): Promise<void> => {
    const runs = await store.activeExecutions();
    if (runs.length === 0) return;

    // Step 1: existing OpenCode activity-state checks (children, etc.)
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (statuses) {
      for (const run of runs) {
        const sessionId = run.execution!.id!;
        if (statuses[sessionId]) {
          if (run.status === 'queued') await change(run.id, () => ({ status: 'running' }));
          continue;
        }
        const children = await activityProbe.hasWorkingChildren(sessionId, statuses);
        if (children !== false) continue;
        const outcome = await readSessionOutcome(sessionId, run.execution!.directory ?? '').catch(() => 'unknown');
        if (outcome === 'succeeded') {
          await change(run.id, () => ({ status: 'completed' }));
        } else if (outcome === 'missing') {
          await change(run.id, () => ({ status: 'failed', error: { stage: 'execution', message: 'The OpenCode session no longer exists' }, execution: { ...run.execution!, deletedAt: now() } }));
        } else if (outcome === 'failed') {
          await change(run.id, () => ({ status: 'failed', error: { stage: 'execution', message: 'The agent run failed' } }));
        }
      }
    }

    // Step 2: per-run truth-probe verification.
    for (const run of runs) {
      const sessionId = run.execution!.id!;
      const directory = run.execution!.directory ?? '';
      // Only probe sessions whose model provider is a gateway we understand.
      const { execution: exec } = run;
      if (!exec?.id) continue;

      // Ask the execution truth probe for this session.
      const truthResult = await truthProbe.readExecutionTruth({
        sessionId,
        directory,
      }).catch((): ExecutionTruth => ({ verdict: 'unknown', source: 'reconcile', resolvable: false, reason: 'could not read execution truth' }));
      if (!executionTruthProbe) continue;
      if (truthResult.verdict === 'idle' && statuses?.[sessionId]) continue;
      if (truthResult.verdict === 'idle' && !statuses) continue;

      // Map the probe verdict to a run status change.
      if (truthResult.verdict === 'blocked') {
        // Someone is being waited on — the run must not become completed.
        const attention = truthResult.attention ?? { type: 'conflict', message: truthResult.reason || 'This session is waiting for a decision' };
        await change(run.id, (current) => {
          if (current.status !== 'waiting_for_user' || current.attention?.type !== attention.type) {
            return { status: 'waiting_for_user', attention };
          }
          return null;
        });
      } else if (truthResult.verdict === 'idle') {
        // No hidden blockers remain. Now also check the old outcome for
        // completion: the session outcome must say succeeded and there must
        // be no subagent work. Do NOT mark completed just because truth says
        // idle — that only means "nothing blocking". A completed claim still
        // needs the outcome to say so.
        //
        // 'unknown' verdict: a layer could not be read — treat as conflict waiting,
        // never as completed.
        const outcome = await readSessionOutcome(sessionId, directory).catch(() => 'unknown');
        if (outcome === 'succeeded') {
          await change(run.id, (current) => current.status === 'waiting_for_user' ? { status: 'running' } : null);
          const children = await activityProbe.fetchActiveSessionStatuses();
          if (!children || await activityProbe.hasWorkingChildren(sessionId, children) !== false) continue;
          await change(run.id, (currentRun) => currentRun.status === 'running' ? { status: 'completed' } : null);
        } else if (outcome === 'missing') {
          await change(run.id, () => ({ status: 'failed', error: { stage: 'execution', message: 'The OpenCode session no longer exists' }, execution: { ...run.execution!, deletedAt: now() } }));
        } else if (outcome === 'failed') {
          await change(run.id, () => ({ status: 'failed', error: { stage: 'execution', message: 'The agent run failed' } }));
        }
      } else if (truthResult.verdict === 'unknown') {
        await change(run.id, (current) => {
          if (current.status !== 'waiting_for_user') {
            return { status: 'waiting_for_user', attention: { type: 'conflict', message: truthResult.reason || 'Could not verify execution state' } };
          }
          if (current.attention?.type !== 'conflict') {
            return { attention: { type: 'conflict', message: truthResult.reason || 'Could not verify execution state' } };
          }
          return null;
        });
      }
      // verdict 'idle' does not automatically mark completed; the normal outcome
      // check below (and per-event guards) handle that.
    }
  };

  return { startRun, stopRun, processPayload, reconcile };
};
