import type { AgentTeamInput, TeamAgent } from './api';

/** Resolves a message key; the example's names and instructions are translated text. */
type Translate = (key: `agentTeams.example.${'name' | 'planner.name' | 'planner.role' | 'planner.instructions' | 'frontend.name' | 'frontend.role' | 'frontend.instructions' | 'backend.name' | 'backend.role' | 'backend.instructions' | 'reviewer.name' | 'reviewer.role' | 'reviewer.instructions'}`) => string;

type ExampleMember = 'planner' | 'frontend' | 'backend' | 'reviewer';

/**
 * The team a new team starts from: plan, build the front and back ends side
 * by side, then review. Every part of it is editable.
 */
export const createExampleTeam = (t: Translate): AgentTeamInput => {
  const member = (key: ExampleMember, edits: boolean): TeamAgent => ({
    id: crypto.randomUUID(),
    name: t(`agentTeams.example.${key}.name`),
    role: t(`agentTeams.example.${key}.role`),
    instructions: t(`agentTeams.example.${key}.instructions`),
    model: null,
    agent: null,
    edits,
  });
  const planner = member('planner', false);
  const frontend = member('frontend', true);
  const backend = member('backend', true);
  const reviewer = member('reviewer', false);
  return {
    name: t('agentTeams.example.name'),
    workspace: 'isolated',
    agents: [planner, frontend, backend, reviewer],
    stages: [
      { id: crypto.randomUUID(), agentIds: [planner.id], mode: 'sequential' },
      { id: crypto.randomUUID(), agentIds: [frontend.id, backend.id], mode: 'parallel' },
      { id: crypto.randomUUID(), agentIds: [reviewer.id], mode: 'sequential' },
    ],
  };
};
