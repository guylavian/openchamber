import fs from 'fs';
import os from 'os';
import path from 'path';

const TUNNEL_PROFILES_FILE_NAME = 'tunnel-profiles.json';
const LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME = 'cloudflare-managed-remote-tunnels.json';
const TUNNEL_CLI_STATE_FILE_NAME = 'tunnel-cli-state.json';

function getDataDir(): string {
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim().length > 0) {
    return path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim());
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

function getLogsDir(): string {
  return path.join(getDataDir(), 'logs');
}

function getSettingsFilePath(): string {
  return path.join(getDataDir(), 'settings.json');
}

function readDesktopLocalPortFromSettings(): number | null {
  try {
    const raw = fs.readFileSync(getSettingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed?.desktopLocalPort;
    if (Number.isFinite(value) && value > 0 && value <= 65535) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

function readDesktopLocalClientTokenFromSettings(): string {
  try {
    const raw = fs.readFileSync(getSettingsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed?.desktopLocalClientToken;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  } catch {
    return '';
  }
}

function ensureLogsDir(): void {
  fs.mkdirSync(getLogsDir(), { recursive: true });
}

function getLogFilePath(port: string | number): string {
  return path.join(getLogsDir(), `openchamber-${port}.log`);
}

function getTunnelProfilesFilePath(): string {
  return path.join(getDataDir(), TUNNEL_PROFILES_FILE_NAME);
}

function getLegacyCloudflareManagedRemoteFilePath(): string {
  return path.join(getDataDir(), LEGACY_CLOUDFLARE_MANAGED_REMOTE_FILE_NAME);
}

function getTunnelCliStateFilePath(): string {
  return path.join(getDataDir(), TUNNEL_CLI_STATE_FILE_NAME);
}

function readTunnelCliState(): Record<string, unknown> {
  const filePath = getTunnelCliStateFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function readLastManagedLocalConfigPath(): string {
  const state = readTunnelCliState();
  if (typeof state.lastManagedLocalConfigPath !== 'string') {
    return '';
  }
  return state.lastManagedLocalConfigPath.trim();
}

function writeLastManagedLocalConfigPath(configPath: string): void {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    return;
  }
  const filePath = getTunnelCliStateFilePath();
  const current = readTunnelCliState();
  const next = {
    ...current,
    lastManagedLocalConfigPath: configPath.trim(),
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
}


function getRunDir(): string {
  const dir = path.join(getDataDir(), 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}


export {
  getDataDir,
  readDesktopLocalPortFromSettings,
  readDesktopLocalClientTokenFromSettings,
  ensureLogsDir,
  getLogFilePath,
  getTunnelProfilesFilePath,
  getLegacyCloudflareManagedRemoteFilePath,
  readLastManagedLocalConfigPath,
  writeLastManagedLocalConfigPath,
  getRunDir,
};
