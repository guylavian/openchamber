/**
 * Runs a team: its stages in order, the members of a stage together or one
 * after another, each member in a session of its own.
 *
 * This module owns the order of work and the run record. It does not touch
 * sessions, worktrees or files; `runMember` (see runtime.js) does that and
 * reports back. Keeping the two apart is what lets the ordering, failure and
 * cancellation rules be tested without a live OpenCode.
 *
 * Members never talk to each other. A member receives, through its prompt,
 * the output of the members that finished before it in this run, and nothing
 * else: no other run, no other session.
 */

/** A member that never started keeps `pending`; one stopped by Cancel is `cancelled`. */
export const MEMBER_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'];
export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'];

export class TeamRunError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = 'TeamRunError';
    this.statusCode = statusCode;
  }
}

const RESTART_MESSAGE = 'OpenChamber restarted while this member was running. Its session may have finished on its own; open it to check, or retry.';

const clone = (value) => structuredClone(value);

const freshMember = (member) => ({
  ...member,
  status: 'pending',
  sessionId: null,
  directory: null,
  worktree: null,
  model: null,
  startedAt: null,
  finishedAt: null,
  output: null,
  changes: null,
  error: null,
});

/**
 * @param {{
 *   runMember: (input: {
 *     run: object, member: object, agent: object, handoffs: object[],
 *     signal: AbortSignal, onStarted: (info: object) => void,
 *   }) => Promise<{ output: string, changes: object | null }>,
 *   persistRun: (run: object) => void | Promise<void>,
 *   initialRuns?: object[],
 *   now?: () => number,
 *   newId?: () => string,
 * }} dependencies
 */
export const createTeamOrchestrator = ({
  runMember,
  persistRun,
  initialRuns = [],
  now = Date.now,
  newId = () => crypto.randomUUID(),
}) => {
  const runs = new Map();
  /** Per active run: the member controllers, and whether Cancel was pressed. */
  const active = new Map();
  /** The promise driving each active run, so callers and tests can await it. */
  const drives = new Map();

  // A run the previous server process was driving cannot be resumed: its
  // sessions were being watched by a process that is gone. Say so plainly
  // rather than show it running forever.
  for (const stored of initialRuns) {
    const run = clone(stored);
    if (run.status === 'running') {
      const at = now();
      for (const member of run.members) {
        if (member.status === 'running') Object.assign(member, { status: 'failed', error: RESTART_MESSAGE, finishedAt: at });
      }
      Object.assign(run, { status: 'failed', error: 'OpenChamber restarted during this run.', finishedAt: at, updatedAt: at });
      run.timeline.push({ at, kind: 'run-failed', memberId: null, message: 'OpenChamber restarted during this run.' });
    }
    runs.set(run.id, run);
  }

  const save = (run) => {
    run.updatedAt = now();
    return Promise.resolve(persistRun(clone(run))).catch(() => undefined);
  };

  const note = (run, kind, memberId = null, message = null) => {
    run.timeline.push({ at: now(), kind, memberId, message });
  };

  const agentOf = (run, member) => run.team.agents.find((agent) => agent.id === member.agentId);
  const membersOfStage = (run, stageIndex) => run.members.filter((member) => member.stageIndex === stageIndex);

  /**
   * What a member is told about the others: the output of every member that
   * completed in an earlier stage, plus, in a sequential stage, the members
   * before it in that stage. Members still running or failed contribute
   * nothing, so a member never builds on an unfinished result.
   */
  const handoffsFor = (run, member) => {
    const stage = run.team.stages[member.stageIndex];
    const position = stage.agentIds.indexOf(member.agentId);
    return run.members
      .filter((other) => other.status === 'completed' && (
        other.stageIndex < member.stageIndex
        || (stage.mode === 'sequential' && other.stageIndex === member.stageIndex
          && stage.agentIds.indexOf(other.agentId) < position)
      ))
      .map((other) => {
        const agent = agentOf(run, other);
        return { name: agent.name, role: agent.role, output: other.output ?? '', changes: other.changes };
      });
  };

  const runOne = async (run, member) => {
    const state = active.get(run.id);
    if (!state || state.cancelled) return;
    const agent = agentOf(run, member);
    const controller = new AbortController();
    state.controllers.set(member.agentId, controller);
    Object.assign(member, freshMember(member), { status: 'running', attempt: member.attempt + 1, startedAt: now() });
    note(run, 'member-started', member.agentId);
    await save(run);
    try {
      const result = await runMember({
        run: clone(run),
        member: clone(member),
        agent,
        handoffs: handoffsFor(run, member),
        signal: controller.signal,
        onStarted: (info) => {
          Object.assign(member, {
            sessionId: info.sessionId ?? member.sessionId,
            directory: info.directory ?? member.directory,
            worktree: info.worktree ?? member.worktree,
            model: info.model ?? member.model,
          });
          void save(run);
        },
      });
      if (state.cancelled) throw new TeamRunError('Cancelled');
      Object.assign(member, { status: 'completed', output: result.output ?? '', changes: result.changes ?? null, finishedAt: now() });
      note(run, 'member-completed', member.agentId);
    } catch (error) {
      const cancelled = state.cancelled || controller.signal.aborted;
      Object.assign(member, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : (error instanceof Error ? error.message : String(error)),
        finishedAt: now(),
      });
      note(run, cancelled ? 'member-cancelled' : 'member-failed', member.agentId, member.error);
    } finally {
      state.controllers.delete(member.agentId);
      await save(run);
    }
  };

  /** Runs the stage's members that have not completed. True when all of them have. */
  const runStage = async (run, stageIndex) => {
    const stage = run.team.stages[stageIndex];
    const todo = membersOfStage(run, stageIndex).filter((member) => member.status !== 'completed');
    if (stage.mode === 'parallel') {
      await Promise.all(todo.map((member) => runOne(run, member)));
    } else {
      for (const member of todo) {
        await runOne(run, member);
        if (member.status !== 'completed') break;
      }
    }
    return membersOfStage(run, stageIndex).every((member) => member.status === 'completed');
  };

  const finish = async (run, status, error = null) => {
    Object.assign(run, { status, error, finishedAt: now() });
    note(run, `run-${status}`, null, error);
    await save(run);
  };

  const drive = async (run, fromStage) => {
    const state = active.get(run.id);
    try {
      for (let stageIndex = fromStage; stageIndex < run.team.stages.length; stageIndex += 1) {
        if (state.cancelled) return finish(run, 'cancelled');
        const done = await runStage(run, stageIndex);
        if (state.cancelled) return finish(run, 'cancelled');
        if (!done) {
          const failed = membersOfStage(run, stageIndex).filter((member) => member.status === 'failed');
          const names = failed.map((member) => agentOf(run, member).name).join(', ');
          // Later stages depend on this one, so they do not start.
          return finish(run, 'failed', names ? `Stopped after ${names} failed.` : 'Stopped: the stage did not complete.');
        }
      }
      return finish(run, 'completed');
    } finally {
      active.delete(run.id);
      drives.delete(run.id);
    }
  };

  const begin = (run, fromStage) => {
    active.set(run.id, { cancelled: false, controllers: new Map() });
    const promise = drive(run, fromStage);
    drives.set(run.id, promise);
    return promise;
  };

  const requireRun = (runId) => {
    const run = runs.get(runId);
    if (!run) throw new TeamRunError('Team run not found', 404);
    return run;
  };

  const requireIdle = (run) => {
    if (active.has(run.id)) throw new TeamRunError('The run is still working. Cancel it first.');
  };

  /** Resets a stage and everything after it, since later work depended on it. */
  const resetFrom = (run, stageIndex, memberIds = null) => {
    for (const member of run.members) {
      if (member.stageIndex > stageIndex || (member.stageIndex === stageIndex && (!memberIds || memberIds.includes(member.agentId)))) {
        Object.assign(member, freshMember(member));
      }
    }
  };

  const requireEarlierStagesComplete = (run, stageIndex) => {
    const blocked = run.members.some((member) => member.stageIndex < stageIndex && member.status !== 'completed');
    if (blocked) throw new TeamRunError('An earlier stage has not completed. Retry that stage first.');
  };

  const restart = (run, stageIndex, memberIds, message) => {
    resetFrom(run, stageIndex, memberIds);
    Object.assign(run, { status: 'running', error: null, finishedAt: null });
    note(run, 'retry', memberIds?.[0] ?? null, message);
    void save(run);
    void begin(run, stageIndex);
    return clone(run);
  };

  return {
    listRuns: () => [...runs.values()].map(clone).sort((a, b) => b.createdAt - a.createdAt),

    getRun: (runId) => clone(requireRun(runId)),

    /** Starts a run of `team` and returns its record at once; the work continues in the background. */
    startRun: ({ team, goal, directory }) => {
      const trimmedGoal = typeof goal === 'string' ? goal.trim() : '';
      if (!trimmedGoal) throw new TeamRunError('A task is required', 400);
      if (!directory) throw new TeamRunError('A project directory is required', 400);
      if (team.stages.length === 0) throw new TeamRunError('The team has no members to run', 400);
      const at = now();
      const run = {
        id: newId(),
        teamId: team.id,
        teamName: team.name,
        goal: trimmedGoal,
        directory,
        workspace: team.workspace,
        // A copy of the team as it was, so editing the team later changes
        // neither what this run shows nor what a retry does.
        team: { agents: clone(team.agents), stages: clone(team.stages) },
        status: 'running',
        error: null,
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
        members: team.stages.flatMap((stage, stageIndex) => stage.agentIds.map((agentId) => freshMember({ agentId, stageIndex, attempt: 0 }))),
        timeline: [],
      };
      runs.set(run.id, run);
      note(run, 'run-started');
      void save(run);
      void begin(run, 0);
      return clone(run);
    },

    /** Stops the running members' sessions and keeps later stages from starting. */
    cancelRun: (runId) => {
      const run = requireRun(runId);
      const state = active.get(runId);
      if (!state) throw new TeamRunError('The run is not running.');
      state.cancelled = true;
      for (const controller of state.controllers.values()) controller.abort();
      return clone(run);
    },

    /** Runs one member again, then the stages after it. Its stage-mates keep their results. */
    retryMember: (runId, memberId) => {
      const run = requireRun(runId);
      requireIdle(run);
      const member = run.members.find((candidate) => candidate.agentId === memberId);
      if (!member) throw new TeamRunError('Team member not found in this run', 404);
      requireEarlierStagesComplete(run, member.stageIndex);
      return restart(run, member.stageIndex, [memberId], `Retry ${agentOf(run, member).name}`);
    },

    /** Runs every member of a stage again, then the stages after it. */
    retryStage: (runId, stageIndex) => {
      const run = requireRun(runId);
      requireIdle(run);
      if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= run.team.stages.length) {
        throw new TeamRunError('Stage not found in this run', 404);
      }
      requireEarlierStagesComplete(run, stageIndex);
      return restart(run, stageIndex, null, `Retry stage ${stageIndex + 1}`);
    },

    /** Resolves when the run stops working (tests and shutdown). */
    settled: (runId) => drives.get(runId) ?? Promise.resolve(),

    /** Cancels every active run (server shutdown). */
    cancelAll: () => {
      for (const state of active.values()) {
        state.cancelled = true;
        for (const controller of state.controllers.values()) controller.abort();
      }
    },
  };
};
