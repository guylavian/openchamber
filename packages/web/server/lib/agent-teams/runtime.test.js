import { describe, expect, it, vi } from 'vitest';

import { createAgentTeamsRuntime } from './runtime.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const teamInput = {
  name: 'Feature Development',
  agents: [
    { id: 'planner', name: 'Planner', role: 'planner', instructions: 'Plan it.', edits: false },
    { id: 'backend', name: 'Backend', role: 'backend', instructions: 'Build it.', model: { providerID: 'openai', modelID: 'gpt-5' } },
    { id: 'reviewer', name: 'Reviewer', role: 'reviewer', instructions: 'Review it.', edits: false, agent: 'review' },
  ],
  stages: [
    { id: 's1', agentIds: ['planner'] },
    { id: 's2', agentIds: ['backend'] },
    { id: 's3', agentIds: ['reviewer'] },
  ],
};

const memoryStore = (initialTeams = []) => {
  const state = { teams: initialTeams, runs: [] };
  return {
    state,
    loadTeams: async () => state.teams,
    saveTeams: async (teams) => { state.teams = teams; },
    loadRuns: async () => state.runs,
    saveRuns: async (runs) => { state.runs = runs; },
  };
};

/**
 * Fakes for the session machinery. Each created session "answers" with the
 * text given for its member, and a member can be made to fail or to hang.
 */
const createFakes = ({ answers = {}, failing = {}, hanging = new Set() } = {}) => {
  const created = [];
  const interrupted = [];
  const recordsBySession = new Map();
  const sessionService = {
    create: vi.fn(async (payload) => {
      const index = created.length + 1;
      const memberName = payload.title.split(' · ')[1];
      const sessionId = `ses-${index}`;
      const directory = payload.worktree ? `/worktrees/${payload.worktree.name}` : payload.directory;
      created.push({ ...payload, sessionId, memberName });
      recordsBySession.set(sessionId, failing[memberName]
        ? [{ type: 'idle', outcome: 'failed' }, { type: 'assistant', content: [], error: { type: 'X', message: failing[memberName] } }]
        : [{ type: 'idle', outcome: 'succeeded' }, { type: 'assistant', content: [{ type: 'text', text: answers[memberName] ?? `${memberName} done` }] }]);
      const result = { sessionId, directory, promptDispatched: true, model: payload.model ?? 'anthropic/claude' };
      if (payload.worktree) result.worktree = { path: directory, branch: payload.worktree.branchName };
      return result;
    }),
    setMetadata: vi.fn(async () => ({})),
  };
  const waitForTurn = vi.fn(({ sessionId, signal }) => {
    const memberName = created.find((entry) => entry.sessionId === sessionId)?.memberName;
    if (!hanging.has(memberName)) return Promise.resolve({ type: 'idle' });
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('OpenChamber action was cancelled')), { once: true });
    });
  });
  const openCodeClientFor = () => ({
    message: { list: async ({ sessionID }) => ({ data: recordsBySession.get(sessionID) }) },
    session: { interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } },
  });
  return { created, interrupted, sessionService, waitForTurn, openCodeClientFor };
};

const setup = async (fakes, extra = {}) => {
  const store = extra.store ?? memoryStore();
  const broadcast = vi.fn();
  const runtime = createAgentTeamsRuntime({
    store,
    sessionService: fakes.sessionService,
    waitForTurn: fakes.waitForTurn,
    openCodeClientFor: fakes.openCodeClientFor,
    getLog: async () => ({ latest: { hash: 'base123' } }),
    getRangeDiff: vi.fn(async (directory) => `diff of ${directory}`),
    broadcast,
    logger: { warn: () => undefined },
  });
  await runtime.start();
  return { runtime, store, broadcast };
};

const waitFor = async (predicate) => {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('condition not reached');
};

describe('agent teams runtime', () => {
  it('runs each member as a real session with its own model, agent and workspace', async () => {
    const fakes = createFakes({ answers: { Planner: 'THE PLAN', Backend: 'OAUTH READY' } });
    const { runtime } = await setup(fakes);
    const team = await runtime.createTeam(teamInput);
    const run = runtime.startRun(team.id, { goal: 'Add OAuth login', directory: '/repo' });
    await waitFor(() => runtime.getRun(run.id).status !== 'running');

    const [planner, backend, reviewer] = fakes.created;
    // A member that only reads works in the project, with the read-only agent.
    expect(planner).toMatchObject({ directory: '/repo', agent: 'plan' });
    expect(planner.worktree).toBeUndefined();
    // A member that edits gets its own worktree from the current commit.
    expect(backend).toMatchObject({ model: 'openai/gpt-5', worktree: { startRef: 'base123' } });
    expect(backend.worktree.branchName).toMatch(/^team\/.+-backend-1$/);
    // An explicitly chosen agent wins over the read-only default.
    expect(reviewer.agent).toBe('review');

    expect(backend.prompt).toContain('THE PLAN');
    expect(reviewer.prompt).toContain('THE PLAN');
    expect(reviewer.prompt).toContain('OAUTH READY');
    expect(reviewer.prompt).toContain(`diff of /worktrees/${backend.worktree.name}`);

    const done = runtime.getRun(run.id);
    expect(done.status).toBe('completed');
    expect(done.members.map((member) => member.sessionId)).toEqual(['ses-1', 'ses-2', 'ses-3']);
    expect(done.members[1].worktree).toEqual({ path: `/worktrees/${backend.worktree.name}`, branch: backend.worktree.branchName });
    expect(fakes.sessionService.setMetadata).toHaveBeenCalledWith('ses-1', expect.objectContaining({
      patch: { openchamber: { agentTeam: expect.objectContaining({ runId: run.id, memberId: 'planner' }) } },
    }));
  });

  it('shares the project directory in shared mode', async () => {
    const fakes = createFakes();
    const { runtime } = await setup(fakes);
    const team = await runtime.createTeam({ ...teamInput, workspace: 'shared' });
    const run = runtime.startRun(team.id, { goal: 'g', directory: '/repo' });
    await waitFor(() => runtime.getRun(run.id).status !== 'running');
    expect(fakes.created.every((entry) => entry.worktree === undefined && entry.directory === '/repo')).toBe(true);
  });

  it('marks a member failed with the session error and stops the run there', async () => {
    const fakes = createFakes({ failing: { Backend: 'Rate limit reached' } });
    const { runtime } = await setup(fakes);
    const team = await runtime.createTeam(teamInput);
    const run = runtime.startRun(team.id, { goal: 'g', directory: '/repo' });
    await waitFor(() => runtime.getRun(run.id).status !== 'running');
    const failed = runtime.getRun(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.members[1]).toMatchObject({ status: 'failed', error: 'Rate limit reached', sessionId: 'ses-2' });
    expect(fakes.created).toHaveLength(2);
  });

  it('interrupts the running session when the run is cancelled', async () => {
    const fakes = createFakes({ hanging: new Set(['Planner']) });
    const { runtime } = await setup(fakes);
    const team = await runtime.createTeam(teamInput);
    const run = runtime.startRun(team.id, { goal: 'g', directory: '/repo' });
    await waitFor(() => runtime.getRun(run.id).members[0].sessionId === 'ses-1');
    runtime.cancelRun(run.id);
    await waitFor(() => runtime.getRun(run.id).status !== 'running');
    expect(runtime.getRun(run.id).status).toBe('cancelled');
    expect(fakes.interrupted).toContain('ses-1');
    expect(fakes.created).toHaveLength(1);
  });

  it('persists teams and announces changes', async () => {
    const fakes = createFakes();
    const { runtime, store, broadcast } = await setup(fakes);
    const team = await runtime.createTeam(teamInput);
    const renamed = await runtime.updateTeam(team.id, { ...teamInput, name: 'Renamed' });
    expect(renamed.createdAt).toBe(team.createdAt);
    expect(store.state.teams.map((entry) => entry.name)).toEqual(['Renamed']);
    await runtime.deleteTeam(team.id);
    expect(store.state.teams).toEqual([]);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'openchamber:agent-teams.updated' }));
  });

  it('refuses to change teams when the teams file could not be read', async () => {
    const fakes = createFakes();
    const store = memoryStore();
    store.loadTeams = async () => { throw new Error('Invalid agent-teams.json'); };
    const saveTeams = vi.spyOn(store, 'saveTeams');
    const { runtime } = await setup(fakes, { store });
    await expect(runtime.createTeam(teamInput)).rejects.toMatchObject({ statusCode: 503 });
    expect(() => runtime.listTeams()).toThrow(/could not be read/);
    expect(saveTeams).not.toHaveBeenCalled();
  });
});
