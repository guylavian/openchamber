import express from 'express';

const json = express.json({ limit: '256kb' });

/** The run list omits member output and diffs; open a run to read them. */
const summarizeRun = (run) => ({
  ...run,
  members: run.members.map(({ output, changes, ...member }) => ({ ...member, hasOutput: Boolean(output), hasChanges: Boolean(changes) })),
});

const send = async (res, work) => {
  try {
    const data = await work();
    res.json(data);
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Agent team request failed' });
  }
};

/**
 * Registers the agent-team routes. Thin: every rule lives in the runtime and
 * the modules under it; these only move JSON in and out.
 */
export const registerAgentTeamRoutes = (app, { agentTeamsRuntime }) => {
  const base = '/api/openchamber/agent-teams';

  app.get(`${base}`, (_req, res) => send(res, () => ({ teams: agentTeamsRuntime.listTeams() })));
  app.post(`${base}`, json, (req, res) => send(res, async () => ({ team: await agentTeamsRuntime.createTeam(req.body) })));

  app.get(`${base}/runs`, (_req, res) => send(res, () => ({ runs: agentTeamsRuntime.listRuns().map(summarizeRun) })));
  app.get(`${base}/runs/:runId`, (req, res) => send(res, () => ({ run: agentTeamsRuntime.getRun(req.params.runId) })));
  app.post(`${base}/runs/:runId/cancel`, (req, res) => send(res, () => ({ run: agentTeamsRuntime.cancelRun(req.params.runId) })));
  app.post(`${base}/runs/:runId/retry`, json, (req, res) => send(res, () => {
    const memberId = typeof req.body?.memberId === 'string' ? req.body.memberId : null;
    const run = memberId
      ? agentTeamsRuntime.retryMember(req.params.runId, memberId)
      : agentTeamsRuntime.retryStage(req.params.runId, req.body?.stageIndex);
    return { run };
  }));

  app.put(`${base}/:teamId`, json, (req, res) => send(res, async () => ({ team: await agentTeamsRuntime.updateTeam(req.params.teamId, req.body) })));
  app.delete(`${base}/:teamId`, (req, res) => send(res, async () => {
    await agentTeamsRuntime.deleteTeam(req.params.teamId);
    return { ok: true };
  }));
  app.post(`${base}/:teamId/runs`, json, (req, res) => send(res, () => ({
    run: agentTeamsRuntime.startRun(req.params.teamId, {
      goal: typeof req.body?.goal === 'string' ? req.body.goal : '',
      directory: typeof req.body?.directory === 'string' ? req.body.directory.trim() : '',
    }),
  })));
};
