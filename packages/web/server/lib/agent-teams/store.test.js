import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAgentTeamsStore, MAX_STORED_RUNS, pruneRuns } from './store.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-store-'));
const quiet = { warn: () => undefined };

const team = (id) => ({
  id, name: `Team ${id}`, workspace: 'isolated', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
  agents: [{ id: 'a', name: 'A', role: '', instructions: '', model: null, agent: null, edits: true }],
  stages: [{ id: 's', agentIds: ['a'], mode: 'sequential' }],
});

const run = (id, status, createdAt) => ({
  id, teamId: 't', teamName: 'T', goal: 'g', directory: '/repo', workspace: 'isolated',
  team: { agents: team('t').agents, stages: team('t').stages },
  status, error: null, createdAt, updatedAt: createdAt, finishedAt: null, timeline: [],
  members: [{ agentId: 'a', stageIndex: 0, attempt: 1, status: 'completed', sessionId: 's', directory: '/repo', worktree: null, model: null, startedAt: 1, finishedAt: 2, output: 'o', changes: null, error: null }],
});

describe('agent teams store', () => {
  it('treats a missing file as no teams and round-trips what it saves', async () => {
    const store = createAgentTeamsStore({ dataDir: await tempDir(), logger: quiet });
    expect(await store.loadTeams()).toEqual([]);
    await store.saveTeams([team('1'), team('2')]);
    expect((await store.loadTeams()).map((entry) => entry.id)).toEqual(['1', '2']);
    await store.saveRuns([run('r1', 'completed', 5)]);
    expect((await store.loadRuns())[0]).toMatchObject({ id: 'r1', status: 'completed' });
  });

  it('skips one damaged team and keeps the others', async () => {
    const dataDir = await tempDir();
    await fs.writeFile(path.join(dataDir, 'agent-teams.json'), JSON.stringify({ version: 1, items: [team('ok'), { id: 'broken' }] }));
    const store = createAgentTeamsStore({ dataDir, logger: quiet });
    expect((await store.loadTeams()).map((entry) => entry.id)).toEqual(['ok']);
  });

  it('reports a file that is not valid JSON instead of returning no teams', async () => {
    const dataDir = await tempDir();
    await fs.writeFile(path.join(dataDir, 'agent-teams.json'), '{ not json');
    const store = createAgentTeamsStore({ dataDir, logger: quiet });
    await expect(store.loadTeams()).rejects.toThrow();
  });

  it('drops a run whose members do not match its team snapshot', async () => {
    const dataDir = await tempDir();
    const broken = run('bad', 'completed', 1);
    broken.members[0].agentId = 'ghost';
    await fs.writeFile(path.join(dataDir, 'agent-team-runs.json'), JSON.stringify({ version: 1, items: [run('good', 'completed', 2), broken] }));
    const store = createAgentTeamsStore({ dataDir, logger: quiet });
    expect((await store.loadRuns()).map((entry) => entry.id)).toEqual(['good']);
  });

  it('keeps every running run and the newest finished ones', () => {
    const runs = [run('live', 'running', 0)];
    for (let i = 1; i <= MAX_STORED_RUNS + 5; i += 1) runs.push(run(`r${i}`, 'completed', i));
    const kept = pruneRuns(runs);
    expect(kept).toHaveLength(MAX_STORED_RUNS);
    expect(kept.some((entry) => entry.id === 'live')).toBe(true);
    expect(kept.some((entry) => entry.id === 'r1')).toBe(false);
  });
});
