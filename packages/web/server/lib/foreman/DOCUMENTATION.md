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
- **Task**: one piece of a Job (`jobId`) with `dependsOn` Task ids and an optional
  persistent workspace mapping. Dependencies must point to Tasks in the same
  Job and remain acyclic. One active Run per Task is allowed.
- **Run**: one attempt at a Task (`taskId`). A Task tried twice has two Runs.
  `execution: { type: 'opencode-session', id, directory, createdAt, deletedAt? }`
  names what carries it out. The Run points at the session; the session knows
  nothing of Foreman, and ordinary sessions are never tracked. No `id` means a
  start is in progress. `deletedAt` records that OpenCode no longer has it.

Statuses are the current state and nothing else:

| Entity | Statuses |
|---|---|
| Job | `pending` `running` `waiting` `completed` `failed` `cancelled` |
| Task | `pending` `ready` `running` `waiting` `blocked` `completed` `failed` `cancelled` |
| Run | `queued` `running` `waiting_for_user` `failed` `completed` `cancelled` |

`Run.attention` (`{ type: permission | question | conflict, message? }`) says
why a person is needed. It exists only while `status` is `waiting_for_user`;
any other status clears it. `Run.error` (`{ stage: workspace | session |
dispatch | execution, message }`) exists only while `failed`, and
`finishedAt` only while finished. That is the rule that keeps "blocked" from
becoming a historical flag. Timestamps are milliseconds; the server sets
`createdAt`/`updatedAt`, and a Run's `startedAt` on its first `running`,
`finishedAt` on its first terminal status.

Task status is derived from its latest Run and current dependencies. A Task
with no dependencies starts `ready`; incomplete dependencies make it `blocked`
with the dependency ids and a reason. A failed or cancelled dependency keeps
it blocked until a successful retry completes. Old Runs remain unchanged.

The manual scheduler validates readiness and reserves capacity when a user
starts a Run. Each Job defaults to three parallel Tasks (configurable from one
to ten); the Foreman server has a configurable global cap. It never creates Tasks
or Runs automatically. If a Job directory is a Git repository, each Task uses
a persistent Git worktree under the OpenChamber data directory. A retry uses
the same worktree. No branches are merged automatically. For non-Git
directories, the original directory is used and Foreman allows only one Task
at a time for that directory. Explicit Task or Job deletion removes associated
worktrees before deleting Foreman records. Deletion refuses active Runs. A
cleanup error leaves Foreman records in place so deletion can be retried.
Completion and age never trigger cleanup.

The server-wide parallel limit defaults to three. Set
`OPENCHAMBER_FOREMAN_MAX_PARALLEL_TASKS` to an integer from 1 to 32 to change
it. Invalid values fall back to three.
The state response includes the effective limit so the Jobs view reports the
configured value.

## Execution (`execution.ts`)

`POST /api/foreman/runs/:id/start`, in order:

1. The job's `directory` is validated. Missing or unusable: 400, the run
   stays `queued`, nothing is recorded.
2. Intent is recorded (`execution` without `id`).
3. `sessionService.create({ directory, title })`. Failure: `failed`,
   `error.stage = session`, the reference removed.
4. The session id is saved on the run, before anything else happens.
5. `sessionService.send(id, { prompt })` with a Foreman execution instruction
   followed by the task's instructions (its title when it has none). The
   instruction prefers LSP/language-server or other structured
   code-intelligence tools exposed by the selected OpenCode agent/provider. If
   none are available, it asks for task-relevant file search/read, with shell
   reserved for execution, tests, builds, Git and runtime commands. It does not
   claim a tool is available or change tools for ordinary sessions. Failure or
   "not queued": `failed`,
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

One file per OpenChamber data dir, `foreman.json`, `{ version: 5, jobs, tasks,
runs (including per-Run activity), memories }`, written whole and atomically (temp file, rename) with mutations
serialized. A failed write restores the previous in-memory state.

- No file is the normal empty state; reading never creates it.
- A `version` newer than this build is refused (`unsupported_version`, HTTP
  409) and never rewritten.
- An unreadable file is moved to `foreman.json.corrupt-<time>` and the store
  starts empty; the bytes are the rollback.
- Version 1 files are converted in memory (a bare `sessionId` becomes an
  `execution` reference); version 2 files gain an empty memory list. Either is
rewritten as version 5 on the next mutation. Version 3 gains an empty
per-Run activity list; version 4 gains Task dependency/workspace defaults and
the per-Job concurrency default; older versions receive those defaults too. The public Jobs state remains
  version 2 and does not include memory records.

### Memory

Memory records live in this file, independently of Runs and OpenCode sessions.
Workspace memory is shared by Jobs using the same validated workspace path;
Job memory is visible only to its owning Job. Routes validate the Job's current
directory before creating or listing records. A Run retrieves at most eight
matching records using case-insensitive text, tags, and path mentions from its
Job and Task context, scoped to that workspace and Job. No match means no
memory section is sent. Users can update or delete stale records in the Jobs
view. Memory is advisory; prompts tell the agent to check current code.

## Routes

`routes.ts` registers `/api/foreman/*` in `feature-routes-runtime.js`, before
the OpenCode proxy: `GET state`, `POST jobs`, `PATCH jobs/:id`, `POST
jobs/:id/tasks`, `PATCH tasks/:id`, `DELETE tasks/:id`, `DELETE jobs/:id`,
`POST tasks/:id/runs`, `POST
runs/:id/start`, `PATCH runs/:id`, per-Run activity list/create, Job memory
list/create, and memory update/delete.
Store errors map to 400 / 404 / 409. The
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

### Run activity

Activity is stored inside each Run in the same atomic `foreman.json` file.
Execution status changes append waiting, resolution, and terminal summaries;
the start path appends start and session-created events. Curated progress or
validation summaries can be added through the Run activity API. The timeline
is capped at 200 entries per Run and collapses adjacent identical type/message
events. Raw prompts, reasoning, and tool invocations are not recorded. Activity
is separate from workspace and Job memory and is never attached to ordinary
OpenChamber sessions. The public Jobs snapshot stays compact; activity is read
through a Run-scoped endpoint. A `foreman-changed` event refreshes timelines
already opened in the Jobs view.

## Code intelligence

Foreman creates and dispatches through the same OpenChamber session service as
other features. Every prompt dispatch for a Run uses
`POST /api/foreman/runs/:id/start`; that route reaches `taskPrompt` and the
single Foreman `sessionService.send` call. Reconciliation observes existing
sessions and stop interrupts them, so neither dispatches another prompt.

OpenCode v2 has no built-in LSP tool in this integration. The built-in agent
tools include `read`, `glob`, `grep`, and `shell`; configured MCP servers may
also expose provider-specific structured tools. OpenChamber does not query or
guarantee those MCP capabilities for a Foreman Run. The instruction prefers
structured tools if the selected agent exposes them, then targeted file
search/read, then shell for execution, tests, builds, Git, and runtime
commands. Ordinary session prompts are unchanged.

## TypeScript

Every module here is TypeScript (`types.ts`, `store.ts`, `execution-truth.ts`,
`scheduler.ts`, `task-workspaces.ts`, `execution.ts`, `routes.ts`, `graph.ts`),
compiled into `dist-node` by `bun run build:server` like the rest of the server
(see `docs/platform-toolchain.md`). Importers keep `.js` specifiers.

The conversion from JavaScript changed no runtime behaviour. Each module,
stripped of its types by Bun's transpiler, is the JavaScript it replaced; the
only differences are Zod's no-op `.brand()` on id schemas in `store.ts` and the
named `simpleGit` import in `task-workspaces.ts` (the same function). Types
describe the contract the code already had; they add no run-time checks.

- **No `any`.** Lint (typescript-eslint `strictTypeChecked`) rejects explicit
  and implicit `any`, `as any`, `as unknown`, double and angle-bracket
  assertions and `@ts-` directives, and ignores `eslint-disable` comments.
- **Erased assertions mark the tensions.** Where the JavaScript relies on an
  invariant the checker cannot see (state loaded before it is read, an index
  `findOrThrow` found, an object finished field by field, a store query that
  only returns runs with a session), the code says so with `x!` or `x as T`.
  Both are erased, so behaviour stays the JavaScript's, including the error it
  would throw if the invariant broke. These 76 are a frozen migration budget
  (`scripts/assertion-budget.json`), checked by `scripts/check-assertion-budget.mjs`
  as part of `lint`: a new `!` or `as T` anywhere in server TypeScript fails
  unless it is reviewed into the baseline, and the baseline can only shrink.
  New code narrows, parses with a schema, uses a discriminated union, or gives
  the API better types instead.
- **Rules that would change behaviour are off** for server TypeScript:
  no-unnecessary-condition (defensive `?.`, `??` and branches stay),
  restrict-template-expressions, require-await, no-deprecated,
  no-confusing-void-expression and no-useless-default-assignment. See the
  comment in `eslint.config.js`.
- **Identifiers** (`JobId`, `TaskId`, `RunId`, `SessionId`, `MemoryId` in
  `types.ts`) are branded strings, type-only: stored schemas brand them with
  Zod's `.brand()`, new ids and request parameters are branded where they are
  made, and nothing validates them that did not before. Every store, scheduler
  and execution entry point takes the identifier of its own kind. There is no
  agent entity in the Foreman server, so there is no `AgentId`.
- **Unions.** An execution-truth verdict is `blocked | idle | unknown`; an event
  change is one of seven shapes (a status with its qualifier, or a deleted
  session), each declaring the others' fields absent so the code reads them as
  written; `validateDirectoryPath` answers `{ ok: true, directory }` or
  `{ ok: false, error? }`; the error-code-to-status table `satisfies` the full
  code list.
- `types.test.ts` holds type-level regression tests (checked by
  `tsc -p tsconfig.server.json`).
- `packages/web/test/foreman-persistence.test.js` loads every file version and
  drives every mutation path, comparing the bytes written with golden files
  produced by the JavaScript store.

## Tests

`test/foreman-persistence.test.js` (byte-exact golden files for every file version and mutation path), `types.test.ts` (type-level), `store.test.js` (default state, relationships, status rules, restart, failed
write, concurrency, v1/v2/v3/v4 migration, memory scope and persistence, deletion rollback, unreadable and newer files),
`execution.test.js` (one session per start, instructions and directory,
duplicate and interrupted starts, each failure stage, status mapping,
start/session, attention, terminal timeline events, event de-duplication and isolation,
subagent pause, ordering, deletion, restart reconciliation), `routes.test.js`; UI:
`lib/foreman/model.test.ts`, `stores/useForemanStore.test.ts`,
`i18n/messages/foreman-panel.i18n.test.ts`,
`scheduler.test.js` (per-Job/global capacity and configured cap); `task-workspaces.test.js`
(real Git worktree reuse, separation, deletion cleanup and non-Git fallback). Route tests cover
Task/Job cleanup ordering, active Run protection, and state preservation after cleanup errors. Store tests cover
dependency validation, readiness, failure/retry release, and one active Run
per Task. `components/layout/workspace/jobsSurface.test.ts` (Jobs in the zone model;
layout changes never reach Foreman data).
