import type { PlatformPath } from 'node:path';

/** One saved managed-remote tunnel profile. */
export interface ManagedRemoteTunnelEntry {
  id: string;
  name: string;
  hostname: string;
  token: string;
  updatedAt: number;
}

export interface ManagedRemoteTunnelConfig {
  version: number;
  tunnels: ManagedRemoteTunnelEntry[];
}

export interface ManagedRemoteTunnelPreset {
  id: string;
  name: string;
  hostname: string;
}

/** A tunnel entry as read from disk: every field is checked before use. */
interface StoredTunnelEntryJson {
  id?: unknown;
  name?: unknown;
  hostname?: unknown;
  token?: unknown;
  updatedAt?: unknown;
}

type StoredTunnelJson = StoredTunnelEntryJson | string | number | boolean | null;

/** A tunnels file (current or legacy) as parsed; `tunnels` is sanitized before use. */
interface ManagedTunnelsFileJson {
  tunnels?: StoredTunnelJson[] | StoredTunnelJson;
}

export interface ManagedRemoteTunnelTokenInput {
  id: string;
  name: string;
  hostname: string;
  token: string;
}

export interface ManagedTunnelConfigDeps {
  fsPromises: {
    mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
    writeFile: (path: string, data: string, options: { encoding: 'utf8'; mode: number }) => Promise<void>;
    readFile: (path: string, encoding: 'utf8') => Promise<string>;
  };
  path: Pick<PlatformPath, 'dirname'>;
  normalizeManagedRemoteTunnelHostname: (value: unknown) => string | undefined;
  normalizeManagedRemoteTunnelPresets: (value: unknown) => ManagedRemoteTunnelPreset[] | undefined;
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: string;
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: string;
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: number;
  };
}

export const createManagedTunnelConfigRuntime = (deps: ManagedTunnelConfigDeps) => {
  const {
    fsPromises,
    path,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    constants,
  } = deps;

  const {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  } = constants;

  let persistManagedRemoteTunnelConfigLock = Promise.resolve();

  const sanitizeManagedRemoteTunnelConfigEntries = (value: StoredTunnelJson[] | StoredTunnelJson | undefined) => {
    if (!Array.isArray(value)) {
      return [];
    }

    const result: ManagedRemoteTunnelEntry[] = [];
    const seenIds = new Set<string>();
    const seenHostnames = new Set<string>();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
      const token = typeof entry.token === 'string' ? entry.token.trim() : '';
      const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt as number : Date.now();

      if (!id || !name || !hostname || !token) {
        continue;
      }
      if (seenIds.has(id) || seenHostnames.has(hostname)) {
        continue;
      }

      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname, token, updatedAt });
    }

    return result;
  };

  const writeManagedRemoteTunnelConfigToDisk = async (data: ManagedRemoteTunnelConfig) => {
    await fsPromises.mkdir(path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
    try {
      const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(legacyRaw) as ManagedTunnelsFileJson | null;
      const tunnels = sanitizeManagedRemoteTunnelConfigEntries(parsed?.tunnels);
      const migrated = {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels,
      };
      await writeManagedRemoteTunnelConfigToDisk(migrated);
      return migrated;
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }
      console.warn('Failed to migrate legacy named tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const readManagedRemoteTunnelConfigFromDisk = async (): Promise<ManagedRemoteTunnelConfig> => {
    try {
      const raw = await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as ManagedTunnelsFileJson | null;
      if (!parsed || typeof parsed !== 'object') {
        return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels),
      };
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return migrateManagedRemoteTunnelConfigFromLegacyFile();
      }
      console.warn('Failed to read managed remote tunnel config file:', error);
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
  };

  const updateManagedRemoteTunnelConfig = async (mutate: (current: ManagedRemoteTunnelConfig) => ManagedRemoteTunnelConfig | null | undefined) => {
    persistManagedRemoteTunnelConfigLock = persistManagedRemoteTunnelConfigLock.then(async () => {
      const current = await readManagedRemoteTunnelConfigFromDisk();
      const next = mutate({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
      });

      await writeManagedRemoteTunnelConfigToDisk({
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
      });
    });

    return persistManagedRemoteTunnelConfigLock;
  };

  const syncManagedRemoteTunnelConfigWithPresets = async (presets: unknown) => {
    const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

    await updateManagedRemoteTunnelConfig((current) => {
      const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
      const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

      const nextTunnels: ManagedRemoteTunnelEntry[] = [];
      for (const preset of sanitizedPresets) {
        const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
        if (!existing) {
          continue;
        }

        nextTunnels.push({
          ...existing,
          id: preset.id,
          name: preset.name,
          hostname: preset.hostname,
        });
      }

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: nextTunnels,
      };
    });
  };

  const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token }: ManagedRemoteTunnelTokenInput) => {
    if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof token !== 'string') {
      return;
    }
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const normalizedToken = token.trim();
    if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
      return;
    }

    await updateManagedRemoteTunnelConfig((current) => {
      const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
      withoutConflicts.push({
        id: normalizedId,
        name: normalizedName,
        hostname: normalizedHostname,
        token: normalizedToken,
        updatedAt: Date.now(),
      });

      return {
        version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
        tunnels: withoutConflicts,
      };
    });
  };

  const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }: { presetId: string; hostname: string | undefined }) => {
    const normalizedPresetId = typeof presetId === 'string' ? presetId.trim() : '';
    const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
    const config = await readManagedRemoteTunnelConfigFromDisk();

    if (normalizedPresetId) {
      const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
      if (byId?.token) {
        return byId.token;
      }
    }

    if (normalizedHostname) {
      const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
      if (byHostname?.token) {
        return byHostname.token;
      }
    }

    return '';
  };

  return {
    readManagedRemoteTunnelConfigFromDisk,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
  };
};
