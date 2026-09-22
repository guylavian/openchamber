import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { TeamValidationError } from './model.js';
import { TeamRunError } from './orchestrator.js';
import { registerAgentTeamRoutes } from './routes.js';

const createApp = (runtime) => {
  const app = express();
  registerAgentTeamRoutes(app, { agentTeamsRuntime: runtime });
  return app;
};

describe('agent team routes', () => {
  it('maps validation and run errors to their status codes', async () => {
    const app = createApp({
      createTeam: vi.fn(async () => { throw new TeamValidationError('name: Required'); }),
      startRun: vi.fn(() => { throw new TeamRunError('Team not found', 404); }),
      cancelRun: vi.fn(() => { throw new TeamRunError('The run is not running.'); }),
    });
    await request(app).post('/api/openchamber/agent-teams').send({}).expect(400, { error: 'name: Required' });
    await request(app).post('/api/openchamber/agent-teams/nope/runs').send({ goal: 'g', directory: '/repo' }).expect(404);
    await request(app).post('/api/openchamber/agent-teams/runs/r1/cancel').expect(409);
  });

  it('starts a run with the goal and directory, and routes retries by target', async () => {
    const runtime = {
      startRun: vi.fn(() => ({ id: 'r1' })),
      retryMember: vi.fn(() => ({ id: 'r1' })),
      retryStage: vi.fn(() => ({ id: 'r1' })),
    };
    const app = createApp(runtime);
    await request(app).post('/api/openchamber/agent-teams/t1/runs').send({ goal: 'Add login', directory: ' /repo ' }).expect(200);
    expect(runtime.startRun).toHaveBeenCalledWith('t1', { goal: 'Add login', directory: '/repo' });
    await request(app).post('/api/openchamber/agent-teams/runs/r1/retry').send({ memberId: 'backend' }).expect(200);
    expect(runtime.retryMember).toHaveBeenCalledWith('r1', 'backend');
    await request(app).post('/api/openchamber/agent-teams/runs/r1/retry').send({ stageIndex: 1 }).expect(200);
    expect(runtime.retryStage).toHaveBeenCalledWith('r1', 1);
  });

  it('lists runs without member output or diffs', async () => {
    const app = createApp({
      listRuns: () => [{ id: 'r1', members: [{ agentId: 'a', output: 'long text', changes: { diff: 'x' } }] }],
    });
    const response = await request(app).get('/api/openchamber/agent-teams/runs').expect(200);
    expect(response.body.runs[0].members[0]).toEqual({ agentId: 'a', hasOutput: true, hasChanges: true });
  });
});
