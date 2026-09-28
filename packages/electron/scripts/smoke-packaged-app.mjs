#!/usr/bin/env node
/**
 * Smoke test for a packaged OpenChamber Desktop build.
 *
 * Launches the packaged app once in an isolated home (the same isolation as
 * `bun run profile:startup`, so the developer's app, settings and logs are
 * never touched) and checks what a user relies on the moment the window opens:
 *
 * - the main process reaches `electron.server.ready` and OpenCode starts;
 * - the preload bridge (`window.__OPENCHAMBER_DESKTOP__`) exists in the renderer
 *   and React mounts the application;
 * - the embedded server answers /health, serves the UI, reads the extension
 *   registry and the filesystem;
 * - a terminal spawns through the rebuilt native PTY module;
 * - main.log holds no module-resolution or native-load error.
 *
 *   node scripts/smoke-packaged-app.mjs [--app <path>] [--timeout-ms <ms>] [--keep-home]
 *
 * Exit code 1 on any failed check.
 */

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

import { CdpClient, reservePort, wait } from "../../../scripts/perf/cdp.mjs"
import { defaultApp, homeLayout, isolatedEnv, listTargets, readStartupMarks, resolveBuild, stopTree } from "../../../scripts/perf/desktop-app.mjs"

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}
const build = resolveBuild(option("--app", defaultApp()), "app")
const timeoutMs = Number(option("--timeout-ms", "60000"))
const keepHome = argv.includes("--keep-home")

const results = []
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`)
}

// Errors that mean the build itself is broken, as opposed to the environment
// (an unsigned build cannot register a login item; the updater finds no feed).
const BROKEN_BUILD = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ERR_REQUIRE|ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|was compiled against a different Node\.js version|Uncaught|unhandledRejection/

const home = mkdtempSync(join(tmpdir(), "openchamber-smoke-desktop-"))
const layout = homeLayout(home)
const project = join(home, "project")
mkdirSync(project, { recursive: true })
mkdirSync(layout.config, { recursive: true })
writeFileSync(layout.settings, JSON.stringify({
  projects: [{ id: "smoke", path: project, addedAt: 1, lastOpenedAt: 1 }],
  activeProjectId: "smoke",
  lastDirectory: project,
}, null, 2))

const cdpPort = await reservePort()
const spawnAt = Date.now()
const child = spawn(build.executable, [`--remote-debugging-port=${cdpPort}`], { env: isolatedEnv(home), stdio: "ignore", detached: true })
child.unref()

let client = null
try {
  console.log(`app: ${build.app}\nhome: ${home}`)

  // Main process: the embedded server and OpenCode come up.
  let marks = {}
  const deadline = spawnAt + timeoutMs
  while (Date.now() < deadline) {
    marks = readStartupMarks(layout.mainLog, spawnAt).marks
    if (marks["electron.server.ready"] && (marks["opencode.bootstrap.ready"] || marks["opencode.bootstrap.error"])) break
    await wait(100)
  }
  const since = (key) => (marks[key] ? `${marks[key] - spawnAt} ms` : "never")
  record("main process starts the server", Boolean(marks["electron.server.ready"]), since("electron.server.ready"))
  record("OpenCode starts", Boolean(marks["opencode.bootstrap.ready"]), since("opencode.bootstrap.ready"))

  // Renderer: preload bridge and a mounted application.
  let probe = null
  while (Date.now() < deadline) {
    if (!client) {
      const page = (await listTargets(cdpPort)).find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl && !entry.url.startsWith("devtools://") && !entry.url.startsWith("data:"))
      if (!page) { await wait(50); continue }
      client = new CdpClient(page.webSocketDebuggerUrl)
      await client.connect()
      await client.send("Runtime.enable")
    }
    try {
      probe = (await client.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `({
          bridge: typeof window.__OPENCHAMBER_DESKTOP__ === 'object' && window.__OPENCHAMBER_DESKTOP__ !== null,
          electron: Boolean(window.__OPENCHAMBER_ELECTRON__),
          // A real Node global carries versions.node; a bundler shim does not.
          nodeGlobals: typeof require === 'function' || typeof globalThis.process?.versions?.node === 'string',
          processShape: typeof globalThis.process === 'undefined' ? 'none' : Object.keys(globalThis.process).slice(0, 8).join(','),
          mounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
        })`,
      })).result?.value ?? null
    } catch {
      probe = null
    }
    if (probe?.mounted) break
    await wait(100)
  }
  record("preload exposes the desktop bridge", probe?.bridge === true && probe?.electron === true)
  record("renderer has no Node globals", probe?.nodeGlobals === false, `process: ${probe?.processShape ?? "?"}`)
  record("application mounts", probe?.mounted === true, marks["electron.renderer.loaded.application"] ? `${marks["electron.renderer.loaded.application"] - spawnAt} ms` : "")

  // Embedded server, found from the address it logged.
  const log = readFileSync(layout.mainLog, "utf8")
  const port = Number(/listening on [^\s:]+:(\d+)/.exec(log)?.[1])
  record("server address is logged", Number.isFinite(port), String(port))
  if (Number.isFinite(port)) {
    const base = `http://127.0.0.1:${port}`
    const request = async (route, init) => {
      const response = await fetch(`${base}${route}`, { ...init, signal: AbortSignal.timeout(10_000) })
      const text = await response.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      return { status: response.status, text, json }
    }
    const health = await request("/health")
    record("/health", health.status === 200 && health.json?.isOpenCodeReady === true, `status ${health.status}, OpenCode ready ${health.json?.isOpenCodeReady}`)
    const ui = await request("/")
    record("serves the UI", ui.status === 200 && /<html/i.test(ui.text), `status ${ui.status}`)
    const guests = await request("/api/guests")
    record("extension registry", guests.status === 200, `status ${guests.status}`)
    const fsHome = await request("/api/fs/home")
    record("filesystem access", fsHome.status === 200, `status ${fsHome.status}`)

    const created = await request("/api/terminal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, cols: 80, rows: 24 }),
    })
    const sessionId = created.json?.sessionId
    const listed = sessionId ? await request(`/api/terminal/sessions?cwd=${encodeURIComponent(project)}`) : null
    // Under Electron's Node the only PTY provider is node-pty (bun-pty needs Bun),
    // so a running session is the rebuilt native module working.
    const session = (listed?.json?.sessions ?? []).find((entry) => entry.sessionId === sessionId)
    record("terminal spawns through the native PTY", created.status === 200 && created.json?.status === "running" && Boolean(session),
      `status ${created.status}, session ${created.json?.status ?? created.text.slice(0, 120)}, listed ${Boolean(session)}`)
    if (sessionId) await request(`/api/terminal/${sessionId}`, { method: "DELETE" })
  }

  const broken = log.split("\n").filter((line) => BROKEN_BUILD.test(line)).slice(0, 5)
  record("main.log has no build errors", broken.length === 0, broken.join(" | ").slice(0, 400))
} catch (error) {
  record("smoke run", false, error?.message ?? String(error))
} finally {
  client?.close()
  await stopTree(child.pid)
  if (!keepHome) rmSync(home, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
