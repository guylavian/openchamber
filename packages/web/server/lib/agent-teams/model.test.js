import { describe, expect, it } from 'vitest';

import { normalizeStages, parseStoredTeam, parseTeamInput } from './model.js';

const member = (id, extra = {}) => ({ id, name: id, ...extra });

describe('team definitions', () => {
  it('fills member defaults and keeps stage order', () => {
    const team = parseTeamInput({
      name: '  Feature Development ',
      agents: [member('planner', { edits: false }), member('frontend'), member('backend'), member('reviewer')],
      stages: [
        { id: 's1', agentIds: ['planner'] },
        { id: 's2', agentIds: ['frontend', 'backend'], mode: 'parallel' },
        { id: 's3', agentIds: ['reviewer'] },
      ],
    });
    expect(team.name).toBe('Feature Development');
    expect(team.workspace).toBe('isolated');
    expect(team.agents[1]).toEqual({ id: 'frontend', name: 'frontend', role: '', instructions: '', model: null, agent: null, edits: true });
    expect(team.stages.map((stage) => [stage.agentIds, stage.mode])).toEqual([
      [['planner'], 'sequential'],
      [['frontend', 'backend'], 'parallel'],
      [['reviewer'], 'sequential'],
    ]);
  });

  it('repairs stages: drops unknown and repeated members, empty stages, and adds unplaced members', () => {
    const stages = normalizeStages(
      [member('a'), member('b'), member('c')],
      [
        { id: 's1', agentIds: ['a', 'ghost'], mode: 'sequential' },
        { id: 's2', agentIds: ['a'], mode: 'parallel' },
        { id: 's3', agentIds: ['b'], mode: 'parallel' },
      ],
    );
    expect(stages.map((stage) => stage.agentIds)).toEqual([['a'], ['b'], ['c']]);
  });

  it('gives every member a stage when none are sent', () => {
    const team = parseTeamInput({ name: 'Solo', agents: [member('only')], stages: [] });
    expect(team.stages).toEqual([{ id: 'stage-only', agentIds: ['only'], mode: 'sequential' }]);
  });

  it('rejects invalid input with the field that is wrong', () => {
    expect(() => parseTeamInput({ name: '', agents: [member('a')], stages: [] })).toThrow(/name/);
    expect(() => parseTeamInput({ name: 'T', agents: [], stages: [] })).toThrow(/agents/);
    expect(() => parseTeamInput({ name: 'T', agents: [member('a'), member('a')], stages: [] })).toThrow('Duplicate member id');
    expect(() => parseTeamInput({ name: 'T', agents: [member('a')], stages: [], extra: true })).toThrow();
    expect(() => parseTeamInput({ name: 'T', agents: [member('bad id!')], stages: [] })).toThrow();
  });

  it('drops a stored team that no longer parses instead of failing', () => {
    expect(parseStoredTeam({ id: 't', name: 'T', agents: 'nope' })).toBeNull();
    const repaired = parseStoredTeam({
      id: 't', name: 'T', workspace: 'shared', createdAt: 'x', updatedAt: 'x',
      agents: [member('a')], stages: [{ id: 's', agentIds: ['a', 'gone'], mode: 'parallel' }],
    });
    expect(repaired.stages[0].agentIds).toEqual(['a']);
  });
});
