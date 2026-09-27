# Foreman

## Purpose

`packages/web/server/lib/foreman` owns Foreman's domain — Job → Task → Run —
and its persistence, and carries a Run out through one OpenCode session.
Foreman is the orchestration layer growing on top of OpenChamber; nothing here
is a new execution path: sessions are made and prompted through OpenChamber's
own session service, and status follows its existing event hub.

## Model

- **Job**: the durable unit of work a person asked for — the outcome. Carries a
  `title`, an optional `goal`, and an optional `directory`, the workspace the
  work happens in, by the same path sessions use. The workspace is referenced,
  never copied.
- **Task**: one piece of a Job (`jobId`).
- **Run**: one attempt at a Task (`taskId`). A Task tried twice has two Runs.
  `execution: { type: 'opencode-session', id, directory, createdAt, deletedAt? }`
  names what carries it out. The Run points at the session; the session knows
  nothing of Foreman, and ordinary sessions are never tracked. No `id` means a
  start is in progress. `deletedAt` records that OpenCode no longer has it.

Statuses are the current state and nothing else:

| Entity | Statuses |
|---|---|
| Job | `pending` `running` `waiting` `completed` `failed` `cancelled` |
| Task | `pending` `running` `blocked` `completed` `failed` `cancelled` |
| Run | `queued` `running` `waiting_for_user` `failed` `completed` `cancelled` |

`Run.attention` (`{ type: permission | question | conflict, message? }`) says
why a person is needed. It exists only while `status` is `waiting_for_user`;
any other status clears it. `Run.error` (`{ stage: workspace | session |
dispatch | execution, message }`) exists only while `failed`, and
`finishedAt` only while finished. That is the rule that keeps "blocked" from
becoming a historical flag. Timestamps are milliseconds; the server sets
`createdAt`/`updatedAt`, and a Run's `startedAt` on its first `running`,
`finishedAt` on its first terminal status.

## Execution (`execution.js`)

`POST /api/foreman/runs/:id/start`, in order:

1. The job's `directory` is validated. Missing or unusable: 400, the run
   stays `queued`, nothing is recorded.
2. Intent is recorded (`execution` without `id`).
3. `sessionService.create({ directory, title })`. Failure: `failed`,
   `error.stage = session`, the reference removed.
4. The session id is saved on the run, before anything else happens.
5. `sessionService.send(id, { prompt })` with the task's instructions (its
   title when it has none). Failure or "not queued": `failed`,
   `error.stage = dispatch`, the reference kept.
6. `running`, unless an event already moved the run further.

Idempotent: concurrent starts of one run join one in-flight start; a run
with a session answers 200 `{ alreadyStarted: true }` and makes nothing; a
run whose start was interrupted before its session was saved is closed as
`failed` rather than given a second session. `POST tasks/:id/runs` accepts a
`requestId`, so a retried create lands once. A run that owns an execution
refuses a hand-written status (409).

Status follows the translated events every server consumer reads
(`event-stream/translate-v2.js`), per session, in order:

| Event | Run |
|---|---|
| `session.status` busy/retry | `running` (never clears a pending permission or question) |
| `permission.asked` / `form.created` | `waiting_for_user` + attention |
| `permission.replied` / `form.settled` | `running`, if that was the attention |
| `session.idle` | `completed` only when `session-activity.js` says no subagent works; unknown stays `running` |
| `session.idle` aborted | `cancelled` |
| `session.error` | `failed`, `error.stage = execution` |
| `session.deleted` | `deletedAt`; an unfinished run `failed` |

A session that runs again after a terminal status (someone continued it)
moves its run back to `running`: status describes the present.

After a restart the server reconciles runs that own a session and have not
finished, reading `/api/session/active` and the session's last turn. It
never creates a session or sends anything; when OpenCode cannot be asked,
nothing changes. The UI re-reads state on `openchamber:foreman-changed`.

## Persistence

One file per OpenChamber data dir, `foreman.json`, `{ version: 2, jobs, tasks,
runs }`, written whole and atomically (temp file, rename) with mutations
serialized. A failed write restores the previous in-memory state.

- No file is the normal empty state; reading never creates it.
- A `version` newer than this build is refused (`unsupported_version`, HTTP
  409) and never rewritten.
- An unreadable file is moved to `foreman.json.corrupt-<time>` and the store
  starts empty; the bytes are the rollback.
- Version 1 files are converted in memory (a bare `sessionId` becomes an
  `execution` reference) and rewritten as version 2 on the next mutation.

## Routes

`routes.js` registers `/api/foreman/*` in `feature-routes-runtime.js`, before
the OpenCode proxy: `GET state`, `POST jobs`, `PATCH jobs/:id`, `POST
jobs/:id/tasks`, `PATCH tasks/:id`, `POST tasks/:id/runs`, `POST
runs/:id/start`, `PATCH runs/:id`. Store errors map to 400 / 404 / 409. The
store and the execution runtime are created once in `server/index.js` and
passed to the routes. Inputs are parsed with zod in the store.

## Runtimes

| Runtime | Behavior |
|---|---|
| Web, Electron, hosted mobile, Capacitor mobile | Served by the OpenChamber server they connect to |
| VS Code | Not served; the Jobs surface is hidden on the rail (`lib/surfaces/registry.ts`) |

## Client

`packages/ui/src/lib/foreman/model.ts` (zod schemas, types), `api.ts`
(`runtimeFetch` client, parses every answer), `stores/useForemanStore.ts`
(cache of the server's answers; reset on runtime switch),
`components/views/JobsView.tsx` (the `jobs` context surface).

## Tests

`store.test.js` (default state, relationships, status rules, restart, failed
write, concurrency, v1 migration, unreadable and newer files),
`execution.test.js` (one session per start, instructions and directory,
duplicate and interrupted starts, each failure stage, status mapping,
subagent pause, ordering, deletion, restart reconciliation), `routes.test.js`; UI:
`lib/foreman/model.test.ts`, `stores/useForemanStore.test.ts`,
`i18n/messages/foreman-panel.i18n.test.ts`,
`components/layout/workspace/jobsSurface.test.ts` (Jobs in the zone model;
layout changes never reach Foreman data).
