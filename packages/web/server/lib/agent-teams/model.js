/**
 * Agent team definitions: who is on the team and in what order they work.
 *
 * A team is a list of members and a list of stages. A stage names the members
 * that work in it and whether they work side by side (`parallel`) or one after
 * another (`sequential`). Stages always run in order; that is the whole
 * workflow model in V1, so a team run is predictable from its definition.
 */
import { z } from 'zod';

export const MAX_TEAM_AGENTS = 12;
export const MAX_TEAM_STAGES = 12;
export const WORKSPACE_MODES = ['isolated', 'shared'];

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const modelSchema = z.object({
  providerID: z.string().trim().min(1).max(200),
  modelID: z.string().trim().min(1).max(200),
}).strict();

const teamAgentSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(60).default(''),
  instructions: z.string().trim().max(8000).default(''),
  // null inherits the default model, the same as a new session would.
  model: modelSchema.nullable().default(null),
  // An OpenCode agent (`plan`, `build`, a custom one); null uses the default.
  agent: z.string().trim().min(1).max(80).nullable().default(null),
  // Whether this member changes files. Members that edit get their own
  // worktree in isolated mode; members that only read work in the project.
  edits: z.boolean().default(true),
}).strict();

const teamStageSchema = z.object({
  id: z.string().regex(ID),
  agentIds: z.array(z.string().regex(ID)).max(MAX_TEAM_AGENTS),
  mode: z.enum(['parallel', 'sequential']).default('sequential'),
}).strict();

/** What a client may send when creating or replacing a team. */
export const teamInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  workspace: z.enum(WORKSPACE_MODES).default('isolated'),
  agents: z.array(teamAgentSchema).min(1).max(MAX_TEAM_AGENTS),
  // May be empty: every member no stage mentions gets a stage of its own.
  stages: z.array(teamStageSchema).max(MAX_TEAM_STAGES),
}).strict();

export const teamSchema = teamInputSchema.extend({
  id: z.string().regex(ID),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

/**
 * Makes the stage list consistent with the member list, so a team can always
 * be run and shown: references to missing members and repeated members are
 * dropped (first placement wins), empty stages go away, and a member no stage
 * mentions is appended as a stage of its own rather than silently left out.
 */
export const normalizeStages = (agents, stages) => {
  const known = new Set(agents.map((agent) => agent.id));
  const placed = new Set();
  const result = [];
  for (const stage of stages) {
    const agentIds = stage.agentIds.filter((id) => {
      if (!known.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
    if (agentIds.length > 0) result.push({ ...stage, agentIds });
  }
  for (const agent of agents) {
    if (!placed.has(agent.id)) result.push({ id: `stage-${agent.id}`, agentIds: [agent.id], mode: 'sequential' });
  }
  return result;
};

/**
 * Member ids must be unique within a team: stages and run records refer to
 * members by id, so a duplicate would make both of them ambiguous.
 */
const assertUniqueIds = (items, label) => {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new TeamValidationError(`Duplicate ${label} id: ${item.id}`);
    seen.add(item.id);
  }
};

export class TeamValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeamValidationError';
    this.statusCode = 400;
  }
}

/** Parses client input into a clean team body, or throws a 400 with the first problem. */
export const parseTeamInput = (value) => {
  const parsed = teamInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new TeamValidationError(`${where}${issue?.message ?? 'Invalid team'}`);
  }
  const team = parsed.data;
  assertUniqueIds(team.agents, 'member');
  assertUniqueIds(team.stages, 'stage');
  const stages = normalizeStages(team.agents, team.stages);
  if (stages.length > MAX_TEAM_STAGES) throw new TeamValidationError(`A team can have at most ${MAX_TEAM_STAGES} stages`);
  return { ...team, stages };
};

/**
 * Reads a stored team. Returns null for a record that no longer parses, so
 * one damaged team never hides the others.
 */
export const parseStoredTeam = (value) => {
  const parsed = teamSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    assertUniqueIds(parsed.data.agents, 'member');
  } catch {
    return null;
  }
  return { ...parsed.data, stages: normalizeStages(parsed.data.agents, parsed.data.stages) };
};

/** `provider/model` for display and for the session service's `model` input. */
export const modelRef = (model) => (model ? `${model.providerID}/${model.modelID}` : null);
