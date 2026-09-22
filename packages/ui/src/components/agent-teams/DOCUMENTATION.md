# Agent Teams UI

The page for defining teams, starting a run, and watching it. Every rule about
how a team runs lives on the server (`packages/web/server/lib/agent-teams`);
this module only shows server state and sends user actions.

## Ownership

- `lib/agent-teams/api.ts` parses every response with zod and is the only code
  that calls the `/api/openchamber/agent-teams` routes.
- `useAgentTeams.ts` keeps teams, the run list and one open run current. It
  re-reads on `agent-teams-updated`, `agent-team-run-updated` and
  `event-stream-ready`. Events carry no content, so there is nothing to merge;
  a failed read keeps what was shown and reports the error.
- `AgentTeamsView.tsx` owns page navigation only (which team, editor or run).
- `AgentTeamEditor.tsx` edits a copy of the team and sends it whole on save.
- `TeamRunView.tsx` is presentational: the run in, actions out.
- `lib/agent-teams/runView.ts` holds the display rules (stage grouping, summary
  headlines, elapsed time, the shared-directory parallel-editor warning).

## Surface

The page is one of the mutually exclusive full-page surfaces
(`useUIStore.isAgentTeamsPageOpen`), opened from the sidebar header and the
command palette, and closed by picking a session like the others. Opening a
member's session goes through `setCurrentSession`, which closes the page.

`AgentTeamsView` and `TeamRunView` take everything they need through hooks and
props and do not depend on where they are mounted, so either can become a
workspace surface later without changes.

Web and Electron offer the page. VS Code does not (its webview answers the
routes with 501), and the mobile layouts have no entry point in V1.
