import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Textarea } from '@/components/ui/textarea';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { CreateJobInput, Job, JobStatus, Run, RunAttention, RunStatus, Task, TaskStatus } from '@/lib/foreman/model';
import { runsForTask, tasksForJob } from '@/lib/foreman/model';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useForemanStore } from '@/stores/useForemanStore';

/**
 * The Jobs surface: Job → Task → Run, read from and written to the server
 * through `useForemanStore`. This iteration only proves the hierarchy: jobs
 * and tasks are created by hand, a run is a recorded attempt. Nothing here
 * starts an agent.
 */

const STATUS_KEY = {
  pending: 'foreman.jobs.status.pending',
  queued: 'foreman.jobs.status.queued',
  running: 'foreman.jobs.status.running',
  waiting: 'foreman.jobs.status.waiting',
  waiting_for_user: 'foreman.jobs.status.waitingForUser',
  blocked: 'foreman.jobs.status.blocked',
  completed: 'foreman.jobs.status.completed',
  failed: 'foreman.jobs.status.failed',
  cancelled: 'foreman.jobs.status.cancelled',
} satisfies Record<JobStatus | TaskStatus | RunStatus, I18nKey>;

const ATTENTION_KEY = {
  permission: 'foreman.jobs.attention.permission',
  question: 'foreman.jobs.attention.question',
  conflict: 'foreman.jobs.attention.conflict',
} satisfies Record<RunAttention['type'], I18nKey>;

const statusTone = (status: JobStatus | TaskStatus | RunStatus): string => {
  switch (status) {
    case 'running':
      return 'text-status-info';
    case 'waiting':
    case 'waiting_for_user':
    case 'blocked':
      return 'text-status-warning';
    case 'completed':
      return 'text-status-success';
    case 'failed':
      return 'text-status-error';
    default:
      return 'text-muted-foreground';
  }
};

const StatusLabel: React.FC<{ status: JobStatus | TaskStatus | RunStatus }> = ({ status }) => {
  const { t } = useI18n();
  return <span className={cn('typography-micro font-medium', statusTone(status))}>{t(STATUS_KEY[status])}</span>;
};

const describeError = (error: Error | string): string => (error instanceof Error ? error.message : String(error));

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleKey: I18nKey;
  titleLabelKey: I18nKey;
  titlePlaceholderKey: I18nKey;
  detailLabelKey: I18nKey;
  detailPlaceholderKey: I18nKey;
  onCreate: (title: string, detail: string) => Promise<void>;
}

/** One form for both "New job" and "Add task": a title and an optional text. */
const CreateDialog: React.FC<CreateDialogProps> = ({
  open, onOpenChange, titleKey, titleLabelKey, titlePlaceholderKey, detailLabelKey, detailPlaceholderKey, onCreate,
}) => {
  const { t } = useI18n();
  const [title, setTitle] = React.useState('');
  const [detail, setDetail] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTitle('');
      setDetail('');
      setError(null);
      setSaving(false);
    }
  }, [open]);

  const canSubmit = title.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(title.trim(), detail.trim());
      onOpenChange(false);
    } catch (cause) {
      setError(t('foreman.jobs.error.save', { message: describeError(cause instanceof Error ? cause : String(cause)) }));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
          <DialogDescription className="sr-only">{t(titleKey)}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="typography-meta text-muted-foreground">{t(titleLabelKey)}</span>
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                // Enter creates; the app's global shortcuts otherwise see it first.
                if (event.key !== 'Enter' || isIMECompositionEvent(event)) return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) void submit();
              }}
              placeholder={t(titlePlaceholderKey)}
              disabled={saving}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="typography-meta text-muted-foreground">{t(detailLabelKey)}</span>
            <Textarea
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              placeholder={t(detailPlaceholderKey)}
              rows={3}
              disabled={saving}
            />
          </label>
          <DialogFooter className="mt-1 flex items-center justify-between">
            <span className="typography-micro text-status-error">{error}</span>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                {t('foreman.jobs.dialog.actions.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {t('foreman.jobs.dialog.actions.create')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const RunRow: React.FC<{ run: Run; number: number }> = ({ run, number }) => {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-2 px-2 py-1">
      <Icon name="play" className="size-3.5 text-muted-foreground" />
      <span className="typography-meta flex-1 truncate">{t('foreman.jobs.run.label', { number })}</span>
      {run.sessionId ? (
        <span className="typography-micro text-muted-foreground truncate" title={run.sessionId}>
          {t('foreman.jobs.run.session', { id: run.sessionId.slice(0, 8) })}
        </span>
      ) : null}
      {run.attention ? (
        <span className="typography-micro text-status-warning" title={run.attention.message}>
          {t(ATTENTION_KEY[run.attention.type])}
        </span>
      ) : null}
      <StatusLabel status={run.status} />
    </li>
  );
};

const TaskCard: React.FC<{ task: Task; runs: Run[]; onNewRun: () => Promise<void> }> = ({ task, runs, onNewRun }) => {
  const { t } = useI18n();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const newRun = async () => {
    setBusy(true);
    setError(null);
    try {
      await onNewRun();
    } catch (cause) {
      setError(t('foreman.jobs.error.save', { message: describeError(cause instanceof Error ? cause : String(cause)) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-border/60 bg-background">
      <div className="flex items-start gap-2 px-3 py-2">
        <Icon name="task" className="mt-0.5 size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label truncate">{task.title}</div>
          {task.instructions ? (
            <div className="typography-meta text-muted-foreground whitespace-pre-wrap">{task.instructions}</div>
          ) : null}
        </div>
        <StatusLabel status={task.status} />
      </div>
      <div className="border-t border-border/40 px-1 py-1">
        <div className="flex items-center justify-between px-2 py-0.5">
          <span className="typography-micro text-muted-foreground">{t('foreman.jobs.runs.heading')}</span>
          <Button variant="ghost" size="xs" onClick={() => void newRun()} disabled={busy}>
            <Icon name="add" className="size-3.5" />
            {t('foreman.jobs.actions.newRun')}
          </Button>
        </div>
        {error ? <div className="typography-micro text-status-error px-2 pb-1">{error}</div> : null}
        {runs.length === 0 ? (
          <div className="typography-micro text-muted-foreground px-2 pb-1">{t('foreman.jobs.runs.empty')}</div>
        ) : (
          <ul>
            {runs.map((run, index) => <RunRow key={run.id} run={run} number={index + 1} />)}
          </ul>
        )}
      </div>
    </li>
  );
};

const JobDetail: React.FC<{ job: Job; onBack: () => void }> = ({ job, onBack }) => {
  const { t } = useI18n();
  const tasks = useForemanStore((state) => state.tasks);
  const runs = useForemanStore((state) => state.runs);
  const createTask = useForemanStore((state) => state.createTask);
  const createRun = useForemanStore((state) => state.createRun);
  const [adding, setAdding] = React.useState(false);
  const jobTasks = React.useMemo(() => tasksForJob(tasks, job.id), [tasks, job.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <Button variant="ghost" size="xs" onClick={onBack} aria-label={t('foreman.jobs.actions.back')}>
          <Icon name="arrow-left" className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label truncate">{job.title}</div>
          {job.directory ? (
            <div className="typography-micro text-muted-foreground truncate" title={job.directory}>
              {t('foreman.jobs.workspace.label')}: {job.directory}
            </div>
          ) : null}
        </div>
        <StatusLabel status={job.status} />
      </div>
      <ScrollableOverlay className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {job.goal ? <p className="typography-meta whitespace-pre-wrap text-muted-foreground">{job.goal}</p> : null}
          <div className="flex items-center justify-between">
            <span className="typography-ui-label">{t('foreman.jobs.tasks.heading')}</span>
            <Button variant="outline" size="xs" onClick={() => setAdding(true)}>
              <Icon name="add" className="size-3.5" />
              {t('foreman.jobs.actions.newTask')}
            </Button>
          </div>
          {jobTasks.length === 0 ? (
            <p className="typography-meta text-muted-foreground">{t('foreman.jobs.tasks.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {jobTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  runs={runsForTask(runs, task.id)}
                  onNewRun={async () => { await createRun(task.id); }}
                />
              ))}
            </ul>
          )}
        </div>
      </ScrollableOverlay>
      <CreateDialog
        open={adding}
        onOpenChange={setAdding}
        titleKey="foreman.jobs.dialog.newTask.title"
        titleLabelKey="foreman.jobs.dialog.newTask.titleLabel"
        titlePlaceholderKey="foreman.jobs.dialog.newTask.titlePlaceholder"
        detailLabelKey="foreman.jobs.dialog.newTask.instructionsLabel"
        detailPlaceholderKey="foreman.jobs.dialog.newTask.instructionsPlaceholder"
        onCreate={async (title, instructions) => {
          await createTask(job.id, instructions ? { title, instructions } : { title });
        }}
      />
    </div>
  );
};

export const JobsView: React.FC = () => {
  const { t } = useI18n();
  const loadStatus = useForemanStore((state) => state.loadStatus);
  const loadError = useForemanStore((state) => state.loadError);
  const jobs = useForemanStore((state) => state.jobs);
  const tasks = useForemanStore((state) => state.tasks);
  const load = useForemanStore((state) => state.load);
  const createJob = useForemanStore((state) => state.createJob);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    if (loadStatus === 'idle') void load();
  }, [loadStatus, load]);

  const sortedJobs = React.useMemo(() => [...jobs].sort((a, b) => b.updatedAt - a.updatedAt), [jobs]);
  const selectedJob = selectedJobId ? jobs.find((job) => job.id === selectedJobId) ?? null : null;

  if (selectedJob) {
    return <JobDetail job={selectedJob} onBack={() => setSelectedJobId(null)} />;
  }

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <div className="typography-ui-label flex-1 truncate">{t('contextPanel.mode.jobs')}</div>
        <Button variant="outline" size="xs" onClick={() => setCreating(true)}>
          <Icon name="add" className="size-3.5" />
          {t('foreman.jobs.actions.newJob')}
        </Button>
      </div>
      {loadStatus === 'error' && loadError ? (
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
          <span className="typography-micro flex-1 text-status-error">{t('foreman.jobs.error.load', { message: loadError })}</span>
          <Button variant="ghost" size="xs" onClick={() => void load()}>{t('foreman.jobs.actions.retry')}</Button>
        </div>
      ) : null}
      <ScrollableOverlay className="min-h-0 flex-1">
        {loadStatus === 'ready' && sortedJobs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Icon name="briefcase" className="size-6 text-muted-foreground" />
            <div className="typography-ui-label">{t('foreman.jobs.empty.title')}</div>
            <p className="typography-meta max-w-sm text-muted-foreground">{t('foreman.jobs.empty.description')}</p>
          </div>
        ) : (
          <ul className="flex flex-col p-2">
            {sortedJobs.map((job) => {
              const taskCount = tasksForJob(tasks, job.id).length;
              return (
                <li key={job.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-interactive-hover"
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    <Icon name="briefcase" className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="typography-ui-label block truncate">{job.title}</span>
                      {job.goal ? <span className="typography-micro block truncate text-muted-foreground">{job.goal}</span> : null}
                    </span>
                    <span className="typography-micro text-muted-foreground">{taskCount}</span>
                    <StatusLabel status={job.status} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollableOverlay>
      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        titleKey="foreman.jobs.dialog.newJob.title"
        titleLabelKey="foreman.jobs.dialog.newJob.titleLabel"
        titlePlaceholderKey="foreman.jobs.dialog.newJob.titlePlaceholder"
        detailLabelKey="foreman.jobs.dialog.newJob.goalLabel"
        detailPlaceholderKey="foreman.jobs.dialog.newJob.goalPlaceholder"
        onCreate={async (title, goal) => {
          const input: CreateJobInput = { title };
          if (goal) input.goal = goal;
          const directory = currentDirectory.trim();
          if (directory) input.directory = directory;
          const job = await createJob(input);
          setSelectedJobId(job.id);
        }}
      />
    </div>
  );
};
