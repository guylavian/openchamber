/**
 * Agent teams on this server: team definitions, and the runs of them.
 *
 * The orchestrator decides the order of work. This module does the work for
 * one member, entirely through OpenChamber's existing session machinery:
 *
 * - the session is created by the same session service the CLI and the
 *   `openchamber` agent tool use, which also creates the worktree, applies the
 *   member's model and agent, and dispatches the prompt;
 * - waiting uses the control service's wait, so an idle reading before the
 *   turn started is never taken for a finished member;
 * - how the turn ended is read from the session's own records.
 *
 * A member that edits, in an isolated team, gets a new worktree started from
 * the project's current commit, and its diff against that commit is what the
 * members after it see. Nothing is merged: the worktrees stay for the user.
 */
import { getLog as getLogDefault, getRangeDiff as getRangeDiffDefault } from '../git/index.js';
import { modelRef, parseTeamInput } from './model.js';
import { createTeamOrchestrator, TeamRunError } from './orchestrator.js';
import { buildMemberPrompt, excerpt, HANDOFF_DIFF_LIMIT } from './prompts.js';
import { createAgentTeamsStore } from './store.js';
import { readTurnResult } from './turn-result.js';

/** A member working longer than this is stopped and counted as failed. */
const DEFAULT_MEMBER_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** A stored member output is capped; the full text stays in its session. */
const STORED_OUTPUT_LIMIT = 50_000;
/** Run writes are coalesced: a burst of status changes becomes one write. */
const RUN_SAVE_DELAY_MS = 300;

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'member';

class AgentTeamsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentTeamsUnavailableError';
    this.statusCode = 503;
  }
}

export const createAgentTeamsRuntime = ({
  dataDir,
  store = createAgentTeamsStore({ dataDir }),
  sessionService,
  waitForTurn,
  openCodeClientFor,
  getLog = getLogDefault,
  getRangeDiff = getRangeDiffDefault,
  broadcast = () => undefined,
  memberTimeoutMs = DEFAULT_MEMBER_TIMEOUT_MS,
  logger = console,
  now = Date.now,
}) => {
  let teams = [];
  /** Why the teams file could not be read; mutations are refused until it is fixed. */
  let teamsLoadError = null;
  const runsById = new Map();
  let runSaveTimer = null;
  let orchestrator = null;

  const flushRuns = () => {
    if (runSaveTimer) clearTimeout(runSaveTimer);
    runSaveTimer = null;
    return store.saveRuns([...runsById.values()]).catch((error) => {
      logger.warn?.('[agent-teams] could not save team runs:', error?.message || error);
    });
  };

  const persistRun = (run) => {
    runsById.set(run.id, run);
    broadcast({
      type: 'openchamber:agent-team-run.updated',
      properties: { runId: run.id, teamId: run.teamId, status: run.status, updatedAt: run.updatedAt },
    });
    if (!runSaveTimer) runSaveTimer = setTimeout(() => { void flushRuns(); }, RUN_SAVE_DELAY_MS);
  };

  const newestRecords = async (sessionId, directory) => {
    const response = await openCodeClientFor(directory).message.list({ sessionID: sessionId, limit: 50, order: 'desc' });
    return Array.isArray(response?.data) ? response.data : [];
  };

  const interrupt = async (sessionId, directory) => {
    try {
      await openCodeClientFor(directory).session.interrupt({ sessionID: sessionId });
    } catch (error) {
      logger.warn?.('[agent-teams] could not interrupt a member session:', error?.message || error);
    }
  };

  const currentCommit = async (directory) => {
    let log;
    try {
      log = await getLog(directory, { maxCount: 1 });
    } catch {
      log = null;
    }
    const hash = log?.latest?.hash;
    if (!hash) {
      throw new Error('Isolated worktrees need a git repository with at least one commit. Use a shared workspace for this project, or commit first.');
    }
    return hash;
  };

  /** Runs one member in a session of its own and reports how it ended. */
  const runMember = async ({ run, member, agent, handoffs, signal, onStarted }) => {
    if (signal.aborted) throw new Error('Cancelled');
    const readOnly = !agent.edits;
    const isolated = run.workspace === 'isolated' && !readOnly;
    const shortRun = run.id.slice(0, 8);
    const worktreeName = `team-${shortRun}-${slug(agent.name)}-${member.attempt}`;
    const branchName = `team/${shortRun}-${slug(agent.name)}-${member.attempt}`;
    const baseRef = isolated ? await currentCommit(run.directory) : null;

    const prompt = buildMemberPrompt({
      teamName: run.teamName,
      goal: run.goal,
      member: agent,
      workspace: {
        directory: isolated ? null : run.directory,
        worktree: isolated ? { branch: branchName } : null,
        readOnly,
        shared: run.workspace === 'shared' && !readOnly,
      },
      handoffs,
    });

    // A member that only reads uses OpenCode's `plan` agent unless the user
    // picked one, so "read only" is enforced by permissions, not by asking.
    const openCodeAgent = agent.agent ?? (readOnly ? 'plan' : null);
    const startedAt = now();
    const request = { directory: run.directory, title: `${run.teamName} · ${agent.name}`, prompt };
    if (agent.model) request.model = modelRef(agent.model);
    if (openCodeAgent) request.agent = openCodeAgent;
    if (isolated) request.worktree = { name: worktreeName, branchName, startRef: baseRef };
    const created = await sessionService.create(request);

    const worktree = created.worktree
      ? { path: created.worktree.path, branch: created.worktree.branch || branchName }
      : null;
    // The session service reports the model it applied as { providerID, modelID }.
    onStarted({ sessionId: created.sessionId, directory: created.directory, worktree, model: modelRef(created.model) });
    // Tags the session with where it came from, so it can be traced back to
    // its run from anywhere sessions are listed. Best effort.
    void sessionService.setMetadata(created.sessionId, {
      directory: created.directory,
      patch: { openchamber: { agentTeam: { runId: run.id, teamId: run.teamId, memberId: agent.id, attempt: member.attempt } } },
    }).catch(() => undefined);

    if (!created.promptDispatched) {
      throw new Error(created.promptError || 'The task was not delivered to the member\'s session.');
    }

    const onAbort = () => { void interrupt(created.sessionId, created.directory); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error('Cancelled');
      await waitForTurn({
        sessionId: created.sessionId,
        directory: created.directory,
        startedAt,
        timeoutMs: memberTimeoutMs,
        signal,
      });
    } catch (error) {
      if (!signal.aborted) void interrupt(created.sessionId, created.directory);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    const result = readTurnResult(await newestRecords(created.sessionId, created.directory));
    if (!result.ok) throw new Error(result.error);

    let changes = null;
    if (isolated && worktree) {
      const diff = await getRangeDiff(worktree.path, { base: baseRef, head: 'HEAD', includeWorkingTree: true })
        .catch((error) => {
          logger.warn?.('[agent-teams] could not read a member\'s changes:', error?.message || error);
          return '';
        });
      changes = { directory: worktree.path, branch: worktree.branch, diff: excerpt(diff, HANDOFF_DIFF_LIMIT) };
    }
    return { output: excerpt(result.output, STORED_OUTPUT_LIMIT), changes };
  };

  const requireTeams = () => {
    if (teamsLoadError) {
      throw new AgentTeamsUnavailableError(`agent-teams.json could not be read (${teamsLoadError}). Fix or move the file, then restart OpenChamber.`);
    }
  };

  const findTeam = (teamId) => {
    const team = teams.find((candidate) => candidate.id === teamId);
    if (!team) throw new TeamRunError('Team not found', 404);
    return team;
  };

  const saveTeams = async (next) => {
    await store.saveTeams(next);
    teams = next;
    broadcast({ type: 'openchamber:agent-teams.updated', properties: { updatedAt: now() } });
  };

  const requireOrchestrator = () => {
    if (!orchestrator) throw new AgentTeamsUnavailableError('Agent teams are still starting.');
    return orchestrator;
  };

  return {
    async start() {
      try {
        teams = await store.loadTeams();
      } catch (error) {
        teamsLoadError = error?.message || String(error);
        logger.warn?.('[agent-teams] could not read teams:', teamsLoadError);
      }
      let storedRuns = [];
      try {
        storedRuns = await store.loadRuns();
      } catch (error) {
        logger.warn?.('[agent-teams] could not read team runs:', error?.message || error);
      }
      for (const run of storedRuns) runsById.set(run.id, run);
      orchestrator = createTeamOrchestrator({ runMember, persistRun, initialRuns: storedRuns, now });
      // Runs recovered from a previous process were marked failed in memory;
      // write that down so the file agrees.
      if (storedRuns.some((run) => run.status === 'running')) {
        for (const run of orchestrator.listRuns()) runsById.set(run.id, run);
        await flushRuns();
      }
    },

    // Shutdown is not a cancel: the member sessions are left alone, and the
    // next start marks the run as interrupted by the restart.
    async stop() {
      await flushRuns();
    },

    listTeams() {
      requireTeams();
      return teams;
    },

    async createTeam(input) {
      requireTeams();
      const body = parseTeamInput(input);
      const at = new Date(now()).toISOString();
      const team = { id: crypto.randomUUID(), ...body, createdAt: at, updatedAt: at };
      await saveTeams([...teams, team]);
      return team;
    },

    async updateTeam(teamId, input) {
      requireTeams();
      const existing = findTeam(teamId);
      const body = parseTeamInput(input);
      const team = { ...existing, ...body, updatedAt: new Date(now()).toISOString() };
      await saveTeams(teams.map((candidate) => (candidate.id === teamId ? team : candidate)));
      return team;
    },

    async deleteTeam(teamId) {
      requireTeams();
      findTeam(teamId);
      // Past runs keep their own copy of the team and stay inspectable.
      await saveTeams(teams.filter((candidate) => candidate.id !== teamId));
    },

    listRuns: () => requireOrchestrator().listRuns(),
    getRun: (runId) => requireOrchestrator().getRun(runId),

    startRun(teamId, { goal, directory }) {
      requireTeams();
      const team = findTeam(teamId);
      return requireOrchestrator().startRun({ team, goal, directory });
    },

    cancelRun: (runId) => requireOrchestrator().cancelRun(runId),
    retryMember: (runId, memberId) => requireOrchestrator().retryMember(runId, memberId),
    retryStage: (runId, stageIndex) => requireOrchestrator().retryStage(runId, stageIndex),
  };
};

