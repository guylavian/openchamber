# Agent teams

A user-defined team runs as a fixed list of ordinary sessions. The user names
the members, groups them into stages, and gives the team one task; the server
runs the stages in order and passes each member the output of the members
before it. Members never message each other, delegate, or loop: the order of
work is exactly what the team definition says.

## Ownership

- `model.js` owns the team definition (`teamInputSchema`) and its repair:
  unknown or repeated stage members are dropped, empty stages go away, and a
  member no stage mentions gets a stage of its own.
- `orchestrator.js` owns the run: stage order, parallel and sequential
  members, what each member is handed, failure, cancellation, retry, and the
  run record. It never touches a session; `runMember` is injected.
- `prompts.js` owns the text a member's session starts with.
- `turn-result.js` reads how a member's turn ended from its session records.
- `runtime.js` does one member's work through existing services and persists.
- `store.js` owns `agent-teams.json` and `agent-team-runs.json` in the data dir.
- `routes.js` is a thin JSON adapter under `/api/openchamber/agent-teams`.

## A member's work (`runtime.js`)

1. In an `isolated` team, a member with `edits: true` gets a new worktree
   started from the project's current commit (`getLog`, pinned as the
   worktree's `startRef`), on branch `team/<run>-<member>-<attempt>`. A member
   with `edits: false` works in the project directory. A `shared` team puts
   every member in the project directory; that is an explicit choice made in
   the team editor, because parallel editors then share one checkout.
2. The session is created by `openchamber-sessions` `create`, the same path the
   CLI and the `openchamber` agent tool use: it validates the model and agent,
   creates and waits for the worktree, creates the session, and dispatches the
   prompt. A member that only reads runs with OpenCode's `plan` agent unless
   one was chosen, so read-only is a permission, not a request.
3. The session is tagged `metadata.openchamber.agentTeam` with the run, team,
   member and attempt (best effort).
4. Waiting uses the control service's `waitForTurn`: an idle reading before
   the turn was seen working is not completion. Cancel aborts the wait and
   interrupts the session.
5. The newest records decide the result: an assistant `error` or an `idle`
   whose `outcome` is not `succeeded` fails the member. Otherwise the output is
   the newest assistant text.
6. For a worktree member, its diff against the start commit, including new
   untracked files (`getRangeDiff` with `includeWorkingTree`), is kept for the
   members after it. Nothing is merged; the worktrees and branches stay for
   the user to review and integrate.

## What a member is told

The first message of each member's session is the whole handoff, so it can be
read there: team goal as the user wrote it, the member's role and
instructions, its workspace, and the output (and, for worktree members, the
diff) of every member that completed before it in this run. In a sequential
stage that includes earlier stage-mates; in a parallel stage it does not.
Handed-on output is labelled as information, not instructions. Output is
capped at 12,000 characters and diffs at 20,000, keeping both ends.

## Run lifecycle

- A failed member stops the run after its stage: parallel siblings finish,
  later stages do not start, and the run is `failed` with the member's error.
- Cancel aborts running members (their sessions are interrupted), running
  members become `cancelled`, members that never started stay `pending`.
- Retry is allowed only while nothing runs and only when every earlier stage
  completed. Retrying a member runs that member again in a new session and
  keeps its stage-mates' results; retrying a stage reruns all of its members.
  Either way the later stages run again, because their input changed.
- A run keeps a copy of the team as it was when it started, so editing or
  deleting the team changes neither the record nor a retry.
- A run the previous server process was driving cannot be resumed; on start
  it is marked `failed` and its running members say OpenChamber restarted.
  Their sessions are untouched and may have finished on their own.
- Each member has a two-hour limit; past it the member fails.

## Persistence

Teams are written on every change. Run writes are coalesced (300 ms) and
flushed on shutdown; the newest 20 finished runs and every running run are
kept. A teams file that is not valid JSON blocks team changes with a 503
rather than being overwritten with an empty list. A single record that no
longer parses is skipped on its own.

Clients learn about changes from the OpenChamber event stream:
`openchamber:agent-teams.updated` and `openchamber:agent-team-run.updated`
(`runId`, `teamId`, `status`, `updatedAt`). Events carry no content; clients
re-read the run.

## Runtimes

Web and Electron reach these routes through the OpenChamber server and show
the Agent Teams page. Hosted and Capacitor mobile talk to a server that has
the routes, but the page is not in the mobile navigation in V1. VS Code has no
OpenChamber server: its webview answers these routes with a stable 501, and
the page is not offered there.
