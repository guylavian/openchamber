import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Stats } from 'fs';
import {
  getTunnelProfilesFilePath,
  getLegacyCloudflareManagedRemoteFilePath,
} from './cli-paths.js';

interface TunnelProfile {
  id: string;
  name: string;
  provider: string;
  mode: string;
  hostname: string;
  token: string;
  createdAt: number;
  updatedAt: number;
}

interface TunnelProfilesData {
  version: number;
  profiles: TunnelProfile[];
}

interface RawProfilesData {
  version?: unknown;
  profiles?: unknown;
}

interface RawProfileEntry {
  id?: unknown;
  provider?: unknown;
  mode?: unknown;
  name?: unknown;
  hostname?: unknown;
  token?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface PermissionWarnOptions {
  shouldWarn?: boolean | undefined;
}

interface TokenSourceOptions {
  tokenStdin?: boolean | undefined;
  tokenFile?: string | undefined;
  token?: string | undefined;
}

interface TokenHolder {
  token?: unknown;
}

const TUNNEL_PROFILES_VERSION = 1;
const MAX_TOKEN_FILE_BYTES = 8 * 1024;

function normalizeProfileProvider(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeProfileMode(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeProfileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeProfileHostname(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeProfileToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function suggestProfileNameFromHostname(hostname: unknown): string {
  const normalizedHost = normalizeProfileHostname(hostname);
  if (!normalizedHost) return 'prod-main';
  const firstLabel = normalizedHost.split('.')[0] || normalizedHost;
  const sanitized = firstLabel.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || 'prod-main';
}

function maskToken(token: unknown): string {
  if (typeof token !== 'string' || token.length === 0) {
    return '***';
  }
  if (token.length <= 4) {
    return '*'.repeat(token.length);
  }
  return `${'*'.repeat(Math.max(4, token.length - 4))}${token.slice(-4)}`;
}

function readTokenFromFileSafely(tokenFilePath: string): string {
  const absolutePath = path.resolve(tokenFilePath);
  let realPath: string;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch (error) {
    if ((error as { code?: unknown } | null | undefined)?.code === 'ENOENT') {
      throw new Error(`Token file '${absolutePath}' not found.`);
    }
    if ((error as { code?: unknown } | null | undefined)?.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  let stats: Stats;
  try {
    stats = fs.statSync(realPath);
  } catch (error) {
    if ((error as { code?: unknown } | null | undefined)?.code === 'EACCES') {
      throw new Error(`Token file '${absolutePath}' is not readable. Check file permissions.`);
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error(`Token file '${absolutePath}' must be a regular file.`);
  }
  if (stats.size <= 0) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  if (stats.size > MAX_TOKEN_FILE_BYTES) {
    throw new Error(`Token file '${absolutePath}' is too large (max ${MAX_TOKEN_FILE_BYTES} bytes).`);
  }

  const raw = fs.readFileSync(realPath, 'utf8');
  if (raw.includes('\u0000')) {
    throw new Error(`Token file '${absolutePath}' appears to be binary. Use a plain text token file.`);
  }

  const value = raw.trim();
  if (!value) {
    throw new Error(`Token file '${absolutePath}' is empty.`);
  }
  return value;
}

function resolveToken(options: TokenSourceOptions): string | undefined {
  const sources = [
    options.tokenStdin ? 'stdin' : null,
    options.tokenFile ? 'file' : null,
    options.token ? 'flag' : null,
  ].filter(Boolean);

  if (sources.length > 1) {
    throw new Error(`Multiple token sources specified (${sources.join(', ')}). Use only one of --token, --token-file, or --token-stdin.`);
  }

  if (options.tokenStdin) {
    const fd = fs.openSync('/dev/stdin', 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      const value = buf.slice(0, bytesRead).toString('utf8').trim();
      if (!value) {
        throw new Error('No token received from stdin.');
      }
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }

  if (options.tokenFile) {
    return readTokenFromFileSafely(options.tokenFile);
  }

  return typeof options.token === 'string' ? options.token.trim() : undefined;
}

function redactProfileForOutput<T extends TokenHolder>(profile: T | null | undefined, showSecrets = false) {
  if (!profile || typeof profile !== 'object') {
    return profile;
  }
  return {
    ...profile,
    token: showSecrets ? profile.token : maskToken(profile.token),
  };
}

function redactProfilesForOutput<T extends TokenHolder>(profiles: T[], showSecrets = false) {
  if (!Array.isArray(profiles)) {
    return profiles;
  }
  return profiles.map((entry) => redactProfileForOutput(entry, showSecrets));
}

function formatProfileTokenStatus(profile: TokenHolder | null | undefined, showSecrets = false): string {
  const token = typeof profile?.token === 'string' ? profile.token.trim() : '';
  if (!token) {
    return 'token:missing';
  }
  if (showSecrets) {
    return `token:${token}`;
  }
  return 'token:present';
}

function sanitizeTunnelProfilesData(data: RawProfilesData | null | undefined): TunnelProfilesData {
  const parsed = data && typeof data === 'object' ? data : {};
  const list: RawProfileEntry[] = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const seen = new Set<string>();
  const profiles: TunnelProfile[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
    const provider = normalizeProfileProvider(entry.provider);
    const mode = normalizeProfileMode(entry.mode);
    const name = normalizeProfileName(entry.name);
    const hostname = normalizeProfileHostname(entry.hostname);
    const token = normalizeProfileToken(entry.token);
    if (!provider || !mode || !name || !hostname || !token) continue;
    const key = `${provider}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push({
      id,
      name,
      provider,
      mode,
      hostname,
      token,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt as number : Date.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt as number : Date.now(),
    });
  }
  return { version: TUNNEL_PROFILES_VERSION, profiles };
}

function warnIfUnsafeFilePermissions(filePath: string, { shouldWarn = true }: PermissionWarnOptions = {}): void {
  if (process.platform === 'win32') {
    return;
  }
  if (!shouldWarn) {
    return;
  }
  try {
    const stats = fs.statSync(filePath);
    const perms = stats.mode & 0o777;
    if (perms & 0o077) {
      const octal = perms.toString(8).padStart(3, '0');
      console.warn(
        `Warning: Profile file '${filePath}' has permissions ${octal} (should be 600). ` +
        `Other users may be able to read tunnel tokens. Fix with: chmod 600 '${filePath}'`
      );
    }
  } catch {
    // File may not exist yet — not an error
  }
}

function readTunnelProfilesFromDisk(options: PermissionWarnOptions = {}): TunnelProfilesData {
  const filePath = getTunnelProfilesFilePath();
  try {
    warnIfUnsafeFilePermissions(filePath, options);
    const raw = fs.readFileSync(filePath, 'utf8');
    return sanitizeTunnelProfilesData(JSON.parse(raw));
  } catch {
    return { version: TUNNEL_PROFILES_VERSION, profiles: [] };
  }
}

function writeTunnelProfilesToDisk(data: RawProfilesData | null | undefined): void {
  const filePath = getTunnelProfilesFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sanitizeTunnelProfilesData(data), null, 2), { encoding: 'utf8', mode: 0o600 });
}

function writeManagedRemotePairsToDiskFromProfiles(profilesData: RawProfilesData | null | undefined): void {
  const profiles = sanitizeTunnelProfilesData(profilesData).profiles;
  const cloudflareManagedRemote = profiles.filter(
    (entry) => entry.provider === 'cloudflare' && entry.mode === 'managed-remote'
  );

  const tunnels = cloudflareManagedRemote.map((entry) => ({
    id: entry.id,
    name: entry.name,
    hostname: entry.hostname,
    token: entry.token,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
  }));

  const filePath = getLegacyCloudflareManagedRemoteFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, tunnels }, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readLegacyManagedRemoteEntries(): TunnelProfile[] {
  try {
    const raw = fs.readFileSync(getLegacyCloudflareManagedRemoteFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { tunnels?: unknown } | null;
    const tunnels: RawProfileEntry[] = Array.isArray(parsed?.tunnels) ? parsed.tunnels : [];
    return tunnels
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = typeof entry.id === 'string' && entry.id.trim().length > 0 ? entry.id.trim() : crypto.randomUUID();
        const name = normalizeProfileName(entry.name);
        const hostname = normalizeProfileHostname(entry.hostname);
        const token = normalizeProfileToken(entry.token);
        if (!name || !hostname || !token) return null;
        return {
          id,
          name,
          provider: 'cloudflare',
          mode: 'managed-remote',
          hostname,
          token,
          createdAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt as number : Date.now(),
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt as number : Date.now(),
        };
      })
      .filter(Boolean) as TunnelProfile[];
  } catch {
    return [];
  }
}

function makeUniqueProfileName(provider: string, desiredName: unknown, existingProfiles: TunnelProfile[]): string {
  const normalizedDesired = normalizeProfileName(desiredName);
  if (!normalizedDesired) {
    return '';
  }
  const existingNames = new Set(
    existingProfiles
      .filter((entry) => entry.provider === provider)
      .map((entry) => entry.name.toLowerCase())
  );

  if (!existingNames.has(normalizedDesired.toLowerCase())) {
    return normalizedDesired;
  }

  let index = 2;
  while (true) {
    const candidate = `${normalizedDesired}-${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
}

function ensureTunnelProfilesMigrated(options: PermissionWarnOptions = {}): TunnelProfilesData {
  const current = readTunnelProfilesFromDisk(options);
  if (current.profiles.length > 0) {
    return current;
  }

  const legacyEntries = readLegacyManagedRemoteEntries();
  if (legacyEntries.length === 0) {
    return current;
  }

  const migratedProfiles: TunnelProfile[] = [];
  for (const entry of legacyEntries) {
    const name = makeUniqueProfileName(entry.provider, entry.name, migratedProfiles);
    migratedProfiles.push({ ...entry, name });
  }

  const migrated = sanitizeTunnelProfilesData({ version: TUNNEL_PROFILES_VERSION, profiles: migratedProfiles });
  writeTunnelProfilesToDisk(migrated);
  writeManagedRemotePairsToDiskFromProfiles(migrated);
  return migrated;
}

function resolveProfileByName(profiles: TunnelProfile[], profileName: unknown, provider: unknown): { profile: TunnelProfile | null; error: string | null } {
  const normalizedName = normalizeProfileName(profileName).toLowerCase();
  const normalizedProvider = normalizeProfileProvider(provider);
  const matches = profiles.filter((entry) => {
    if (entry.name.toLowerCase() !== normalizedName) return false;
    if (!normalizedProvider) return true;
    return entry.provider === normalizedProvider;
  });

  if (matches.length === 0) {
    return { profile: null, error: `No tunnel profile found for name '${profileName}'. Run 'openchamber tunnel profile list'.` };
  }
  if (matches.length > 1) {
    return { profile: null, error: `Profile name '${profileName}' exists for multiple providers. Use --provider <id>.` };
  }
  return { profile: matches[0]!, error: null };
}


export {
  normalizeProfileProvider,
  normalizeProfileMode,
  normalizeProfileName,
  normalizeProfileHostname,
  normalizeProfileToken,
  suggestProfileNameFromHostname,
  maskToken,
  resolveToken,
  redactProfileForOutput,
  redactProfilesForOutput,
  formatProfileTokenStatus,
  warnIfUnsafeFilePermissions,
  writeTunnelProfilesToDisk,
  writeManagedRemotePairsToDiskFromProfiles,
  ensureTunnelProfilesMigrated,
  resolveProfileByName,
};
