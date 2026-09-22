import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import type { MemberStatus, TeamRun, TeamRunTimelineEntry } from '@/lib/agent-teams/api';
import { agentName, elapsedMs, formatElapsed, stagesOfRun, summarizeRun, type RunMemberView } from '@/lib/agent-teams/runView';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Props = {
  run: TeamRun;
  /** The current time, so running members show how long they have worked. */
  now: number;
  /** An action on this run is in flight; its buttons are disabled meanwhile. */
  busy: boolean;
  onOpenSession: (sessionId: string, directory: string | null) => void;
  onCancel: () => void;
  onRetryMember: (agentId: string) => void;
  onRetryStage: (stageIndex: number) => void;
};

const STATUS_PRESENTATION = {
  pending: { labelKey: 'agentTeams.status.pending', icon: 'time', className: 'text-muted-foreground' },
  running: { labelKey: 'agentTeams.status.running', icon: 'loader-4', className: 'text-[var(--status-info-text)]' },
  completed: { labelKey: 'agentTeams.status.completed', icon: 'checkbox-circle', className: 'text-[var(--status-success-text)]' },
  failed: { labelKey: 'agentTeams.status.failed', icon: 'close-circle', className: 'text-[var(--status-error-text)]' },
  cancelled: { labelKey: 'agentTeams.status.cancelled', icon: 'subtract', className: 'text-muted-foreground' },
} satisfies Record<MemberStatus, { labelKey: I18nKey; icon: IconName; className: string }>;

export const StatusBadge: React.FC<{ status: MemberStatus }> = ({ status }) => {
  const { t } = useI18n();
  const presentation = STATUS_PRESENTATION[status];
  return (
    <span className={cn('inline-flex items-center gap-1 typography-meta', presentation.className)} data-status={status}>
      <Icon name={presentation.icon} className={cn('size-3.5', status === 'running' && 'animate-spin')} />
      {t(presentation.labelKey)}
    </span>
  );
};

const timelineText = (entry: TeamRunTimelineEntry, run: TeamRun, t: ReturnType<typeof useI18n>['t']): string => {
  const name = agentName(run, entry.memberId) ?? '';
  switch (entry.kind) {
    case 'run-started': return t('agentTeams.timeline.runStarted');
    case 'member-started': return t('agentTeams.timeline.memberStarted', { name });
    case 'member-completed': return t('agentTeams.timeline.memberCompleted', { name });
    case 'member-failed': return t('agentTeams.timeline.memberFailed', { name });
    case 'member-cancelled': return t('agentTeams.timeline.memberCancelled', { name });
    case 'retry-member': return t('agentTeams.timeline.retryMember', { name });
    case 'retry-stage': return t('agentTeams.timeline.retryStage', { stage: entry.message ?? '' });
    case 'run-completed': return t('agentTeams.timeline.runCompleted');
    case 'run-failed': return t('agentTeams.timeline.runFailed');
    case 'run-cancelled': return t('agentTeams.timeline.runCancelled');
    default: return entry.kind;
  }
};

const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * One team run, live: every member with its status, model, workspace and
 * session, grouped by stage; the run's timeline; and, once it ends, a summary
 * above the individual results (never instead of them).
 *
 * Presentational: the run comes in and actions go out, so the same view can
 * sit on the Agent Teams page today and in a workspace surface later.
 */
export const TeamRunView: React.FC<Props> = ({ run, now, busy, onOpenSession, onCancel, onRetryMember, onRetryStage }) => {
  const { t } = useI18n();
  const stages = stagesOfRun(run);
  const isRunning = run.status === 'running';
  const failedNames = run.members
    .filter((member) => member.status === 'failed')
    .map((member) => agentName(run, member.agentId))
    .filter((name): name is string => Boolean(name));

  // A stage can be retried once nothing runs and every stage before it completed.
  const canRetryStage = (stageIndex: number) => !isRunning && !busy
    && run.members.every((member) => member.stageIndex >= stageIndex || member.status === 'completed');

  return (
    <div className="flex flex-col gap-5" data-testid="team-run">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="typography-ui-header font-semibold text-foreground">{run.teamName}</h2>
          <StatusBadge status={run.status} />
          <div className="ml-auto flex items-center gap-2">
            {isRunning ? (
              <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
                <Icon name="stop" className="mr-1 size-3.5" />
                {t('agentTeams.run.cancel')}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="whitespace-pre-wrap typography-markdown text-foreground">{run.goal}</p>
        <p className="typography-meta text-muted-foreground">
          {run.workspace === 'isolated' ? t('agentTeams.run.workspaceIsolated', { directory: run.directory }) : t('agentTeams.run.workspaceShared', { directory: run.directory })}
        </p>
      </header>

      {run.status === 'failed' ? (
        <div role="alert" className="rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-ui-label text-[var(--status-error-text)]">
          {failedNames.length > 0 ? t('agentTeams.run.stoppedAfter', { names: failedNames.join(', ') }) : t('agentTeams.run.stopped')}
        </div>
      ) : null}

      {!isRunning ? <RunSummary run={run} /> : null}

      {stages.map((stage) => (
        <section key={stage.index} className="flex flex-col gap-2" aria-label={t('agentTeams.run.stageLabel', { stage: stage.index + 1 })}>
          <div className="flex items-center gap-2">
            <h3 className="typography-ui-label font-semibold text-foreground">{t('agentTeams.run.stageLabel', { stage: stage.index + 1 })}</h3>
            <span className="typography-meta text-muted-foreground">
              {stage.mode === 'parallel' ? t('agentTeams.stage.parallel') : t('agentTeams.stage.sequential')}
            </span>
            {canRetryStage(stage.index) ? (
              <Button variant="ghost" size="xs" className="ml-auto" onClick={() => onRetryStage(stage.index)}>
                <Icon name="refresh" className="mr-1 size-3.5" />
                {t('agentTeams.run.retryStage')}
              </Button>
            ) : null}
          </div>
          <div className={cn('grid gap-2', stage.mode === 'parallel' && stage.members.length > 1 && 'md:grid-cols-2')}>
            {stage.members.map((entry) => (
              <MemberCard
                key={entry.agent.id}
                entry={entry}
                workspace={run.workspace}
                now={now}
                canRetry={canRetryStage(stage.index)}
                onOpenSession={onOpenSession}
                onRetry={() => onRetryMember(entry.agent.id)}
              />
            ))}
          </div>
        </section>
      ))}

      <section className="flex flex-col gap-2" aria-label={t('agentTeams.timeline.title')}>
        <h3 className="typography-ui-label font-semibold text-foreground">{t('agentTeams.timeline.title')}</h3>
        <ol className="flex flex-col gap-1">
          {run.timeline.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex gap-3 typography-meta">
              <span className="shrink-0 tabular-nums text-muted-foreground">{clockTime(entry.at)}</span>
              <span className="text-foreground">{timelineText(entry, run, t)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
};

const MemberCard: React.FC<{
  entry: RunMemberView;
  workspace: TeamRun['workspace'];
  now: number;
  canRetry: boolean;
  onOpenSession: Props['onOpenSession'];
  onRetry: () => void;
}> = ({ entry, workspace, now, canRetry, onOpenSession, onRetry }) => {
  const { t } = useI18n();
  const { member, agent } = entry;
  const elapsed = elapsedMs(member, now);
  const configuredModel = agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : null;
  const model = member.model ?? configuredModel;
  const sessionId = member.sessionId;

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-[var(--surface-elevated)] p-3" data-member={agent.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="typography-ui-label font-semibold text-foreground">{agent.name}</span>
        {agent.role ? <span className="typography-meta text-muted-foreground">{agent.role}</span> : null}
        <span className="ml-auto"><StatusBadge status={member.status} /></span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 typography-meta">
        <dt className="text-muted-foreground">{t('agentTeams.member.model')}</dt>
        <dd className="min-w-0 truncate text-foreground">{model ?? t('agentTeams.member.defaultModel')}</dd>
        <dt className="text-muted-foreground">{t('agentTeams.member.workspace')}</dt>
        <dd className="min-w-0 truncate text-foreground" title={member.worktree?.path ?? member.directory ?? undefined}>
          {member.worktree
            ? t('agentTeams.member.worktree', { branch: member.worktree.branch ?? member.worktree.path })
            : !agent.edits
              ? t('agentTeams.member.readOnly')
              // Before it starts, an editing member of an isolated team has
              // no worktree yet, but it will get one of its own.
              : workspace === 'isolated' ? t('agentTeams.member.ownWorktree') : t('agentTeams.member.projectDirectory')}
        </dd>
        {elapsed !== null ? (
          <>
            <dt className="text-muted-foreground">{t('agentTeams.member.elapsed')}</dt>
            <dd className="tabular-nums text-foreground">{formatElapsed(elapsed)}</dd>
          </>
        ) : null}
        {member.attempt > 1 ? (
          <>
            <dt className="text-muted-foreground">{t('agentTeams.member.attempt')}</dt>
            <dd className="tabular-nums text-foreground">{member.attempt}</dd>
          </>
        ) : null}
      </dl>

      {member.error ? (
        <p role="alert" className="whitespace-pre-wrap rounded-md bg-[var(--status-error-background)] px-2 py-1 typography-meta text-[var(--status-error-text)]">
          {member.error}
        </p>
      ) : null}

      {member.output ? (
        <details className="group">
          <summary className="cursor-pointer typography-meta text-muted-foreground hover:text-foreground">{t('agentTeams.member.output')}</summary>
          <p className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap typography-meta text-foreground">{member.output}</p>
        </details>
      ) : null}

      {member.changes ? (
        <details>
          <summary className="cursor-pointer typography-meta text-muted-foreground hover:text-foreground">
            {member.changes.diff ? t('agentTeams.member.changes') : t('agentTeams.member.noChanges')}
          </summary>
          {member.changes.diff ? (
            <pre className="oc-surface-code mt-1 max-h-72 overflow-auto rounded-md p-2 typography-code">{member.changes.diff}</pre>
          ) : null}
        </details>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {sessionId ? (
          <Button variant="outline" size="xs" onClick={() => onOpenSession(sessionId, member.directory)}>
            <Icon name="external-link" className="mr-1 size-3.5" />
            {t('agentTeams.member.openSession')}
          </Button>
        ) : null}
        {canRetry && member.status !== 'pending' ? (
          <Button variant="ghost" size="xs" onClick={onRetry}>
            <Icon name="refresh" className="mr-1 size-3.5" />
            {t('agentTeams.member.retry')}
          </Button>
        ) : null}
      </div>
    </article>
  );
};

const RunSummary: React.FC<{ run: TeamRun }> = ({ run }) => {
  const { t } = useI18n();
  const titleKey: I18nKey = run.status === 'completed'
    ? 'agentTeams.summary.completed'
    : run.status === 'cancelled' ? 'agentTeams.summary.cancelled' : 'agentTeams.summary.failed';
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label={t(titleKey)} data-testid="team-run-summary">
      <h3 className="typography-ui-label font-semibold text-foreground">{t(titleKey)}</h3>
      <ul className="flex flex-col gap-1.5">
        {summarizeRun(run).map((row) => (
          <li key={row.agentId} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <StatusBadge status={row.status} />
              <span className="typography-ui-label text-foreground">{row.name}</span>
            </span>
            {row.headline ? <span className="pl-5 typography-meta text-muted-foreground">{row.headline}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
};
