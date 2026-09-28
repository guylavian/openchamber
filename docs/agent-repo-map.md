# OpenChamber Repository Agent Map

*Persistent repository orientation — do not re-explore from scratch.*

## Monorepo Structure

This is a [Bun](https://bun.sh) monorepo workspace with the following top-level packages:

| Package | Purpose |
|---|---|
| `packages/ui` | Shared React UI, state management, sync, and runtime contracts |
| `packages/web` | Web surfaces, OpenChamber server, CLI, and API routes |
| `packages/sdk` | Guest contract for third-party panels (iframe envelope, `connectHost`) |
| `packages/electron` | Native desktop shell and privileged Electron boundary |
| `packages/vscode` | VS Code extension host, webview, and runtime bridge |
| `packages/mobile` | Capacitor iOS/Android shell; bundles the mobile web surface |
| `packages/extensions` | App-owned SDK extensions and their build registry |
| `packages/docs` | Product documentation (not a Bun workspace) |

Each package has its own `package.json`, `tsconfig.json`, and `DOCUMENTATION.md` where applicable.

---

## Main Entry Points

### UI Entry Points

- `packages/ui/src/main.tsx` — Root React entry point
- `packages/ui/src/App.tsx` — Top-level app component
- `packages/ui/src/apps/MobileApp.tsx` — Full mobile surface
- `packages/ui/src/apps/MobileChangesSurface.tsx` — Changes surface (key feature)
- `packages/ui/src/apps/MobileSessionsSheet.tsx` — Session switcher sheet
- `packages/ui/src/apps/MobileWorkspaceDrawer.tsx` — Workspace drawer
- `packages/ui/src/apps/VSCodeApp.tsx` — VS Code extension surface
- `packages/ui/src/renderMobileApp.tsx` — Mobile app renderer
- `packages/ui/src/renderElectronMiniChatApp.tsx` — Electron mini-chat renderer

### Server Entry Points

- `packages/web/src/main.tsx` — Web app entry (Next/Vite)
- `packages/web/server/index.js` — Primary OpenChamber server (Express-based)
- `packages/web/server/lib/` — Server library modules and route handlers
- `packages/web/bin/` — CLI and dev server scripts

### SDK Entry Point

- `packages/sdk/src/` — Types and guest APIs for third-party panels
- `packages/sdk/API.md` — Full SDK contract reference

---

## Foreman domain

Foreman is integrated into this repository. The server domain and persistence
live in `packages/web/server/lib/foreman/`; the shared UI, API client, model,
and store live in `packages/ui/src/lib/foreman/`,
`packages/ui/src/components/views/JobsView.tsx`, and
`packages/ui/src/stores/useForemanStore.ts`.

`packages/web/server/lib/foreman/DOCUMENTATION.md` is the current architecture
reference. Foreman uses OpenChamber's session service and event stream. Task
dependencies and scheduling live in the Foreman store/scheduler, while Git
worktree creation is isolated in `task-workspaces.js`. The standalone
`/Users/guylavian/Projects/Active/foreman/` checkout is a reference only.

---

## Session / OpenCode Integration

- **Primary integration**: `packages/ui/src/lib/opencode/` — shapes and wrappers around `@opencode/client` (OpenCode 2.x) APIs
- **Runtime APIs**: `RuntimeAPIs`, `runtimeFetch` shared helpers for browser/realtime transport
- **Session bootstrap**: `packages/ui/src/lib/sync/` — session initialization, reconnection, polling, optimistic state
- **Endpoint management**: `packages/ui/src/lib/configSync.ts`, `runtimeEndpointReset.ts` — endpoint reset and configuration sync
- **OpenCode APIs**: `@opencode/client` — all official OpenCode API calls go through this package; wire shapes stay inside `packages/ui/src/lib/opencode/`

---

## Surface Registry / Workspace Zones

| Surface | Package | Key Files |
|---|---|---|
| Web UI | `packages/web` | `packages/web/src/main.tsx`, `packages/web/server/index.js` |
| Desktop (Electron) | `packages/electron` | `packages/electron/README.md` |
| VS Code Extension | `packages/vscode` | `packages/vscode/src/`, `packages/vscode/DOCUMENTATION.md` |
| Mobile (iOS/Android) | `packages/mobile` | `packages/mobile/README.md`, `packages/MobileApp.tsx` |
| Mini-Chat | `packages/ui/src/apps/ElectronMiniChatApp.tsx` | Embedded chat surface |

State is scoped per surface via zone-specific stores (see State Stores section).

---

## State Stores

Centralized state lives in `packages/ui/src/stores/`. Key stores:

| Store | Purpose |
|---|---|
| `globalSessions.ts` | Global session tracking and reconnection |
| `useAgentsStore.ts` | Agent list and active agent tracking |
| `useAgentMemoryStore.ts` | Per-agent memory and context |
| `permissionStore.ts` | Permission grants and trust boundaries |
| `messageQueueStore.ts` | Async message queue for cross-surface sync |
| `contextStore.ts` | Runtime context and configuration |
| `appLinkTrustStore.ts` | App link trust and verification |
| `skillVisibility.ts` | Visibility of project skills per context |

Each store has a corresponding `.test.ts` file. Stores are surface-scoped — e.g., the mobile store subset differs from the web store subset.

---

## Testing Locations

| Package | Test Directory |
|---|---|
| `packages/ui` | `packages/ui/tests/` and `packages/ui/src/stores/*test.ts` |
| `packages/web` | `packages/web/test/` and `packages/web/server/*test.js` |
| `packages/sdk` | `packages/sdk/test/` |
| `packages/electron` | `packages/electron/` |
| `packages/vscode` | `packages/vscode/` |
| Integration | `foreman/Tests/` and `foremon/SESSION-REPORT.md` |

Test infrastructure uses Vitest + tsx for the UI, and Jest/Node for server tests.

---

## Important Conventions

- **Bun workspace**: Root `package.json` declares `workspaces: ["packages/*"]`. Use `bun run` for all scripts.
- **Type-check**: `bun run type-check` (or per-package `bun run --cwd packages/<pkg> type-check`)
- **Lint**: `bun run lint` (or per-package)
- **Monorepo pattern**: Each package is independent; shared types in `packages/sdk/src/`
- **Never modify `../opencode`**: It is a separate repository (enforced in AGENTS.md)
- **Entrypoints are thin**: Place domain logic in focused owning modules; keep bridges thin
- **State authority**: Prefer live channels over persisted history; never let fetch failure masquerade as authoritative empty success
- **Partial results**: Make rollback, cleanup, and stale-data behavior explicit

---

## Architectural Boundaries

| Boundary | Description |
|---|---|
| **UI / Runtime contract** | Shared types in `packages/sdk/`; implementation in `packages/ui/` |
| **Opencode client bridge** | All OpenCode API calls go through `packages/ui/src/lib/opencode/` |
| **Isolated-space boundary** | Trust boundaries for networks, grants, credentials, code transfer (see `isolated-spaces/DESIGN.md`) |
| **Surface scoping** | State and components are scoped per surface (web, desktop, VS Code, mobile) |
| **Server / Client split** | `packages/web/server/` is the API backend; `packages/web/src/` is the frontend |
| **Electron main/preload** | Privileged operations in Electron main; renderer communicates via IPC |

---

## Common Files Agents Need

| File | Purpose |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | Always-on repository rules and routing |
| `packages/*/DOCUMENTATION.md` | Module-specific documentation (preferred over broad searching) |
| `packages/ui/src/stores/DOCUMENTATION.md` | Store-level contracts and invariants |
| `packages/web/src/DOCUMENTATION.md` | Web runtime and API contracts |
| `packages/sdk/DOCUMENTATION.md` | SDK guest contract |
| `packages/electron/README.md` | Electron build and runtime notes |
| `packages/mobile/README.md` | Mobile build and Capacitor notes |
| `package.json` | Scripts source of truth (`bun run <script>`) |
| `tsconfig.json` | Type configuration per package |
| `scripts/` | Tooling and automation scripts |

---

## Maintenance

Update this map when any of the following occur:

- **New package/module** added to the monorepo
- **Major architecture change** (e.g., new runtime, surface, or execution flow)
- **Entry point moved** to a different package or directory
- **New persistent domain** such as Foreman integrated or expanded
- **Changed execution/session flow** (bootstrap, reconnection, optimistic state)

The map is a living document — treat it like code: update it when the repository changes, and never assume it's stale unless you have evidence.

When in doubt, check the nearest `DOCUMENTATION.md` for the module you're working on rather than re-scanning the entire repository.
