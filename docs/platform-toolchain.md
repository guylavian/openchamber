# Platform Toolchain

The runtimes and compilers OpenChamber is built and shipped with, why each is
pinned the way it is, and how to move them. Read this before changing any
version below.

## Pinned versions

| Tool | Version | Pinned in | Notes |
|---|---|---|---|
| Node.js | 24 LTS, `>=24.11.0` supported, 24.21.0 used | `package.json` `engines.node`, `.nvmrc`, every `setup-node` in `.github/workflows`, the `node` stage of `Dockerfile` | 24.11.0 is the first Node 24 LTS release. Do not move production to a Current (odd or not-yet-LTS) line. |
| Bun | 1.4.2 | `package.json` `packageManager`, `Dockerfile` base image | `setup-bun` reads `packageManager` when no version is given. The root `postinstall` warns when a different Bun runs `bun install`. |
| Electron | 44.4.5 (exact) | `packages/electron/package.json` | Owns Chromium (152.0.7977.130), V8 (15.2) and the Node it embeds (24.21.0). Only stable releases; never alpha, beta or nightly without an explicit decision. |
| TypeScript | 7.0.2 compiler, 6.0 API bridge | every workspace `package.json` that type-checks | See below. |

`scripts/check-toolchain.mjs` (run by `postinstall`) names a Bun or Node that
differs from these pins.

## TypeScript 7 and the TypeScript 6 bridge

TypeScript 7 is the native (Go) compiler. It type-checks and emits exactly as
TypeScript 6.0 does with `stableTypeOrdering` on, 5 to 6 times faster here,
but it ships **no programmatic API** (a new one is planned for 7.1). Tools that
import `typescript` as a library therefore still need 6.0.

Microsoft's recommended arrangement, used in every workspace that type-checks:

```json
"@typescript/native": "npm:typescript@7.0.2",
"typescript": "npm:@typescript/typescript6@6.0.2"
```

- `tsc` is TypeScript 7 (from `@typescript/native`). Every `type-check` and
  `build` script uses it, including the SDK's emit.
- `require('typescript')` is the TypeScript 6.0 API, and `tsc6` is its CLI.

What still needs the 6.0 API, and why:

| Consumer | Why | Removable when |
|---|---|---|
| `typescript-eslint` (and `ts-api-utils`, `@typescript-eslint/*`) | Typed lint rules run the TypeScript program through the JS API. 8.70 supports `>=4.8.4 <6.1.0`. | typescript-eslint supports the TypeScript 7.1 API. |
| `inspect-webkit` (dev tool, via `serve-sim`) | Declares a `typescript ^5` peer; it does not load the compiler at runtime. The peer warning is expected. | `serve-sim` updates it or is removed. |

No repository script imports `typescript`. Anything new that needs to parse or
inspect TypeScript should use `tsc` output, Bun's `Bun.Transpiler`, or the 6.0
API through `require('typescript')`; never pin a second compiler version.

### What moving to TypeScript 7 changed

- `baseUrl` is removed. `paths` are resolved relative to the tsconfig that
  declares them (root, `web`, `ui`, `vscode` webview configs).
- `types` defaults to `[]`. Configs that relied on every `@types/*` package
  being global now list them (`sdk` and `vscode` list `node`).
- Union members and object properties print in a stable order. The SDK's
  emitted JavaScript is identical to TypeScript 5.9's after normalisation; its
  declarations differ only in member order and in naming `z.util.JSONType` for
  `z.core.util.JSONType` (checked to be the same type).
- Two inferences changed with stable ordering and one DOM typing changed in 6.0
  (`WebSocket.send` takes ArrayBuffer-backed views only). The affected code now
  states its types explicitly.

To remove the bridge later: drop the `typescript` alias, keep `tsc` from
TypeScript 7.1+, and confirm `bun run lint` still runs typed rules.

`packages/vscode/webview/tsconfig.json` is an editor-only config (no script
type-checks it); it reported 10 errors under TypeScript 5.9 already and still
does.
