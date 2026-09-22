import React from 'react';

import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { AgentTeamInput, TeamAgent, TeamStage } from '@/lib/agent-teams/api';
import { sharedParallelEditors } from '@/lib/agent-teams/runView';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const blankMember = (name: string): TeamAgent => ({ id: crypto.randomUUID(), name, role: '', instructions: '', model: null, agent: null, edits: true });

const move = <T,>(items: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

const FieldLabel: React.FC<{ htmlFor?: string; children: React.ReactNode }> = ({ htmlFor, children }) => (
  <label htmlFor={htmlFor} className="typography-meta font-medium text-foreground">{children}</label>
);

type Props = {
  initial: AgentTeamInput;
  isNew: boolean;
  onSave: (input: AgentTeamInput) => Promise<void>;
  onCancel: () => void;
};

/**
 * Cards and forms for one team: members with their instructions, model and
 * agent, grouped into ordered stages. Deliberately not a graph editor: the
 * only structure is "these stages, in this order".
 */
export const AgentTeamEditor: React.FC<Props> = ({ initial, isNew, onSave, onCancel }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<AgentTeamInput>(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const updateAgent = (agentId: string, patch: Partial<TeamAgent>) => setDraft((previous) => ({
    ...previous,
    agents: previous.agents.map((agent) => (agent.id === agentId ? { ...agent, ...patch } : agent)),
  }));

  const updateStage = (stageId: string, patch: Partial<TeamStage>) => setDraft((previous) => ({
    ...previous,
    stages: previous.stages.map((stage) => (stage.id === stageId ? { ...stage, ...patch } : stage)),
  }));

  const addMember = (stageId: string) => setDraft((previous) => {
    const member = blankMember(t('agentTeams.editor.newMemberName', { number: previous.agents.length + 1 }));
    return {
      ...previous,
      agents: [...previous.agents, member],
      stages: previous.stages.map((stage) => (stage.id === stageId ? { ...stage, agentIds: [...stage.agentIds, member.id] } : stage)),
    };
  });

  const removeMember = (agentId: string) => setDraft((previous) => ({
    ...previous,
    agents: previous.agents.filter((agent) => agent.id !== agentId),
    stages: previous.stages.map((stage) => ({ ...stage, agentIds: stage.agentIds.filter((id) => id !== agentId) })),
  }));

  /** Moves a member to another stage, appending it there. */
  const assignStage = (agentId: string, stageId: string) => setDraft((previous) => ({
    ...previous,
    stages: previous.stages.map((stage) => {
      const without = stage.agentIds.filter((id) => id !== agentId);
      return stage.id === stageId ? { ...stage, agentIds: [...without, agentId] } : { ...stage, agentIds: without };
    }),
  }));

  const moveWithinStage = (stageId: string, agentId: string, delta: number) => setDraft((previous) => ({
    ...previous,
    stages: previous.stages.map((stage) => {
      if (stage.id !== stageId) return stage;
      const index = stage.agentIds.indexOf(agentId);
      return { ...stage, agentIds: move(stage.agentIds, index, index + delta) };
    }),
  }));

  const addStage = () => setDraft((previous) => {
    const member = blankMember(t('agentTeams.editor.newMemberName', { number: previous.agents.length + 1 }));
    return {
      ...previous,
      agents: [...previous.agents, member],
      stages: [...previous.stages, { id: crypto.randomUUID(), agentIds: [member.id], mode: 'sequential' }],
    };
  });

  const removeStage = (stageId: string) => setDraft((previous) => {
    const removed = previous.stages.find((stage) => stage.id === stageId)?.agentIds ?? [];
    return {
      ...previous,
      agents: previous.agents.filter((agent) => !removed.includes(agent.id)),
      stages: previous.stages.filter((stage) => stage.id !== stageId),
    };
  });

  const moveStage = (index: number, delta: number) => setDraft((previous) => ({ ...previous, stages: move(previous.stages, index, index + delta) }));

  const nonEmptyStages = draft.stages.filter((stage) => stage.agentIds.length > 0);
  const problem = !draft.name.trim()
    ? t('agentTeams.editor.error.nameRequired')
    : draft.agents.length === 0
      ? t('agentTeams.editor.error.membersRequired')
      : draft.agents.some((agent) => !agent.name.trim())
        ? t('agentTeams.editor.error.memberNameRequired')
        : null;
  const sharedEditors = sharedParallelEditors(draft);

  const save = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, name: draft.name.trim(), stages: nonEmptyStages });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const agentById = new Map(draft.agents.map((agent) => [agent.id, agent]));

  return (
    <div className="flex flex-col gap-5" data-testid="agent-team-editor">
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor="agent-team-name">{t('agentTeams.editor.name')}</FieldLabel>
        <Input
          id="agent-team-name"
          value={draft.name}
          maxLength={80}
          onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-1">
        <FieldLabel>{t('agentTeams.editor.workspace')}</FieldLabel>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('agentTeams.editor.workspace')}>
          {(['isolated', 'shared'] as const).map((mode) => (
            <Button
              key={mode}
              variant="chip"
              size="sm"
              role="radio"
              aria-checked={draft.workspace === mode}
              aria-pressed={draft.workspace === mode}
              onClick={() => setDraft((previous) => ({ ...previous, workspace: mode }))}
            >
              {mode === 'isolated' ? t('agentTeams.editor.workspaceIsolated') : t('agentTeams.editor.workspaceShared')}
            </Button>
          ))}
        </div>
        <p className="typography-meta text-muted-foreground">
          {draft.workspace === 'isolated' ? t('agentTeams.editor.workspaceIsolatedHint') : t('agentTeams.editor.workspaceSharedHint')}
        </p>
        {sharedEditors.length > 0 ? (
          <p role="alert" className="rounded-md bg-[var(--status-warning-background)] px-2 py-1 typography-meta text-[var(--status-warning-text)]">
            {t('agentTeams.editor.sharedParallelWarning', { names: sharedEditors.map((names) => names.join(', ')).join('; ') })}
          </p>
        ) : null}
      </div>

      {draft.stages.map((stage, stageIndex) => (
        <section key={stage.id} className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label={t('agentTeams.run.stageLabel', { stage: stageIndex + 1 })}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="typography-ui-label font-semibold text-foreground">{t('agentTeams.run.stageLabel', { stage: stageIndex + 1 })}</h3>
            <div className="flex gap-1" role="radiogroup" aria-label={t('agentTeams.editor.stageMode')}>
              {(['sequential', 'parallel'] as const).map((mode) => (
                <Button
                  key={mode}
                  variant="chip"
                  size="xs"
                  role="radio"
                  aria-checked={stage.mode === mode}
                  aria-pressed={stage.mode === mode}
                  onClick={() => updateStage(stage.id, { mode })}
                >
                  {mode === 'parallel' ? t('agentTeams.stage.parallel') : t('agentTeams.stage.sequential')}
                </Button>
              ))}
            </div>
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="icon" aria-label={t('agentTeams.editor.moveStageUp')} disabled={stageIndex === 0} onClick={() => moveStage(stageIndex, -1)}>
                <Icon name="arrow-up" className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t('agentTeams.editor.moveStageDown')} disabled={stageIndex === draft.stages.length - 1} onClick={() => moveStage(stageIndex, 1)}>
                <Icon name="arrow-down" className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t('agentTeams.editor.removeStage')} onClick={() => removeStage(stage.id)}>
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </div>
          </div>

          {stage.agentIds.map((agentId, memberIndex) => {
            const agent = agentById.get(agentId);
            if (!agent) return null;
            return (
              <MemberForm
                key={agent.id}
                agent={agent}
                stages={draft.stages}
                stageId={stage.id}
                canMoveUp={memberIndex > 0}
                canMoveDown={memberIndex < stage.agentIds.length - 1}
                onChange={(patch) => updateAgent(agent.id, patch)}
                onRemove={() => removeMember(agent.id)}
                onAssignStage={(stageId) => assignStage(agent.id, stageId)}
                onMove={(delta) => moveWithinStage(stage.id, agent.id, delta)}
              />
            );
          })}

          <Button variant="outline" size="sm" className="self-start" onClick={() => addMember(stage.id)}>
            <Icon name="add" className="mr-1 size-4" />
            {t('agentTeams.editor.addMember')}
          </Button>
        </section>
      ))}

      <Button variant="outline" size="sm" className="self-start" onClick={addStage}>
        <Icon name="add" className="mr-1 size-4" />
        {t('agentTeams.editor.addStage')}
      </Button>

      {error ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{error}</p> : null}

      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={saving}>
          {isNew ? t('agentTeams.editor.create') : t('agentTeams.editor.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>{t('agentTeams.editor.cancel')}</Button>
      </div>
    </div>
  );
};

const MemberForm: React.FC<{
  agent: TeamAgent;
  stages: TeamStage[];
  stageId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (patch: Partial<TeamAgent>) => void;
  onRemove: () => void;
  onAssignStage: (stageId: string) => void;
  onMove: (delta: number) => void;
}> = ({ agent, stages, stageId, canMoveUp, canMoveDown, onChange, onRemove, onAssignStage, onMove }) => {
  const { t } = useI18n();
  const fieldId = (field: string) => `agent-team-${agent.id}-${field}`;
  return (
    <article className={cn('flex flex-col gap-3 rounded-md bg-[var(--surface-elevated)] p-3')} aria-label={agent.name || t('agentTeams.editor.memberUnnamed')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={fieldId('name')}>{t('agentTeams.editor.memberName')}</FieldLabel>
          <Input id={fieldId('name')} value={agent.name} maxLength={60} onChange={(event) => onChange({ name: event.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={fieldId('role')}>{t('agentTeams.editor.memberRole')}</FieldLabel>
          <Input
            id={fieldId('role')}
            value={agent.role}
            maxLength={60}
            placeholder={t('agentTeams.editor.memberRolePlaceholder')}
            onChange={(event) => onChange({ role: event.target.value })}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor={fieldId('instructions')}>{t('agentTeams.editor.memberInstructions')}</FieldLabel>
        <Textarea
          id={fieldId('instructions')}
          value={agent.instructions}
          rows={3}
          maxLength={8000}
          onChange={(event) => onChange({ instructions: event.target.value })}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel>{t('agentTeams.editor.memberModel')}</FieldLabel>
          <div className="flex items-center gap-1">
            <ModelSelector
              providerId={agent.model?.providerID ?? ''}
              modelId={agent.model?.modelID ?? ''}
              placeholder={t('agentTeams.member.defaultModel')}
              onChange={(providerID, modelID) => onChange({ model: providerID && modelID ? { providerID, modelID } : null })}
            />
            {agent.model ? (
              <Button variant="ghost" size="xs" onClick={() => onChange({ model: null })}>{t('agentTeams.editor.useDefault')}</Button>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel>{t('agentTeams.editor.memberAgent')}</FieldLabel>
          <div className="flex items-center gap-1">
            <AgentSelector
              agentName={agent.agent ?? ''}
              filter={(candidate) => isPrimaryMode(candidate.mode)}
              onChange={(name) => onChange({ agent: name || null })}
            />
            {agent.agent ? (
              <Button variant="ghost" size="xs" onClick={() => onChange({ agent: null })}>{t('agentTeams.editor.useDefault')}</Button>
            ) : null}
          </div>
        </div>
      </div>

      <label className="flex items-start gap-2 typography-meta text-foreground">
        <Checkbox checked={agent.edits} onChange={(edits) => onChange({ edits })} ariaLabel={t('agentTeams.editor.memberEdits')} />
        <span className="flex flex-col">
          <span>{t('agentTeams.editor.memberEdits')}</span>
          <span className="text-muted-foreground">{agent.edits ? t('agentTeams.editor.memberEditsHint') : t('agentTeams.editor.memberReadOnlyHint')}</span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={stageId} onValueChange={(value) => onAssignStage(value)}>
          <SelectTrigger size="sm" className="w-fit" aria-label={t('agentTeams.editor.memberStage')}>
            <SelectValue>{(value) => t('agentTeams.run.stageLabel', { stage: stages.findIndex((stage) => stage.id === value) + 1 })}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {stages.map((stage, index) => (
              <SelectItem key={stage.id} value={stage.id}>{t('agentTeams.run.stageLabel', { stage: index + 1 })}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" aria-label={t('agentTeams.editor.moveMemberUp')} disabled={!canMoveUp} onClick={() => onMove(-1)}>
          <Icon name="arrow-up" className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t('agentTeams.editor.moveMemberDown')} disabled={!canMoveDown} onClick={() => onMove(1)}>
          <Icon name="arrow-down" className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onRemove}>
          <Icon name="delete-bin" className="mr-1 size-4" />
          {t('agentTeams.editor.removeMember')}
        </Button>
      </div>
    </article>
  );
};
