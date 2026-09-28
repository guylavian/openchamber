/**
 * Launching a packaged OpenChamber Desktop build in isolation: where the build
 * keeps its executable, the isolated home it runs in, the startup marks it
 * writes, and cleaning up every process it started. Shared by
 * `scripts/profile-startup.mjs` and `packages/electron/scripts/smoke-packaged-app.mjs`.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"

import { wait } from "./cdp.mjs"

const repoRoot = resolve(new URL("../..", import.meta.url).pathname)

export const defaultApp = () => {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  if (process.platform === "darwin") return join(repoRoot, "packages/electron/dist", `mac-${arch}`, "OpenChamber.app")
  if (process.platform === "linux") return join(repoRoot, "packages/electron/dist/linux-unpacked/openchamber")
  return join(repoRoot, "packages/electron/dist/win-unpacked/OpenChamber.exe")
}

// The executable to spawn and the bundled OpenCode CLI, per platform layout.
export const resolveBuild = (appPath, label) => {
  const app = resolve(appPath)
  if (!existsSync(app)) throw new Error(`Packaged app not found: ${app}. Run bun run electron:build or pass --app.`)
  if (process.platform === "darwin") {
    const macos = join(app, "Contents", "MacOS")
    const executable = existsSync(macos) ? readdirSync(macos).map((name) => join(macos, name)).find((candidate) => existsSync(candidate)) : null
    if (!executable) throw new Error(`No executable inside ${app}`)
    return { label, app, executable, opencodeCli: join(app, "Contents", "Resources", "opencode-cli", "opencode") }
  }
  const resources = join(app, "..", "resources")
  return { label, app, executable: app, opencodeCli: join(resources, "opencode-cli", process.platform === "win32" ? "opencode.exe" : "opencode") }
}

// Where the app writes inside the isolated home. Settings follow
// OPENCHAMBER_DATA_DIR and electron-log follows $HOME; the Electron profile
// (single-instance lock, Chromium caches) follows OPENCHAMBER_DESKTOP_USER_DATA_DIR,
// because macOS resolves the home directory from the user record rather than $HOME.
export const homeLayout = (home) => {
  const config = join(home, ".config", "openchamber")
  const logs = process.platform === "darwin"
    ? join(home, "Library", "Logs", "OpenChamber")
    : process.platform === "win32"
      ? join(home, "AppData", "Roaming", "OpenChamber", "logs")
      : join(home, ".config", "OpenChamber", "logs")
  return { home, config, settings: join(config, "settings.json"), userData: join(home, "userData"), mainLog: join(logs, "main.log") }
}

// ELECTRON_RUN_AS_NODE would turn the launched app into a bare Node process
// (an agent host or an Electron-based terminal sets it for its own children).
export const isolatedEnv = (home, extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCHAMBER_|OPENCODE_|ELECTRON_|NODE_OPTIONS$)/.test(key))),
  HOME: home,
  USERPROFILE: home,
  // The login-shell probe runs $SHELL; pin it so the isolated .zshrc applies.
  ...(process.platform === "win32" ? {} : { SHELL: "/bin/zsh" }),
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  OPENCHAMBER_DATA_DIR: join(home, ".config", "openchamber"),
  OPENCHAMBER_DESKTOP_USER_DATA_DIR: join(home, "userData"),
  OPENCHAMBER_STARTUP_PERF: "1",
  ...extra,
})

export const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

// Every `[startup-performance]` entry electron-log wrote since the launch,
// keyed by phase (and document class for the navigation phases), with the
// epoch it was recorded at. electron-log wraps long objects onto continuation
// lines, so entries are split on the next timestamp. The Electron phases carry
// `totalDurationMs` counted from the first line of the app's own code (the
// entry module, or main.mjs's body in builds without one), so
// `at - totalDurationMs` recovers when that code started running.
export const readStartupMarks = (mainLog, since) => {
  if (!existsSync(mainLog)) return { marks: {}, codeStartedAt: undefined }
  const marks = {}
  let codeStartedAt
  for (const entry of readFileSync(mainLog, "utf8").split(/\r?\n(?=\[\d{4}-)/)) {
    if (!entry.includes("[startup-performance]")) continue
    const phase = entry.match(/phase: '([^']+)'/)?.[1]
    const at = Number(entry.match(/\bat: (\d+)/)?.[1])
    if (!phase || !Number.isFinite(at) || at < since) continue
    const documentClass = entry.match(/documentClass: '([^']+)'/)?.[1]
    const key = documentClass ? `${phase}.${documentClass}` : phase
    if (marks[key] === undefined) marks[key] = at
    const total = Number(entry.match(/totalDurationMs: ([\d.]+)/)?.[1])
    if (phase === "electron.app.ready" && Number.isFinite(total)) codeStartedAt = at - total
  }
  return { marks, codeStartedAt }
}

export const listTargets = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`)
    if (!response.ok) return []
    return await response.json()
  } catch {
    return []
  }
}

// Every process under `root`, so a launch can be cleaned up completely: the
// app's own helpers plus the OpenCode it started.
export const processTree = (root) => {
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
  const children = new Map()
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const tree = []
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift()
    tree.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return tree
}

export const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const signal = (pid, name) => {
  try {
    process.kill(pid, name)
  } catch {
  }
}

// Only ever touches processes this script spawned. Ask the app to exit first,
// then force the whole tree so an OpenCode it started does not outlive the run.
export const stopTree = async (root) => {
  if (!root || !isRunning(root)) return
  const tree = processTree(root)
  signal(root, "SIGTERM")
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isRunning(root)) await wait(100)
  for (const pid of tree) if (isRunning(pid)) signal(pid, "SIGKILL")
  await wait(300)
}
