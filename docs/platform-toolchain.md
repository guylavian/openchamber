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
TypeScript 7 exports an `unstable/*` API; nothing here depends on it.

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

## Server build

The server (`packages/web/server`) and CLI (`packages/web/bin`) are written in
JavaScript and TypeScript side by side and shipped as JavaScript only.

```
server/**, bin/**  (.js and .ts, `.js` import specifiers)
        │  bun run build:server  (packages/web/scripts/build-server.mjs)
        ▼
dist-node/server/**, dist-node/bin/**  (portable ESM; runs on Node 24 and Bun)
```

- `bun run build:server` (root or `packages/web`) is the only command that
  produces `dist-node`. It builds the built-in extensions, compiles with
  `tsc -p tsconfig.server.build.json` (TypeScript 7, about 0.3 s), copies the
  files that are not code (hand-written `.d.ts` sidecars, runtime `.json`,
  `.cjs` programs read as text, `server/built-in-extensions`), and fails when a
  source module has no compiled module, when a file is neither code,
  documentation nor a known asset kind, or when TypeScript reaches the output.
  It rebuilds from scratch every time; `dist-node` is not committed.
- `packages/web` `build` and `prepack` run it, so the UI build, `bun pm pack`
  and everything built from them carry a current `dist-node`.
- Import specifiers are `.js` in every source file, TypeScript included.
  Renaming `store.js` to `store.ts` needs no change in any importer: Bun,
  Vitest and `tsc` (NodeNext) all resolve `./store.js` to `store.ts`.
- `tsconfig.server.json` type-checks: TypeScript strictly (`strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), JavaScript not at
  all (`checkJs: false`). `bun run type-check` in `packages/web` runs it.
- Files that need a package-level path (`package.json`, the UI `dist`) resolve
  it from `server/lib/package-root.js`, which finds the package directory by
  name, so the same code works from `server/` and from `dist-node/server/`.
- Development runs the sources directly with Bun (`bun run dev`); the watcher
  restarts on `.js`, `.ts` and `.json` changes. Nothing in production executes
  TypeScript.

## Server artifact gates

Every shipping target runs `dist-node`, never the sources, so these checks run
against the artifact and the packages built from it. "Build" means
`bun run build:server`, which fails the build.

| Gate | Checked by | Runs in |
|---|---|---|
| Every source module has a compiled module | `packages/web/scripts/build-server.mjs` | build |
| Every non-code asset is classified and copied | `build-server.mjs` | build |
| No TypeScript source in `dist-node` | `build-server.mjs` | build |
| Every relative import in `dist-node` exists and none names a `.ts` file (AST scan) | `packages/web/scripts/verify-server-artifact.mjs` | build |
| Every `@openchamber/web/...` import Electron uses resolves through `exports` into `dist-node` | `verify-server-artifact.mjs` | build |
| Packed npm tarball has no TypeScript sources | `scripts/smoke/packed-consumer.mjs` | PR CI |
| Packed package imports under Node 24, Bun and Electron-as-Node | `packed-consumer.mjs` | PR CI |
| CLI `--version`; `serve` answers `/health`, serves the UI, loads the extension registry under Node and Bun | `packed-consumer.mjs` | PR CI |
| Docker image: Node 24, `/health`, OpenCode ready, UI, API requires auth | `scripts/smoke/docker.sh` | PR CI (`docker-smoke` job) |
| Packaged Desktop: server and OpenCode start, preload bridge, no Node globals in the renderer, React mounts, `/health`, UI, extensions, filesystem, node-pty terminal, clean `main.log` | `packages/electron` `bun run smoke:packaged` | desktop release smoke (macOS arm64) |
| Server TypeScript: no `!` or `as T` beyond the frozen migration budget (`scripts/assertion-budget.json`), and no ESLint directive comments | `scripts/check-assertion-budget.mjs` (TypeScript AST and scanner) | `lint`, PR CI |

Locally, after `bun run build` (and `bun run electron:build` for the desktop gate):

```bash
node scripts/smoke/packed-consumer.mjs
docker build -t openchamber:smoke . && scripts/smoke/docker.sh openchamber:smoke
bun run --cwd packages/electron smoke:packaged
```

## Dependencies held back or pending a decision

Upgrades go in focused waves (one dependency or one tight group per commit,
release notes read, focused tests, then the full gates). What is deliberately
not upgraded, and why:

| Dependency | Where | State | Why | Revisit when |
|---|---|---|---|---|
| `node-addon-api` | root, exact `7.1.1` | Held at 7 (8.x is current) | `node-pty` 1.2.0-beta.15 declares `node-addon-api ^7.1.0`, and the Windows native rebuild (`packages/electron/scripts/rebuild-native.mjs`) copies the root copy into `node-pty`, so 8 would break that declared range. | `node-pty` moves to `node-addon-api` 8. |
| `@types/vscode` | `packages/vscode`, `^1.85.0` | Range held at the engine floor (resolves to the latest 1.x) | `vsce` refuses to package when the `@types/vscode` range exceeds `engines.vscode`, and higher typings would admit APIs older supported VS Code lacks. | `engines.vscode` is raised. |

### Adopted later, deliberately

Upgrades keep behaviour; newer defaults that would change code or output are
recorded here and adopted in their own change, with evidence.

| Item | Deferred in | What adopting it takes |
|---|---|---|
| React Compiler lint rules (`eslint-plugin-react-hooks` 7 presets) | ESLint 10 wave | 864 findings in `packages/ui` (refs 445, set-state-in-effect 331, preserve-manual-memoization 55, immutability 21, ...). The config keeps the two v5 rules. |
| `no-useless-assignment`, `preserve-caught-error` (ESLint 10 `eslint:recommended`) | ESLint 10 wave | 46 and 11 findings (ui, web, vscode). Off in `eslint.config.js`. |
| Vite 8 default browser target | Vite 8 wave | `build.target` stays Vite 7's (safari16 ...). Note: the iOS app declares `IPHONEOS_DEPLOYMENT_TARGET = 15.5`, below even that target; aligning the two is a product decision. |
| Oxc JS minifier and Lightning CSS | Vite 8 wave | Lightning CSS rewrites selectors into `:is()` (specificity) and polyfills a dependency's `light-dark()` through CSS `color-scheme`, which this app mostly sets from JS. Needs a visual check before switching `minify`/`cssMinify` from `'esbuild'`. |

Known pre-existing gap: `scripts/oc-dev.mjs` mobile modes start Vite with
`local-dev-mobile-vite.config.mjs`, which is neither tracked nor generated.

`@xenova/transformers` was removed: nothing imported it after the local WASM
speech-to-text was dropped, and it brought `protobufjs` 6, `sharp` 0.32 and
`onnxruntime` 1.14 into the install (the last `bun audit` advisories). If local
speech-to-text returns, start from `@huggingface/transformers`.

`uuid` is overridden to `11.1.1` (root `overrides`): its only consumer is
`xcode` under `@capacitor/cli`, whose latest release still asks for
`uuid ^7.0.3` (GHSA-w5hq-g745-h8pq).
