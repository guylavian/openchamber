import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Agent teams, as the OpenChamber server stores and runs them. The server
 * (`packages/web/server/lib/agent-teams`) owns every rule; this module moves
 * JSON and parses it once, so the views work with trusted types.
 */

const modelSchema = z.object({ providerID: z.string(), modelID: z.string() });

const teamAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  instructions: z.string(),
  model: modelSchema.nullable(),
  agent: z.string().nullable(),
  edits: z.boolean(),
});

const teamStageSchema = z.object({
  id: z.string(),
  agentIds: z.array(z.string()),
  mode: z.enum(['parallel', 'sequential']),
});

const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspace: z.enum(['isolated', 'shared']),
  agents: z.array(teamAgentSchema),
  stages: z.array(teamStageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const memberStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
const runStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);

const runMemberSchema = z.object({
  agentId: z.string(),
  stageIndex: z.number(),
  attempt: z.number(),
  status: memberStatusSchema,
  sessionId: z.string().nullable(),
  directory: z.string().nullable(),
  worktree: z.object({ path: z.string(), branch: z.string().nullable() }).nullable(),
  model: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  // Absent in the run list, which leaves out output and diffs.
  output: z.string().nullable().optional(),
  changes: z.object({ directory: z.string(), branch: z.string().nullable(), diff: z.string() }).nullable().optional(),
  error: z.string().nullable(),
});

const timelineEntrySchema = z.object({
  at: z.number(),
  kind: z.string(),
  memberId: z.string().nullable(),
  message: z.string().nullable(),
});

const runSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  goal: z.string(),
  directory: z.string(),
  workspace: z.enum(['isolated', 'shared']),
  team: z.object({ agents: z.array(teamAgentSchema), stages: z.array(teamStageSchema) }),
  status: runStatusSchema,
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  members: z.array(runMemberSchema),
  timeline: z.array(timelineEntrySchema),
});

export type TeamAgent = z.infer<typeof teamAgentSchema>;
export type TeamStage = z.infer<typeof teamStageSchema>;
export type AgentTeam = z.infer<typeof teamSchema>;
export type MemberStatus = z.infer<typeof memberStatusSchema>;
export type TeamRunMember = z.infer<typeof runMemberSchema>;
export type TeamRunTimelineEntry = z.infer<typeof timelineEntrySchema>;
export type TeamRun = z.infer<typeof runSchema>;

/** What the editor sends: a team without its server-owned id and dates. */
export type AgentTeamInput = Pick<AgentTeam, 'name' | 'workspace' | 'agents' | 'stages'>;

const errorBodySchema = z.object({ error: z.string() });

const request = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
  const response = await runtimeFetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = errorBodySchema.safeParse(body);
    throw new Error(parsedError.success ? parsedError.data.error : `Request failed (${response.status})`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('The server sent an unexpected agent-team response');
  return parsed.data;
};

export type TeamRetryTarget = { memberId: string } | { stageIndex: number };

type RequestBody = AgentTeamInput | TeamRetryTarget | { goal: string; directory: string };

const jsonInit = (method: string, body: RequestBody): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const BASE = '/api/openchamber/agent-teams';

export const fetchAgentTeams = async (): Promise<AgentTeam[]> =>
  (await request(BASE, z.object({ teams: z.array(teamSchema) }))).teams;

export const createAgentTeam = async (input: AgentTeamInput): Promise<AgentTeam> =>
  (await request(BASE, z.object({ team: teamSchema }), jsonInit('POST', input))).team;

export const updateAgentTeam = async (teamId: string, input: AgentTeamInput): Promise<AgentTeam> =>
  (await request(`${BASE}/${encodeURIComponent(teamId)}`, z.object({ team: teamSchema }), jsonInit('PUT', input))).team;

export const deleteAgentTeam = async (teamId: string): Promise<void> => {
  await request(`${BASE}/${encodeURIComponent(teamId)}`, z.object({ ok: z.literal(true) }), { method: 'DELETE' });
};

export const fetchTeamRuns = async (): Promise<TeamRun[]> =>
  (await request(`${BASE}/runs`, z.object({ runs: z.array(runSchema) }))).runs;

export const fetchTeamRun = async (runId: string): Promise<TeamRun> =>
  (await request(`${BASE}/runs/${encodeURIComponent(runId)}`, z.object({ run: runSchema }))).run;

export const startTeamRun = async (teamId: string, goal: string, directory: string): Promise<TeamRun> =>
  (await request(`${BASE}/${encodeURIComponent(teamId)}/runs`, z.object({ run: runSchema }), jsonInit('POST', { goal, directory }))).run;

export const cancelTeamRun = async (runId: string): Promise<TeamRun> =>
  (await request(`${BASE}/runs/${encodeURIComponent(runId)}/cancel`, z.object({ run: runSchema }), { method: 'POST' })).run;

export const retryTeamRun = async (runId: string, target: TeamRetryTarget): Promise<TeamRun> =>
  (await request(`${BASE}/runs/${encodeURIComponent(runId)}/retry`, z.object({ run: runSchema }), jsonInit('POST', target))).run;
