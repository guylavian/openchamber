import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import {
  cancelTeamRun,
  createAgentTeam,
  deleteAgentTeam,
  retryTeamRun,
  startTeamRun,
  updateAgentTeam,
  type AgentTeam,
  type AgentTeamInput,
  type TeamRetryTarget,
  type TeamRun,
} from '@/lib/agent-teams/api';
import { createExampleTeam } from '@/lib/agent-teams/exampleTeam';
import { toTeamInput } from '@/lib/agent-teams/runView';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { AgentTeamEditor } from './AgentTeamEditor';
import { StatusBadge, TeamRunView } from './TeamRunView';
import { useAgentTeams, useNow, useTeamRun } from './useAgentTeams';

type Selection =
  | { kind: 'team'; teamId: string }
  | { kind: 'new' }
  | { kind: 'edit'; teamId: string }
  | { kind: 'run'; runId: string }
  | null;

/** Opens a member's session the way a sidebar click does; that also closes this page. */
const openSession = (sessionId: string, directory: string | null) => {
  useSessionUIStore.getState().setCurrentSession(sessionId, directory);
};

/**
 * Agent Teams: define teams, run one on a task, and watch the run.
 *
 * Owns only page navigation; teams and runs live on the server and every
 * member is an ordinary session. Mounted as a full-page surface today, and
 * self-contained so it can become a workspace surface.
 */
export const AgentTeamsView: React.FC = () => {
  const { t } = useI18n();
  const { teams, runs, reloadTeams, reloadRuns } = useAgentTeams();
  const [selection, setSelection] = React.useState<Selection>(null);

  const teamList = React.useMemo(() => teams.data ?? [], [teams.data]);
  const runList = React.useMemo(() => runs.data ?? [], [runs.data]);

  // Default to the first team once teams load, so the page opens on something.
  React.useEffect(() => {
    if (selection === null && teamList.length > 0) setSelection({ kind: 'team', teamId: teamList[0].id });
  }, [selection, teamList]);

  const selectedTeam = selection && (selection.kind === 'team' || selection.kind === 'edit')
    ? teamList.find((team) => team.id === selection.teamId) ?? null
    : null;

  const saveTeam = async (input: AgentTeamInput) => {
    const team = selection?.kind === 'edit'
      ? await updateAgentTeam(selection.teamId, input)
      : await createAgentTeam(input);
    await reloadTeams();
    setSelection({ kind: 'team', teamId: team.id });
    toast.success(t('agentTeams.toast.saved'));
  };

  const removeTeam = async (team: AgentTeam) => {
    if (!window.confirm(t('agentTeams.team.deleteConfirm', { name: team.name }))) return;
    try {
      await deleteAgentTeam(team.id);
      await reloadTeams();
      setSelection(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const onRunStarted = (run: TeamRun) => {
    void reloadRuns();
    setSelection({ kind: 'run', runId: run.id });
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-surface-elevated" data-testid="agent-teams-page">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-64 flex-shrink-0 flex-col border-r border-border/50" aria-label={t('agentTeams.title')}>
          <div className="flex items-center justify-between px-3 pt-3">
            <h2 className="typography-ui-label font-semibold text-foreground">{t('agentTeams.teams.title')}</h2>
            <Button size="xs" variant="ghost" onClick={() => setSelection({ kind: 'new' })}>
              <Icon name="add" className="mr-1 size-3.5" />
              {t('agentTeams.teams.new')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
            {teams.error && !teams.data ? (
              <p className="px-2 typography-meta text-[var(--status-error-text)]">{teams.error}</p>
            ) : null}
            {teams.data && teamList.length === 0 ? (
              <p className="px-2 py-1 typography-meta text-muted-foreground">{t('agentTeams.teams.empty')}</p>
            ) : null}
            {teamList.map((team) => (
              <ListButton
                key={team.id}
                selected={selectedTeam?.id === team.id}
                onClick={() => setSelection({ kind: 'team', teamId: team.id })}
              >
                <span className="truncate">{team.name}</span>
                <span className="ml-auto shrink-0 typography-micro text-muted-foreground">{team.agents.length}</span>
              </ListButton>
            ))}

            <h2 className="px-2 pt-4 typography-ui-label font-semibold text-foreground">{t('agentTeams.runs.title')}</h2>
            {runs.error && !runs.data ? (
              <p className="px-2 typography-meta text-[var(--status-error-text)]">{runs.error}</p>
            ) : null}
            {runs.data && runList.length === 0 ? (
              <p className="px-2 py-1 typography-meta text-muted-foreground">{t('agentTeams.runs.empty')}</p>
            ) : null}
            {runList.map((run) => (
              <ListButton
                key={run.id}
                selected={selection?.kind === 'run' && selection.runId === run.id}
                onClick={() => setSelection({ kind: 'run', runId: run.id })}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{run.goal}</span>
                  <span className="truncate typography-micro text-muted-foreground">{run.teamName}</span>
                </span>
                <span className="ml-auto shrink-0"><StatusBadge status={run.status} /></span>
              </ListButton>
            ))}
          </div>
        </nav>

        {/* Pages have no close button: you leave by picking a session, a
            draft, or another surface in the sidebar. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="mx-auto w-full max-w-4xl">
            {selection?.kind === 'new' ? (
              <AgentTeamEditor key="new" initial={createExampleTeam(t)} isNew onSave={saveTeam} onCancel={() => setSelection(null)} />
            ) : selection?.kind === 'edit' && selectedTeam ? (
              <AgentTeamEditor key={selectedTeam.id} initial={toTeamInput(selectedTeam)} isNew={false} onSave={saveTeam} onCancel={() => setSelection({ kind: 'team', teamId: selectedTeam.id })} />
            ) : selection?.kind === 'run' ? (
              <RunPanel runId={selection.runId} />
            ) : selectedTeam ? (
              <TeamPanel
                team={selectedTeam}
                runs={runList.filter((run) => run.teamId === selectedTeam.id)}
                onEdit={() => setSelection({ kind: 'edit', teamId: selectedTeam.id })}
                onDelete={() => void removeTeam(selectedTeam)}
                onRunStarted={onRunStarted}
                onOpenRun={(runId) => setSelection({ kind: 'run', runId })}
              />
            ) : (
              <EmptyState onCreate={() => setSelection({ kind: 'new' })} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ListButton: React.FC<{ selected: boolean; onClick: () => void; children: React.ReactNode }> = ({ selected, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={selected || undefined}
    className={cn(
      'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left typography-ui-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selected ? 'bg-interactive-selection text-foreground' : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
    )}
  >
    {children}
  </button>
);

const EmptyState: React.FC<{ onCreate: () => void }> = ({ onCreate }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-3 py-8">
      <Icon name="team" className="size-6 text-muted-foreground" />
      <h2 className="typography-ui-header font-semibold text-foreground">{t('agentTeams.title')}</h2>
      <p className="max-w-xl typography-markdown text-muted-foreground">{t('agentTeams.empty.description')}</p>
      <Button onClick={onCreate}>
        <Icon name="add" className="mr-1 size-4" />
        {t('agentTeams.teams.new')}
      </Button>
    </div>
  );
};

const TeamPanel: React.FC<{
  team: AgentTeam;
  runs: TeamRun[];
  onEdit: () => void;
  onDelete: () => void;
  onRunStarted: (run: TeamRun) => void;
  onOpenRun: (runId: string) => void;
}> = ({ team, runs, onEdit, onDelete, onRunStarted, onOpenRun }) => {
  const { t } = useI18n();
  const directory = useEffectiveDirectory() ?? '';
  const [goal, setGoal] = React.useState('');
  const [starting, setStarting] = React.useState(false);

  const start = async () => {
    setStarting(true);
    try {
      const run = await startTeamRun(team.id, goal, directory);
      setGoal('');
      onRunStarted(run);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  const agentById = new Map(team.agents.map((agent) => [agent.id, agent]));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="typography-ui-header font-semibold text-foreground">{team.name}</h2>
        <span className="typography-meta text-muted-foreground">
          {team.workspace === 'isolated' ? t('agentTeams.editor.workspaceIsolated') : t('agentTeams.editor.workspaceShared')}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Icon name="edit" className="mr-1 size-3.5" />
            {t('agentTeams.team.edit')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Icon name="delete-bin" className="mr-1 size-3.5" />
            {t('agentTeams.team.delete')}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label={t('agentTeams.team.runTitle')}>
        <label htmlFor="agent-team-goal" className="typography-ui-label font-semibold text-foreground">{t('agentTeams.team.runTitle')}</label>
        <Textarea
          id="agent-team-goal"
          value={goal}
          rows={3}
          placeholder={t('agentTeams.team.goalPlaceholder')}
          onChange={(event) => setGoal(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate typography-meta text-muted-foreground">
            {directory ? t('agentTeams.team.runIn', { directory }) : t('agentTeams.team.noProject')}
          </span>
          <Button className="ml-auto" size="sm" disabled={starting || !goal.trim() || !directory} onClick={() => void start()}>
            <Icon name="play" className="mr-1 size-3.5" />
            {t('agentTeams.team.run')}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-label={t('agentTeams.team.members')}>
        <h3 className="typography-ui-label font-semibold text-foreground">{t('agentTeams.team.members')}</h3>
        {team.stages.map((stage, index) => (
          <div key={stage.id} className="flex flex-col gap-1">
            <span className="typography-meta text-muted-foreground">
              {t('agentTeams.run.stageLabel', { stage: index + 1 })} · {stage.mode === 'parallel' ? t('agentTeams.stage.parallel') : t('agentTeams.stage.sequential')}
            </span>
            <div className={cn('grid gap-2', stage.mode === 'parallel' && stage.agentIds.length > 1 && 'md:grid-cols-2')}>
              {stage.agentIds.map((agentId) => {
                const agent = agentById.get(agentId);
                if (!agent) return null;
                return (
                  <div key={agent.id} className="flex flex-col gap-0.5 rounded-md border border-border bg-[var(--surface-elevated)] px-3 py-2">
                    <span className="typography-ui-label font-semibold text-foreground">{agent.name}</span>
                    <span className="typography-meta text-muted-foreground">
                      {agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : t('agentTeams.member.defaultModel')}
                      {' · '}
                      {agent.edits ? t('agentTeams.member.edits') : t('agentTeams.member.readOnly')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {runs.length > 0 ? (
        <section className="flex flex-col gap-1" aria-label={t('agentTeams.runs.title')}>
          <h3 className="typography-ui-label font-semibold text-foreground">{t('agentTeams.runs.title')}</h3>
          {runs.map((run) => (
            <ListButton key={run.id} selected={false} onClick={() => onOpenRun(run.id)}>
              <span className="truncate">{run.goal}</span>
              <span className="ml-auto shrink-0"><StatusBadge status={run.status} /></span>
            </ListButton>
          ))}
        </section>
      ) : null}
    </div>
  );
};

const RunPanel: React.FC<{ runId: string }> = ({ runId }) => {
  const { t } = useI18n();
  const { run, error, setRun } = useTeamRun(runId);
  const [busy, setBusy] = React.useState(false);
  const now = useNow(run?.status === 'running');

  const act = async (action: () => Promise<TeamRun>) => {
    setBusy(true);
    try {
      setRun(await action());
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  };

  if (!run) {
    return error
      ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{error}</p>
      : <p className="typography-meta text-muted-foreground">{t('agentTeams.run.loading')}</p>;
  }

  const retry = (target: TeamRetryTarget) => void act(() => retryTeamRun(run.id, target));

  return (
    <>
      {error ? <p role="alert" className="mb-3 typography-meta text-[var(--status-error-text)]">{error}</p> : null}
      <TeamRunView
        run={run}
        now={now}
        busy={busy}
        onOpenSession={openSession}
        onCancel={() => void act(() => cancelTeamRun(run.id))}
        onRetryMember={(memberId) => retry({ memberId })}
        onRetryStage={(stageIndex) => retry({ stageIndex })}
      />
    </>
  );
};
