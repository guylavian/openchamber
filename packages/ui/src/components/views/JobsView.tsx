import React from 'react';
import { create } from 'zustand';

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
import type { CreateForemanMemoryInput, CreateJobInput, ForemanMemory, Job, JobStatus, MemoryScope, MemoryType, Run, RunActivity, RunAttention, RunError, RunStatus, Task, TaskStatus } from '@/lib/foreman/model';
import { MEMORY_TYPES } from '@/lib/foreman/model';
import { runsForTask, tasksForJob } from '@/lib/foreman/model';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useForemanStore } from '@/stores/useForemanStore';
import { useUIStore } from '@/stores/useUIStore';
import { openSessionFromToast } from '@/sync/session-navigation';

/**
 * The Jobs surface: Job → Task → Run, read from and written to the server
 * through `useForemanStore`. Tasks are created by hand; the user starts ready
 * Tasks explicitly, with server-owned dependency and concurrency rules.
 */

/**
 * Which job the surface has open. Kept outside the component: moving the
 * surface to another zone remounts it, and the open job must survive that.
 * View state only; Foreman's data lives in useForemanStore.
 */
const useJobsSelection = create<{ jobId: string | null; select: (jobId: string | null) => void }>()((set) => ({
  jobId: null,
  select: (jobId) => set({ jobId }),
}));

const STATUS_KEY = {
  pending: 'foreman.jobs.status.pending',
  ready: 'foreman.jobs.status.ready',
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

const ERROR_STAGE_KEY = {
  workspace: 'foreman.jobs.error.stage.workspace',
  session: 'foreman.jobs.error.stage.session',
  dispatch: 'foreman.jobs.error.stage.dispatch',
  execution: 'foreman.jobs.error.stage.execution',
} satisfies Record<RunError['stage'], I18nKey>;

const MEMORY_TYPE_KEY = {
  architecture: 'foreman.memory.types.architecture', decision: 'foreman.memory.types.decision', convention: 'foreman.memory.types.convention', important_file: 'foreman.memory.types.importantFile', known_issue: 'foreman.memory.types.knownIssue', fact: 'foreman.memory.types.fact',
} satisfies Record<MemoryType, I18nKey>;

const MemorySection: React.FC<{ jobId: string }> = ({ jobId }) => {
  const { t } = useI18n();
  const memories = useForemanStore((state) => state.memoriesByJobId[jobId] ?? []);
  const status = useForemanStore((state) => state.memoryStatusByJobId[jobId] ?? 'idle');
  const error = useForemanStore((state) => state.memoryErrorByJobId[jobId]);
  const loadMemories = useForemanStore((state) => state.loadMemories);
  const createMemory = useForemanStore((state) => state.createMemory);
  const updateMemory = useForemanStore((state) => state.updateMemory);
  const deleteMemory = useForemanStore((state) => state.deleteMemory);
  const jobs = useForemanStore((state) => state.jobs);
  const directory = jobs.find((job) => job.id === jobId)?.directory;
  const [scope, setScope] = React.useState<MemoryScope>('workspace');
  const [type, setType] = React.useState<MemoryType>('fact');
  const [content, setContent] = React.useState('');
  const [editing, setEditing] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  React.useEffect(() => { void loadMemories(jobId); }, [jobId, loadMemories]);

  const save = async () => {
    const text = content.trim();
    if (!text || (!editing && !directory)) return;
    setBusy(true);
    setActionError(null);
    try {
      if (editing) await updateMemory(editing, { content: text, type });
      else {
        const input: CreateForemanMemoryInput = { scope, type, content: text, tags: [] };
        await createMemory(jobId, input);
      }
      setContent('');
      setEditing(null);
    } catch (cause) {
      setActionError(t('foreman.jobs.error.save', { message: describeError(cause instanceof Error ? cause : String(cause)) }));
    } finally { setBusy(false); }
  };

  const beginEdit = (memory: ForemanMemory) => {
    setEditing(memory.id);
    setContent(memory.content);
    setType(memory.type);
  };

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border/60 bg-surface-elevated p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="typography-ui-label">{t('foreman.memory.heading')}</span>
        <Button variant="ghost" size="xs" onClick={() => void loadMemories(jobId)} disabled={status === 'loading'}>{t('foreman.jobs.actions.retry')}</Button>
      </div>
      {status === 'error' && error ? <p className="typography-micro text-status-error">{error}</p> : null}
      {memories.length === 0 && status !== 'loading' ? <p className="typography-micro text-muted-foreground">{t('foreman.memory.empty')}</p> : null}
      <ul className="flex flex-col gap-2">
        {memories.map((memory) => (
          <li key={memory.id} className="rounded border border-border/50 px-2 py-1.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="typography-micro text-muted-foreground">
                  {t(memory.scope === 'workspace' ? 'foreman.memory.scope.workspace' : 'foreman.memory.scope.job')} · {t(MEMORY_TYPE_KEY[memory.type])} · {t('foreman.memory.source')}: {memory.source}
                </div>
                <p className="typography-meta whitespace-pre-wrap break-words">{memory.content}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="xs" onClick={() => beginEdit(memory)}>{t('foreman.memory.actions.edit')}</Button>
                <Button variant="ghost" size="xs" onClick={() => void deleteMemory(memory.id).catch((cause: Error) => setActionError(describeError(cause)))}>{t('foreman.memory.actions.delete')}</Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 border-t border-border/40 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-7 rounded border border-border bg-background px-2 typography-micro" value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)} disabled={Boolean(editing)} aria-label={t('foreman.memory.heading')}>
            <option value="workspace">{t('foreman.memory.scope.workspace')}</option>
            <option value="job">{t('foreman.memory.scope.job')}</option>
          </select>
          <select className="h-7 rounded border border-border bg-background px-2 typography-micro" value={type} onChange={(event) => setType(event.target.value as MemoryType)} aria-label={t('foreman.memory.type')}>
            {MEMORY_TYPES.map((value) => <option key={value} value={value}>{MEMORY_TYPE_KEY[value]}</option>)}
          </select>
          {scope === 'workspace' ? <span className="typography-micro text-muted-foreground">{t('foreman.memory.scope.workspaceNote')}</span> : <span className="typography-micro text-muted-foreground">{t('foreman.memory.scope.jobNote')}</span>}
        </div>
        <Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={t('foreman.memory.content')} rows={2} />
        {actionError ? <p className="typography-micro text-status-error">{actionError}</p> : null}
        <div className="flex justify-end gap-2">
          {editing ? <Button variant="ghost" size="xs" onClick={() => { setEditing(null); setContent(''); }}>{t('foreman.jobs.dialog.actions.cancel')}</Button> : null}
          <Button variant="outline" size="xs" onClick={() => void save()} disabled={busy || !content.trim() || (!editing && !directory)}>{t(editing ? 'foreman.memory.actions.save' : 'foreman.memory.actions.add')}</Button>
        </div>
      </div>
    </section>
  );
};

const ACTIVITY_LABEL_KEY = {
  run_started: 'foreman.activity.runStarted',
  session_created: 'foreman.activity.sessionCreated',
  status_changed: 'foreman.activity.statusChanged',
  attention_required: 'foreman.activity.attentionRequired',
  attention_resolved: 'foreman.activity.attentionResolved',
  progress: 'foreman.activity.progress',
  validation: 'foreman.activity.validation',
  run_completed: 'foreman.activity.completed',
  run_failed: 'foreman.activity.failed',
  run_cancelled: 'foreman.activity.cancelled',
} satisfies Record<RunActivity['type'], I18nKey>;

const RunActivitySection: React.FC<{ runId: string }> = ({ runId }) => {
  const { t } = useI18n();
  const events = useForemanStore((state) => state.runActivityById[runId] ?? []);
  const status = useForemanStore((state) => state.runActivityStatusById[runId] ?? 'idle');
  const error = useForemanStore((state) => state.runActivityErrorById[runId]);
  const loadRunActivity = useForemanStore((state) => state.loadRunActivity);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (open && (status === 'idle' || status === 'ready')) void loadRunActivity(runId);
  }, [open, status, runId, loadRunActivity]);
  return (
    <div className="pl-5">
      <button className="typography-micro text-muted-foreground hover:text-foreground" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? t('foreman.activity.hide') : t('foreman.activity.show')} ({events.length})
      </button>
      {open ? (
        <div className="mt-1 border-l border-border/60 pl-2">
          {status === 'loading' && events.length === 0 ? <p className="typography-micro text-muted-foreground">{t('foreman.activity.loading')}</p> : null}
          {status === 'error' ? <p className="typography-micro text-status-error">{error}</p> : null}
          {events.length === 0 && status === 'ready' ? <p className="typography-micro text-muted-foreground">{t('foreman.activity.empty')}</p> : null}
          <ol className="flex flex-col gap-1">
            {events.map((event) => (
              <li key={event.id} className="flex gap-2 typography-micro">
                <time className="shrink-0 text-muted-foreground" dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
                <span>{t(ACTIVITY_LABEL_KEY[event.type])}{['progress', 'validation'].includes(event.type) ? ` — ${event.message}` : ''}</span>
              </li>
            ))}
          </ol>
          {status === 'error' || status === 'ready' ? <Button variant="ghost" size="xs" onClick={() => void loadRunActivity(runId)}>{t('foreman.jobs.actions.retry')}</Button> : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Shows the session carrying a run: switches to its directory and brings the
 * conversation forward in whichever zone it is docked. The same path a
 * notification's "Open session" takes.
 */
const openRunSession = (run: Run) => {
  const sessionId = run.execution?.id;
  const directory = run.execution?.directory;
  if (!sessionId || !directory) return;
  openSessionFromToast(sessionId, directory);
  useUIStore.getState().focusMainChat(directory);
};

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
  children?: React.ReactNode;
}

/** One form for both "New job" and "Add task": a title and an optional text. */
const CreateDialog: React.FC<CreateDialogProps> = ({
  open, onOpenChange, titleKey, titleLabelKey, titlePlaceholderKey, detailLabelKey, detailPlaceholderKey, onCreate, children,
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
          {children}
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

interface RunRowProps {
  run: Run;
  number: number;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onRetryRun: (runId: string) => Promise<void>;
}

const RunRow: React.FC<RunRowProps> = ({ run, number, onStart, onStop, onRetryRun }) => {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [stopError, setStopError] = React.useState<string | null>(null);
  const active = run.status === 'running' || run.status === 'waiting_for_user';
  const sessionId = run.execution?.id;
  const sessionDeleted = Boolean(run.execution?.deletedAt);
  const starting = Boolean(run.execution) && !sessionId;
  return (
    <li className="flex flex-col gap-0.5 px-2 py-1">
      <div className="flex items-center gap-2">
        <Icon name="play" className="size-3.5 text-muted-foreground" />
        <span className="typography-meta flex-1 truncate">{t('foreman.jobs.run.label', { number })}</span>
        {run.attention ? (
          <span className="typography-micro text-status-warning" title={run.attention.message}>
            {t(ATTENTION_KEY[run.attention.type])}
          </span>
        ) : null}
        {starting ? <span className="typography-micro text-muted-foreground">{t('foreman.jobs.run.starting')}</span> : null}
        <StatusLabel status={run.status} />
        {sessionDeleted ? (
          <span className="typography-micro text-muted-foreground">{t('foreman.jobs.run.sessionDeleted')}</span>
        ) : null}
        {sessionId && !sessionDeleted ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => openRunSession(run)}
            title={t('foreman.jobs.run.session', { id: sessionId })}
          >
            <Icon name="chat-4" className="size-3.5" />
            {t('foreman.jobs.actions.openSession')}
          </Button>
        ) : null}
        {active && sessionId ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              setStopError(null);
              void onStop()
                .catch((cause: Error) => setStopError(describeError(cause)))
                .finally(() => setStopping(false));
            }}
          >
            {stopping ? t('foreman.jobs.run.stopping') : t('foreman.jobs.actions.stop')}
          </Button>
        ) : null}
        {(run.status === 'failed' || run.status === 'cancelled') && !active ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              if (onRetryRun) {
                onRetryRun(run.id);
              }
            }}
            title={t('foreman.jobs.actions.retry')}
          >
            <Icon name="refresh" className="size-3.5" />
            {t('foreman.jobs.actions.retry')}
          </Button>
        ) : null}
        {run.status === 'queued' && !run.execution ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onStart().finally(() => setBusy(false));
            }}
          >
            {t('foreman.jobs.actions.start')}
          </Button>
        ) : null}
      </div>
      {stopError ? (
        <div className="typography-micro pl-5 text-status-error">{t('foreman.jobs.error.save', { message: stopError })}</div>
      ) : null}
      {run.error ? (
        <div className="typography-micro pl-5 text-status-error" title={run.error.message}>
          {t(ERROR_STAGE_KEY[run.error.stage])}: {run.error.message}
        </div>
      ) : null}
      <RunActivitySection runId={run.id} />
    </li>
  );
};

interface TaskCardProps {
  task: Task;
  runs: Run[];
  tasks: Task[];
  /** Records a new attempt and starts it. */
  onStartRun: () => Promise<void>;
  /** Starts an attempt that was recorded but never started. */
  onStartExisting: (runId: string) => Promise<void>;
  /** Stops an active attempt: its session is interrupted. */
  onStopRun: (runId: string) => Promise<void>;
  /** Retries a failed or cancelled run: creates a new Run. */
  onRetryRun: (runId: string) => Promise<void>;
}

const TaskCard: React.FC<TaskCardProps> = ({ task, runs, tasks, onStartRun, onStartExisting, onStopRun, onRetryRun }) => {
  const { t } = useI18n();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const guarded = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
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
          {task.dependsOn.length > 0 ? (
            <div className="typography-micro text-muted-foreground">{t('foreman.scheduler.dependencies')}: {task.dependsOn.map((id) => tasks.find((entry) => entry.id === id)?.title ?? id).join(', ')}</div>
          ) : null}
          {task.blockedByTaskIds?.length ? (
            <div className="typography-micro text-status-warning-text">{t(task.blockingReason === 'dependency_failed' ? 'foreman.scheduler.dependencyFailed' : 'foreman.scheduler.dependencyIncomplete', { tasks: task.blockedByTaskIds.map((id) => tasks.find((entry) => entry.id === id)?.title ?? id).join(', ') })}</div>
          ) : null}
        </div>
        <StatusLabel status={task.status} />
      </div>
      <div className="border-t border-border/40 px-1 py-1">
        <div className="flex items-center justify-between px-2 py-0.5">
          <span className="typography-micro text-muted-foreground">{t('foreman.jobs.runs.heading')}</span>
          {['ready', 'failed', 'cancelled'].includes(task.status) ? (
            <Button variant="outline" size="xs" onClick={() => void guarded(onStartRun)} disabled={busy}>
              <Icon name="play" className="size-3.5" />
              {t('foreman.jobs.actions.startRun')}
            </Button>
          ) : null}
        </div>
        {error ? <div className="typography-micro text-status-error px-2 pb-1">{error}</div> : null}
        {runs.length === 0 ? (
          <div className="typography-micro text-muted-foreground px-2 pb-1">{t('foreman.jobs.runs.empty')}</div>
) : (
          <ul>
            {runs.map((run, index) => (
              <RunRow
                key={run.id}
                run={run}
                number={index + 1}
                onStart={() => guarded(() => onStartExisting(run.id))}
                onStop={() => onStopRun(run.id)}
                onRetryRun={onRetryRun}
              />
            ))}
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
  const globalConcurrency = useForemanStore((state) => state.globalConcurrency);
  const createTask = useForemanStore((state) => state.createTask);
  const createRun = useForemanStore((state) => state.createRun);
  const startRun = useForemanStore((state) => state.startRun);
  const stopRun = useForemanStore((state) => state.stopRun);
  const retryRun = useForemanStore((state) => state.retryRun);
  const updateJob = useForemanStore((state) => state.updateJob);
  const [adding, setAdding] = React.useState(false);
  const [newTaskDependencies, setNewTaskDependencies] = React.useState<string[]>([]);
  const [parallelBusy, setParallelBusy] = React.useState(false);
  const jobTasks = React.useMemo(() => tasksForJob(tasks, job.id), [tasks, job.id]);
  const runningCount = jobTasks.filter((task) => task.status === 'running' || task.status === 'waiting').length;
  const activeGlobalRuns = tasks.filter((task) => task.status === 'running' || task.status === 'waiting').length;

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
          <MemorySection jobId={job.id} />
          <div className="flex items-center justify-between">
            <span className="typography-ui-label">{t('foreman.jobs.tasks.heading')}</span>
            <div className="flex items-center gap-2">
              <span className="typography-micro text-muted-foreground">{t('foreman.scheduler.runningCount', { active: runningCount, total: job.maxParallelTasks })}</span>
              <span className="typography-micro text-muted-foreground">{t('foreman.scheduler.globalCount', { active: activeGlobalRuns, total: globalConcurrency })}</span>
              <label className="flex items-center gap-1 typography-micro text-muted-foreground">
                {t('foreman.scheduler.parallelLimit')}
                <select className="h-7 rounded border border-border bg-background px-1" value={job.maxParallelTasks} disabled={parallelBusy} onChange={(event) => {
                  const limit = Number(event.target.value);
                  setParallelBusy(true);
                  void updateJob(job.id, { maxParallelTasks: limit }).catch(() => undefined).finally(() => setParallelBusy(false));
                }} aria-label={t('foreman.scheduler.parallelLimit')}>
                  {[1, 2, 3, 4, 5, 6].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
                </select>
              </label>
              <Button variant="outline" size="xs" onClick={() => setAdding(true)}>
                <Icon name="add" className="size-3.5" />
                {t('foreman.jobs.actions.newTask')}
              </Button>
            </div>
          </div>
          {jobTasks.length === 0 ? (
            <p className="typography-meta text-muted-foreground">{t('foreman.jobs.tasks.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {jobTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  tasks={jobTasks}
                  runs={runsForTask(runs, task.id)}
                  onStartRun={async () => {
                    // One id per click: a retried request lands on the same run,
                    // and the server gives one run one session.
                    const run = task.status === 'failed' || task.status === 'cancelled'
                      ? await retryRun(task.id, { requestId: crypto.randomUUID() })
                      : await createRun(task.id, { requestId: crypto.randomUUID() });
                    await startRun(run.id);
                  }}
                  onStartExisting={async (runId) => { await startRun(runId); }}
                  onStopRun={async (runId) => { await stopRun(runId); }}
                  onRetryRun={async (runId) => {
                    const run = runs.find((r) => r.id === runId);
                    if (!run || (run.status !== 'failed' && run.status !== 'cancelled')) return;
                    const nextRun = await retryRun(task.id, { requestId: crypto.randomUUID() });
                    await startRun(nextRun.id);
                  }}
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
          await createTask(job.id, instructions ? { title, instructions, dependsOn: newTaskDependencies } : { title, dependsOn: newTaskDependencies });
          setNewTaskDependencies([]);
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="typography-meta text-muted-foreground">{t('foreman.scheduler.dependencies')}</span>
          <select multiple className="min-h-20 rounded border border-border bg-background px-2 py-1 typography-meta" value={newTaskDependencies} onChange={(event) => setNewTaskDependencies([...event.target.selectedOptions].map((option) => option.value))}>
            {jobTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
        </label>
      </CreateDialog>
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
  const selectedJobId = useJobsSelection((state) => state.jobId);
  const setSelectedJobId = useJobsSelection((state) => state.select);
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
