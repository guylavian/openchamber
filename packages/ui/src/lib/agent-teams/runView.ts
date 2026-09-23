import type { AgentTeam, AgentTeamInput, TeamAgent, TeamRun, TeamRunMember, TeamStage } from './api';

/** One member of a run, with the definition it ran from. */
export type RunMemberView = { member: TeamRunMember; agent: TeamAgent };
type RunStageView = { index: number; mode: TeamStage['mode']; members: RunMemberView[] };

/** The run's members grouped by stage, in the order they were defined. */
export const stagesOfRun = (run: TeamRun): RunStageView[] => run.team.stages.map((stage, index) => ({
  index,
  mode: stage.mode,
  members: stage.agentIds.flatMap((agentId) => {
    const member = run.members.find((candidate) => candidate.agentId === agentId && candidate.stageIndex === index);
    const agent = run.team.agents.find((candidate) => candidate.id === agentId);
    return member && agent ? [{ member, agent }] : [];
  }),
}));

export const agentName = (run: TeamRun, agentId: string | null): string | null =>
  (agentId ? run.team.agents.find((agent) => agent.id === agentId)?.name ?? null : null);

/**
 * A one-line headline for a member's final message, shown in the summary next
 * to its full output, never instead of it. Members are asked to end with a
 * short summary, so the line comes from the last paragraph; an opening such as
 * "Here is the plan:" says little.
 */
export const headlineOf = (output: string | null | undefined, limit = 160): string | null => {
  const clean = (candidate: string) => candidate.replace(/\*\*|__/g, '').replace(/^[#>*\-\s]+/, '').trim();
  const paragraphs = (output ?? '').split(/\n\s*\n/).filter((paragraph) => paragraph.split('\n').some((line) => clean(line)));
  const line = (paragraphs.at(-1) ?? '')
    .split('\n')
    .map(clean)
    .find((candidate) => candidate.length > 0);
  if (!line) return null;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

type RunSummaryRow = { agentId: string; name: string; status: TeamRunMember['status']; headline: string | null };

/** One row per member, in stage order, for the summary shown when a run ends. */
export const summarizeRun = (run: TeamRun): RunSummaryRow[] => stagesOfRun(run).flatMap((stage) => stage.members.map(({ member, agent }) => ({
  agentId: agent.id,
  name: agent.name,
  status: member.status,
  headline: member.status === 'completed' ? headlineOf(member.output) : member.error,
})));

/** Milliseconds a member worked, or has been working so far. */
export const elapsedMs = (member: TeamRunMember, now: number): number | null => {
  if (member.startedAt === null) return null;
  return Math.max(0, (member.finishedAt ?? now) - member.startedAt);
};

export const formatElapsed = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** A team's editable parts, for the editor. */
export const toTeamInput = (team: AgentTeam): AgentTeamInput => ({
  name: team.name,
  workspace: team.workspace,
  agents: team.agents,
  stages: team.stages,
});

/**
 * Members that edit and would share one checkout: two or more editing
 * members in a parallel stage of a shared-workspace team. The editor warns
 * about it; it is allowed because shared mode is an explicit choice.
 */
export const sharedParallelEditors = (input: AgentTeamInput): string[][] => {
  if (input.workspace !== 'shared') return [];
  return input.stages
    .filter((stage) => stage.mode === 'parallel')
    .map((stage) => stage.agentIds
      .map((id) => input.agents.find((agent) => agent.id === id))
      .filter((agent): agent is TeamAgent => Boolean(agent?.edits))
      .map((agent) => agent.name))
    .filter((names) => names.length > 1);
};
