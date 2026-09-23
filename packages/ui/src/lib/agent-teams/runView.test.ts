import { describe, expect, test } from 'bun:test';

import type { TeamAgent, TeamRun, TeamRunMember } from './api';
import { elapsedMs, formatElapsed, headlineOf, sharedParallelEditors, stagesOfRun, summarizeRun } from './runView';

const agent = (id: string, edits = true): TeamAgent => ({ id, name: id.toUpperCase(), role: id, instructions: '', model: null, agent: null, edits });

const member = (agentId: string, stageIndex: number, extra: Partial<TeamRunMember> = {}): TeamRunMember => ({
  agentId, stageIndex, attempt: 1, status: 'completed', sessionId: `ses-${agentId}`, directory: '/repo', worktree: null,
  model: null, startedAt: 1_000, finishedAt: 61_000, output: null, changes: null, error: null, ...extra,
});

const run: TeamRun = {
  id: 'r1', teamId: 't1', teamName: 'Feature', goal: 'Add login', directory: '/repo', workspace: 'isolated',
  team: {
    agents: [agent('planner', false), agent('frontend'), agent('backend'), agent('reviewer', false)],
    stages: [
      { id: 's1', agentIds: ['planner'], mode: 'sequential' },
      { id: 's2', agentIds: ['frontend', 'backend'], mode: 'parallel' },
      { id: 's3', agentIds: ['reviewer'], mode: 'sequential' },
    ],
  },
  status: 'completed', error: null, createdAt: 1, updatedAt: 2, finishedAt: 3, timeline: [],
  members: [
    member('planner', 0, { output: '## Plan\n1. Add routes' }),
    member('frontend', 1, { output: 'Added login UI.' }),
    member('backend', 1, { status: 'failed', error: 'Rate limit reached', output: null }),
    member('reviewer', 2, { status: 'pending', startedAt: null, finishedAt: null }),
  ],
};

describe('run view helpers', () => {
  test('groups members by stage in definition order', () => {
    expect(stagesOfRun(run).map((stage) => [stage.mode, stage.members.map(({ agent: a }) => a.id)])).toEqual([
      ['sequential', ['planner']],
      ['parallel', ['frontend', 'backend']],
      ['sequential', ['reviewer']],
    ]);
  });

  test('summarizes each member with its headline or its error', () => {
    expect(summarizeRun(run)).toEqual([
      { agentId: 'planner', name: 'PLANNER', status: 'completed', headline: 'Plan' },
      { agentId: 'frontend', name: 'FRONTEND', status: 'completed', headline: 'Added login UI.' },
      { agentId: 'backend', name: 'BACKEND', status: 'failed', headline: 'Rate limit reached' },
      { agentId: 'reviewer', name: 'REVIEWER', status: 'pending', headline: null },
    ]);
  });

  test('takes the first meaningful line as a headline', () => {
    expect(headlineOf('\n\n> **Summary**\nrest')).toBe('Summary');
    expect(headlineOf('')).toBeNull();
    // The closing summary, not the opening line.
    expect(headlineOf('Here is what I did:\n\n- step one\n\nAdded OAuth endpoints and tests.')).toBe('Added OAuth endpoints and tests.');
    expect(headlineOf('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  test('measures elapsed time, running members against now', () => {
    expect(elapsedMs(run.members[0], 999_999)).toBe(60_000);
    expect(elapsedMs({ ...run.members[1], finishedAt: null }, 31_000)).toBe(30_000);
    expect(elapsedMs(run.members[3], 5)).toBeNull();
    expect(formatElapsed(59_400)).toBe('59s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
  });

  test('flags parallel editors that would share one checkout', () => {
    const input = { name: 'T', workspace: 'shared' as const, agents: run.team.agents, stages: run.team.stages };
    expect(sharedParallelEditors(input)).toEqual([['FRONTEND', 'BACKEND']]);
    expect(sharedParallelEditors({ ...input, workspace: 'isolated' })).toEqual([]);
  });
});
