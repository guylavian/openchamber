# Foreman

## Purpose

`packages/web/server/lib/foreman` owns Foreman's domain — Job → Task → Run —
and its persistence. Foreman is the orchestration layer growing on top of
OpenChamber; this module is its first, deliberately small foundation. Nothing
here executes anything: a Run is a recorded attempt, not a process.

## Model

- **Job**: the durable unit of work a person asked for — the outcome. Carries a
  `title`, an optional `goal`, and an optional `directory`, the workspace the
  work happens in, by the same path sessions use. The workspace is referenced,
  never copied.
- **Task**: one piece of a Job (`jobId`).
- **Run**: one attempt at a Task (`taskId`). A Task tried twice has two Runs.
  `sessionId` optionally points at an existing OpenCode session, so live
  execution can be attached later without rewriting sessions.

Statuses are the current state and nothing else:

| Entity | Statuses |
|---|---|
| Job | `pending` `running` `waiting` `completed` `failed` `cancelled` |
| Task | `pending` `running` `blocked` `completed` `failed` `cancelled` |
| Run | `queued` `running` `waiting_for_user` `failed` `completed` `cancelled` |

`Run.attention` (`{ type: permission | question | conflict, message? }`) says
why a person is needed. It exists only while `status` is `waiting_for_user`;
any other status clears it. That is the rule that keeps "blocked" from
becoming a historical flag. Timestamps are milliseconds; the server sets
`createdAt`/`updatedAt`, and a Run's `startedAt` on its first `running`,
`finishedAt` on its first terminal status.

## Persistence

One file per OpenChamber data dir, `foreman.json`, `{ version: 1, jobs, tasks,
runs }`, written whole and atomically (temp file, rename) with mutations
serialized. A failed write restores the previous in-memory state.

- No file is the normal empty state; reading never creates it.
- A `version` newer than this build is refused (`unsupported_version`, HTTP
  409) and never rewritten.
- An unreadable file is moved to `foreman.json.corrupt-<time>` and the store
  starts empty; the bytes are the rollback.
- A migration is added only when an older stored shape must convert; there is
  none yet.

## Routes

`routes.js` registers `/api/foreman/*` in `feature-routes-runtime.js`, before
the OpenCode proxy: `GET state`, `POST jobs`, `PATCH jobs/:id`, `POST
jobs/:id/tasks`, `PATCH tasks/:id`, `POST tasks/:id/runs`, `PATCH runs/:id`.
Store errors map to 400 / 404 / 409. Inputs are parsed with zod in the store.

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
write, concurrency, unreadable and newer files), `routes.test.js`; UI:
`lib/foreman/model.test.ts`, `stores/useForemanStore.test.ts`,
`i18n/messages/foreman-panel.i18n.test.ts`.
