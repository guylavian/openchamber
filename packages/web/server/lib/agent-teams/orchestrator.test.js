import { describe, expect, it } from 'vitest';

import { createTeamOrchestrator } from './orchestrator.js';

const agent = (id, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), role: id, instructions: `Do ${id} work.`, model: null, agent: null, edits: true, ...extra });

const featureTeam = {
  id: 'team-1',
  name: 'Feature Development',
  workspace: 'isolated',
  agents: [agent('planner', { edits: false }), agent('frontend'), agent('backend'), agent('reviewer', { edits: false })],
  stages: [
    { id: 's1', agentIds: ['planner'], mode: 'sequential' },
    { id: 's2', agentIds: ['frontend', 'backend'], mode: 'parallel' },
    { id: 's3', agentIds: ['reviewer'], mode: 'sequential' },
  ],
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A runMember whose members finish only when the test says so. Records the
 * order members started in and what each one was handed.
 */
const createControlledRunner = () => {
  const pending = new Map();
  const started = [];
  const calls = [];
  const runMember = ({ run, agent: teamAgent, handoffs, signal, onStarted }) => {
    started.push(teamAgent.id);
    calls.push({ runId: run.id, agentId: teamAgent.id, handoffs });
    onStarted({ sessionId: `ses-${teamAgent.id}-${calls.length}`, directory: `/wt/${teamAgent.id}`, worktree: null, model: 'p/m' });
    const gate = deferred();
    pending.set(teamAgent.id, gate);
    signal.addEventListener('abort', () => gate.reject(new Error('aborted')), { once: true });
    return gate.promise;
  };
  const finish = async (id, output = `${id} output`) => {
    pending.get(id).resolve({ output, changes: null });
    await flush();
  };
  const fail = async (id, message = `${id} broke`) => {
    pending.get(id).reject(new Error(message));
    await flush();
  };
  return { runMember, started, calls, finish, fail };
};

const setup = (runner, extra = {}) => {
  const saved = [];
  let clock = 1_000;
  let ids = 0;
  const orchestrator = createTeamOrchestrator({
    runMember: runner.runMember,
    persistRun: (run) => { saved.push(run); },
    now: () => (clock += 1),
    newId: () => `run-${(ids += 1)}`,
    ...extra,
  });
  return { orchestrator, saved };
};

const statusOf = (run) => Object.fromEntries(run.members.map((member) => [member.agentId, member.status]));

describe('team orchestration', () => {
  it('runs sequential stages in order and parallel members together', async () => {
    const runner = createControlledRunner();
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();

    expect(runner.started).toEqual(['planner']);
    expect(statusOf(orchestrator.getRun(run.id))).toEqual({ planner: 'running', frontend: 'pending', backend: 'pending', reviewer: 'pending' });

    await runner.finish('planner');
    // Both parallel members start before either finishes.
    expect(runner.started).toEqual(['planner', 'frontend', 'backend']);

    await runner.finish('backend');
    // The reviewer waits for the whole parallel stage.
    expect(runner.started).not.toContain('reviewer');
    expect(statusOf(orchestrator.getRun(run.id)).reviewer).toBe('pending');

    await runner.finish('frontend');
    expect(runner.started.at(-1)).toBe('reviewer');

    await runner.finish('reviewer');
    await orchestrator.settled(run.id);
    const done = orchestrator.getRun(run.id);
    expect(done.status).toBe('completed');
    expect(done.timeline.map((entry) => entry.kind)).toEqual([
      'run-started',
      'member-started', 'member-completed',
      'member-started', 'member-started', 'member-completed', 'member-completed',
      'member-started', 'member-completed',
      'run-completed',
    ]);
  });

  it('hands each member the output of earlier stages only', async () => {
    const runner = createControlledRunner();
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();
    await runner.finish('planner', 'THE PLAN');
    await runner.finish('frontend', 'LOGIN UI');
    await runner.finish('backend', 'OAUTH API');
    await runner.finish('reviewer');
    await orchestrator.settled(run.id);

    const handed = Object.fromEntries(runner.calls.map((call) => [call.agentId, call.handoffs.map((handoff) => handoff.output)]));
    expect(handed.planner).toEqual([]);
    expect(handed.frontend).toEqual(['THE PLAN']);
    // A parallel sibling's work is not handed across.
    expect(handed.backend).toEqual(['THE PLAN']);
    expect(handed.reviewer).toEqual(['THE PLAN', 'LOGIN UI', 'OAUTH API']);
  });

  it('hands a sequential stage-mate the output of the member before it', async () => {
    const runner = createControlledRunner();
    const team = {
      ...featureTeam,
      agents: [agent('developer'), agent('tester')],
      stages: [{ id: 's1', agentIds: ['developer', 'tester'], mode: 'sequential' }],
    };
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team, goal: 'Fix bug', directory: '/repo' });
    await flush();
    expect(runner.started).toEqual(['developer']);
    await runner.finish('developer', 'PATCHED');
    expect(runner.calls[1].handoffs.map((handoff) => handoff.output)).toEqual(['PATCHED']);
    await runner.finish('tester');
    await orchestrator.settled(run.id);
  });

  it('never hands one run the output of another', async () => {
    const runner = createControlledRunner();
    const team = { ...featureTeam, agents: [agent('planner'), agent('reviewer')], stages: [
      { id: 's1', agentIds: ['planner'], mode: 'sequential' },
      { id: 's2', agentIds: ['reviewer'], mode: 'sequential' },
    ] };
    const { orchestrator } = setup(runner);
    const first = orchestrator.startRun({ team, goal: 'First task', directory: '/repo' });
    await flush();
    await runner.finish('planner', 'FIRST PLAN');
    await runner.finish('reviewer');
    await orchestrator.settled(first.id);

    const second = orchestrator.startRun({ team, goal: 'Second task', directory: '/repo' });
    await flush();
    await runner.finish('planner', 'SECOND PLAN');
    const reviewerCall = runner.calls.filter((call) => call.runId === second.id && call.agentId === 'reviewer')[0];
    expect(reviewerCall.handoffs.map((handoff) => handoff.output)).toEqual(['SECOND PLAN']);
    await runner.finish('reviewer');
    await orchestrator.settled(second.id);
  });

  it('stops dependent stages when a member fails, and lets its parallel sibling finish', async () => {
    const runner = createControlledRunner();
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();
    await runner.finish('planner');
    await runner.fail('backend', 'Provider quota exceeded');
    expect(statusOf(orchestrator.getRun(run.id)).frontend).toBe('running');
    await runner.finish('frontend');
    await orchestrator.settled(run.id);

    const failed = orchestrator.getRun(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Stopped after Backend failed.');
    expect(statusOf(failed)).toEqual({ planner: 'completed', frontend: 'completed', backend: 'failed', reviewer: 'pending' });
    expect(failed.members.find((member) => member.agentId === 'backend').error).toBe('Provider quota exceeded');
    expect(runner.started).not.toContain('reviewer');
  });

  it('stops a sequential stage at its first failed member', async () => {
    const runner = createControlledRunner();
    const team = { ...featureTeam, agents: [agent('developer'), agent('tester')], stages: [{ id: 's1', agentIds: ['developer', 'tester'], mode: 'sequential' }] };
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team, goal: 'Fix bug', directory: '/repo' });
    await flush();
    await runner.fail('developer');
    await orchestrator.settled(run.id);
    expect(runner.started).toEqual(['developer']);
    expect(statusOf(orchestrator.getRun(run.id))).toEqual({ developer: 'failed', tester: 'pending' });
  });

  it('cancels running members and never starts later stages', async () => {
    const runner = createControlledRunner();
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();
    await runner.finish('planner');
    orchestrator.cancelRun(run.id);
    await orchestrator.settled(run.id);

    const cancelled = orchestrator.getRun(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(statusOf(cancelled)).toEqual({ planner: 'completed', frontend: 'cancelled', backend: 'cancelled', reviewer: 'pending' });
    expect(runner.started).not.toContain('reviewer');
    // Sessions stay linked for inspection.
    expect(cancelled.members.find((member) => member.agentId === 'frontend').sessionId).toMatch(/^ses-frontend/);
    expect(() => orchestrator.cancelRun(run.id)).toThrow('not running');
  });

  it('retries only the failed member, keeps its sibling, then continues', async () => {
    const runner = createControlledRunner();
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();
    await runner.finish('planner');
    await runner.fail('backend');
    await runner.finish('frontend', 'LOGIN UI');
    await orchestrator.settled(run.id);

    runner.started.length = 0;
    const retried = orchestrator.retryMember(run.id, 'backend');
    expect(retried.status).toBe('running');
    await flush();
    expect(runner.started).toEqual(['backend']);
    await runner.finish('backend', 'OAUTH API v2');
    expect(runner.started).toEqual(['backend', 'reviewer']);
    const reviewerCall = runner.calls.at(-1);
    expect(reviewerCall.handoffs.map((handoff) => handoff.output)).toEqual(['planner output', 'LOGIN UI', 'OAUTH API v2']);
    await runner.finish('reviewer');
    await orchestrator.settled(run.id);

    const done = orchestrator.getRun(run.id);
    expect(done.status).toBe('completed');
    expect(done.members.find((member) => member.agentId === 'backend').attempt).toBe(2);
    expect(done.members.find((member) => member.agentId === 'frontend').attempt).toBe(1);
  });

  it('retries a whole stage, including members that had completed', async () => {
    const runner = createControlledRunner();
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();
    await runner.finish('planner');
    await runner.fail('backend');
    await runner.finish('frontend');
    await orchestrator.settled(run.id);

    runner.started.length = 0;
    orchestrator.retryStage(run.id, 1);
    await flush();
    expect(runner.started.sort()).toEqual(['backend', 'frontend']);
    await runner.finish('frontend');
    await runner.finish('backend');
    await runner.finish('reviewer');
    await orchestrator.settled(run.id);
    expect(orchestrator.getRun(run.id).status).toBe('completed');
  });

  it('refuses a retry while the run is working or before earlier stages completed', async () => {
    const runner = createControlledRunner();
    const { orchestrator } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();
    expect(() => orchestrator.retryMember(run.id, 'planner')).toThrow('still working');
    await runner.fail('planner');
    await orchestrator.settled(run.id);
    expect(() => orchestrator.retryStage(run.id, 2)).toThrow('earlier stage');
    expect(() => orchestrator.retryMember(run.id, 'reviewer')).toThrow('earlier stage');
    expect(() => orchestrator.retryMember(run.id, 'nobody')).toThrow('not found');
  });

  it('marks a run left running by a previous server process as failed', () => {
    const runner = createControlledRunner();
    const stale = {
      id: 'old', teamId: 'team-1', teamName: 'T', goal: 'g', directory: '/repo', workspace: 'isolated',
      team: { agents: featureTeam.agents, stages: featureTeam.stages },
      status: 'running', error: null, createdAt: 1, updatedAt: 1, finishedAt: null, timeline: [],
      members: [
        { agentId: 'planner', stageIndex: 0, attempt: 1, status: 'running', sessionId: 'ses-1', directory: '/repo', worktree: null, model: null, startedAt: 1, finishedAt: null, output: null, changes: null, error: null },
      ],
    };
    const { orchestrator } = setup(runner, { initialRuns: [stale] });
    const recovered = orchestrator.getRun('old');
    expect(recovered.status).toBe('failed');
    expect(recovered.members[0].status).toBe('failed');
    expect(recovered.members[0].sessionId).toBe('ses-1');
    expect(recovered.members[0].error).toMatch(/restarted/);
  });

  it('persists every transition so a reload shows current state', async () => {
    const runner = createControlledRunner();
    const { orchestrator, saved } = setup(runner);
    const run = orchestrator.startRun({ team: featureTeam, goal: 'Add login', directory: '/repo' });
    await flush();
    expect(saved.at(-1).members.find((member) => member.agentId === 'planner').sessionId).toBe('ses-planner-1');
    orchestrator.cancelRun(run.id);
    await orchestrator.settled(run.id);
    expect(saved.at(-1).status).toBe('cancelled');
  });

  it('rejects a run without a task', () => {
    const { orchestrator } = setup(createControlledRunner());
    expect(() => orchestrator.startRun({ team: featureTeam, goal: '   ', directory: '/repo' })).toThrow('task is required');
  });
});
