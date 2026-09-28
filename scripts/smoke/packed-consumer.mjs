#!/usr/bin/env node
/**
 * Packed-consumer smoke test for the published server package.
 *
 * Packs @openchamber/sdk and @openchamber/web exactly as `npm publish` would,
 * installs both tarballs with npm into an empty project, and exercises what a
 * user gets: importing the server module and running `openchamber serve` under
 * Node and under Bun. Nothing here reads the workspace sources, so a package
 * that only works because the repository is next to it fails.
 *
 *   node scripts/smoke/packed-consumer.mjs [--bun <path>] [--electron <path>] [--keep]
 *
 * Node is the one running this script. The import is also run by Electron's
 * own Node (ELECTRON_RUN_AS_NODE), which is what the desktop app loads the
 * server with; the Electron binary defaults to the workspace's. Exit code 1 on
 * any failed check.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const bunBinary = option('--bun', process.env.BUN_BINARY || 'bun');
const keep = argv.includes('--keep');
const resolveWorkspaceElectron = () => {
  try {
    // The electron package's main export is the path of its binary.
    return createRequire(path.join(repoRoot, 'packages/electron/package.json'))('electron');
  } catch {
    return null;
  }
};
const electronBinary = option('--electron', resolveWorkspaceElectron());
const nodeBinary = process.execPath;
const npmBinary = path.join(path.dirname(nodeBinary), process.platform === 'win32' ? 'npm.cmd' : 'npm');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-consumer-'));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// `serve` requires an OpenCode CLI to exist even when it is told not to start
// one; a stub keeps the smoke independent of the machine's installation.
const opencodeStub = path.join(work, 'bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
fs.mkdirSync(path.dirname(opencodeStub), { recursive: true });
fs.writeFileSync(opencodeStub, process.platform === 'win32' ? '@echo 0.0.0-smoke\r\n' : '#!/bin/sh\necho 0.0.0-smoke\n', { mode: 0o755 });

// Isolated state: the server must never touch the user's data while smoke-testing.
const env = {
  OPENCODE_BINARY: opencodeStub,
  ...process.env,
  PATH: `${path.dirname(nodeBinary)}${path.delimiter}${process.env.PATH}`,
  OPENCHAMBER_DATA_DIR: path.join(work, 'data'),
  OPENCHAMBER_SKIP_OPENCODE_START: 'true',
  OPENCHAMBER_RELAY_HOST: 'off',
  XDG_CONFIG_HOME: path.join(work, 'xdg/config'),
  XDG_DATA_HOME: path.join(work, 'xdg/data'),
  XDG_STATE_HOME: path.join(work, 'xdg/state'),
  XDG_CACHE_HOME: path.join(work, 'xdg/cache'),
};

const pack = (workspace, filename) => {
  const target = path.join(work, filename);
  execFileSync(bunBinary, ['pm', 'pack', '--quiet', '--filename', target], {
    cwd: path.join(repoRoot, 'packages', workspace),
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return target;
};

const serve = async (label, runtime, cliPath) => {
  const port = await freePort();
  const child = spawn(runtime, [cliPath, 'serve', '--foreground', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: work,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const get = async (route) => {
    const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text() };
  };
  try {
    const deadline = Date.now() + 45_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        health = await get('/health');
        if (health.status === 200) break;
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    record(`${label}: /health`, health?.status === 200, health ? `status ${health.status}` : `no answer; output tail: ${output.slice(-400)}`);
    if (health?.status !== 200) return;
    const ui = await get('/');
    record(`${label}: serves the UI`, ui.status === 200 && /<html/i.test(ui.body), `status ${ui.status}`);
    const guests = await get('/api/guests');
    record(`${label}: extension registry`, guests.status === 200, `status ${guests.status}`);
    const foreman = await get('/api/foreman/state');
    record(`${label}: Foreman state`, foreman.status === 200 && JSON.parse(foreman.body).version === 2, `status ${foreman.status}`);
  } finally {
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await sleep(500);
  }
};

try {
  console.log(`consumer dir: ${work}`);
  console.log(`node ${process.version}, bun ${execFileSync(bunBinary, ['--version'], { encoding: 'utf8' }).trim()}`);

  const sdkTarball = pack('sdk', 'sdk.tgz');
  const webTarball = pack('web', 'web.tgz');

  const files = execFileSync('tar', ['-tzf', webTarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const typeScriptSources = files.filter((file) => /\.(c|m)?tsx?$/.test(file) && !/\.d\.(c|m)?ts$/.test(file));
  record('package ships no TypeScript sources', typeScriptSources.length === 0, typeScriptSources.slice(0, 5).join(', '));

  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'openchamber-consumer', private: true, type: 'module' }, null, 2));
  execFileSync(npmBinary, ['install', '--no-audit', '--no-fund', '--loglevel=error', sdkTarball, webTarball], {
    cwd: work,
    env,
    timeout: 600_000,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const installed = path.join(work, 'node_modules/@openchamber/web');
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const cliPath = path.join(installed, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.openchamber);

  fs.writeFileSync(path.join(work, 'check-import.mjs'), [
    "import net from 'node:net';",
    "const isBun = typeof Bun !== 'undefined';",
    "const family = net.getDefaultAutoSelectFamily?.();",
    // Node caps each happy-eyeballs attempt at 250 ms; importing the server must raise it (network-defaults).
    "if (!isBun) net.setDefaultAutoSelectFamilyAttemptTimeout(250);",
    "const server = await import('@openchamber/web');",
    "if (typeof server.startWebUiServer !== 'function') throw new Error('startWebUiServer is not exported');",
    "if (!isBun && net.getDefaultAutoSelectFamilyAttemptTimeout() !== 5000) throw new Error('importing the server did not raise the connect attempt timeout');",
    "if (!isBun && net.getDefaultAutoSelectFamily() !== family) throw new Error('importing the server changed family autoselection');",
    "console.log('ok');",
    // Importing the server starts its background work, which keeps the event loop alive.
    'process.exit(0);',
  ].join('\n'));
  for (const [label, runtime, extraEnv] of [['node', nodeBinary, {}], ['bun', bunBinary, {}], ['electron-as-node', electronBinary, { ELECTRON_RUN_AS_NODE: '1' }]]) {
    if (!runtime) {
      record(`${label}: import @openchamber/web`, false, 'no Electron binary (run bun install, or pass --electron <path>)');
      continue;
    }
    try {
      const out = execFileSync(runtime, ['check-import.mjs'], { cwd: work, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      record(`${label}: import @openchamber/web`, out.trim().endsWith('ok'));
    } catch (error) {
      record(`${label}: import @openchamber/web`, false, String(error.stderr || error.message).split('\n').slice(0, 3).join(' | '));
    }
  }

  const version = execFileSync(nodeBinary, [cliPath, '--version'], { cwd: work, env, encoding: 'utf8', timeout: 60_000 }).trim();
  record('node: openchamber --version', version.includes(manifest.version), version);

  await serve('node: openchamber serve', nodeBinary, cliPath);
  await serve('bun: openchamber serve', bunBinary, cliPath);
} catch (error) {
  record('smoke run', false, error?.message || String(error));
} finally {
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
