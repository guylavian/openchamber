import type { PlatformPath } from 'node:path';

export interface SettingsNormalizationDependencies {
  os: { homedir: () => string };
  path: PlatformPath;
  processLike: { platform: string };
  realpathSync?: ((value: string) => string) | null;
  tunnelBootstrapTtlDefaultMs: number;
  tunnelBootstrapTtlMinMs: number;
  tunnelBootstrapTtlMaxMs: number;
  tunnelSessionTtlDefaultMs: number;
  tunnelSessionTtlMinMs: number;
  tunnelSessionTtlMaxMs: number;
}

export type LooseRecord = Partial<Record<string, unknown>>;

export type LooseEntry = LooseRecord | string | number | boolean | null | undefined;

export type SettingsValue = string | number | boolean | null | undefined | LooseEntry[] | Record<string, unknown>;

export type SettingsDocument = Partial<Record<string, SettingsValue>>;

export interface ProjectIconImage {
  mime: string;
  updatedAt: number;
  source: 'custom' | 'auto';
}

export interface SanitizedProject {
  id: string;
  path: string;
  label?: string;
  icon?: string;
  iconBackground?: string | null;
  color?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultVariant?: string;
  addedAt?: number | null;
  lastOpenedAt?: number | null;
  iconImage?: ProjectIconImage | null;
  sidebarCollapsed?: boolean;
}

export interface ManagedRemoteTunnelPreset {
  id: string;
  name: string;
  hostname: string;
}

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface SkillCatalog {
  id: string;
  label: string;
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

export const createSettingsNormalizationRuntime = (dependencies: SettingsNormalizationDependencies) => {
  const {
    os,
    path,
    processLike,
    realpathSync,
    tunnelBootstrapTtlDefaultMs,
    tunnelBootstrapTtlMinMs,
    tunnelBootstrapTtlMaxMs,
    tunnelSessionTtlDefaultMs,
    tunnelSessionTtlMinMs,
    tunnelSessionTtlMaxMs,
  } = dependencies;

  const normalizeDirectoryPath = <T>(value: T): T | string => {
    if (typeof value !== 'string') {
      return value;
    }

    let trimmed = value.trim();
    // Paths pasted from Windows "Copy as path" (or quoted shell snippets)
    // arrive wrapped in quotes — a literal quote character can never be part
    // of a real path, and it breaks every fs.stat/executable check.
    if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    if (!trimmed) {
      return trimmed;
    }

    if (trimmed === '~') {
      return os.homedir();
    }

    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      return path.join(os.homedir(), trimmed.slice(2));
    }

    return trimmed;
  };

  // Resolve symlinks, falling back to the original value on failure.
  const safeRealpathSync = <T>(value: T): T | string => {
    if (!realpathSync || typeof value !== 'string' || !value) {
      return value;
    }
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };

  const normalizePathForPersistence = <T>(value: T, options: { resolveRealpath?: boolean } = {}): T | string => {
    if (typeof value !== 'string') {
      return value;
    }

    const normalized = normalizeDirectoryPath(value);
    if (typeof normalized !== 'string') {
      return normalized;
    }

    const trimmed = normalized.trim();
    if (!trimmed) {
      return trimmed;
    }

    // Normalize Windows drive letter to uppercase to ensure consistent
    // case across all path representations on Windows. NTFS is case-insensitive
    // but case-preserving, so a path like "c:\\Users\\..." and "C:\\Users\\..."
    // would be stored differently in settings.json across sessions.
    const uppercaseDriveLetter = (p: string) =>
      p.replace(/^([a-z]):/, (_: string, letter: string) => letter.toUpperCase() + ':');

    const isWindows = processLike.platform === 'win32';
    const caseNormalized = isWindows ? uppercaseDriveLetter(trimmed) : trimmed;
    const resolved = options.resolveRealpath === false ? caseNormalized : safeRealpathSync(caseNormalized);

    // Re-normalize after realpath — safeRealpathSync may return a
    // lowercase drive letter on some Windows environments.
    const finalResolved = isWindows && typeof resolved === 'string'
      ? uppercaseDriveLetter(resolved)
      : resolved;

    if (!isWindows) {
      return finalResolved;
    }

    return finalResolved.replace(/\//g, '\\');
  };

  const areStringArraysEqual = (a: unknown, b: unknown): boolean => {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  };

  const normalizeStringArray = (input: unknown): string[] => {
    if (!Array.isArray(input)) {
      return [];
    }
    return Array.from(
      new Set(
        input.filter((entry: unknown): entry is string => typeof entry === 'string' && entry.length > 0)
      )
    );
  };

  const sanitizeProjects = (input: unknown): SanitizedProject[] | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const hexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;
    const normalizeIconBackground = (value: unknown): string | null => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      return hexColorPattern.test(trimmed) ? trimmed.toLowerCase() : null;
    };

    const result: SanitizedProject[] = [];
    const seenIds = new Set();
    const seenPaths = new Set();

    for (const entry of input as LooseEntry[]) {
      if (!entry || typeof entry !== 'object') continue;

      const candidate = entry;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
      const resolvedPath = rawPath ? safeRealpathSync(path.resolve(normalizeDirectoryPath(rawPath))) : '';
      const normalizedPath = resolvedPath ? normalizePathForPersistence(resolvedPath, { resolveRealpath: false }) : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const icon = typeof candidate.icon === 'string' ? candidate.icon.trim() : '';
      const iconImage: LooseRecord | null = candidate.iconImage && typeof candidate.iconImage === 'object'
        ? candidate.iconImage
        : null;
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      const color = typeof candidate.color === 'string' ? candidate.color.trim() : '';
      const defaultAgent = typeof candidate.defaultAgent === 'string' ? candidate.defaultAgent.trim() : '';
      const defaultModel = typeof candidate.defaultModel === 'string' ? candidate.defaultModel.trim() : '';
      const defaultVariant = typeof candidate.defaultVariant === 'string' ? candidate.defaultVariant.trim() : '';
      const addedAt = Number.isFinite(candidate.addedAt) ? Number(candidate.addedAt) : null;
      const lastOpenedAt = Number.isFinite(candidate.lastOpenedAt)
        ? Number(candidate.lastOpenedAt)
        : null;

      if (!id || !normalizedPath) continue;
      if (seenIds.has(id)) continue;
      if (seenPaths.has(normalizedPath)) continue;

      seenIds.add(id);
      seenPaths.add(normalizedPath);

      const project: SanitizedProject = {
        id,
        path: normalizedPath,
        ...(label ? { label } : {}),
        ...(icon ? { icon } : {}),
        ...(iconBackground ? { iconBackground } : {}),
        ...(color ? { color } : {}),
        ...(defaultAgent ? { defaultAgent } : {}),
        ...(defaultModel && defaultModel.includes('/') ? { defaultModel } : {}),
        // A variant is meaningless without the model it belongs to.
        ...(defaultModel && defaultModel.includes('/') && defaultVariant ? { defaultVariant } : {}),
        ...(Number.isFinite(addedAt) && addedAt! >= 0 ? { addedAt } : {}),
        ...(Number.isFinite(lastOpenedAt) && lastOpenedAt! >= 0 ? { lastOpenedAt } : {}),
      };

      if (candidate.iconImage === null) {
        project.iconImage = null;
      } else if (iconImage) {
        const mime = typeof iconImage.mime === 'string' ? iconImage.mime.trim() : '';
        const updatedAt = typeof iconImage.updatedAt === 'number' && Number.isFinite(iconImage.updatedAt)
          ? Math.max(0, Math.round(iconImage.updatedAt))
          : 0;
        const source = iconImage.source === 'custom' || iconImage.source === 'auto'
          ? iconImage.source
          : null;
        if (mime && updatedAt > 0 && source) {
          project.iconImage = { mime, updatedAt, source };
        }
      }

      if (candidate.iconBackground === null) {
        project.iconBackground = null;
      }

      if (typeof candidate.sidebarCollapsed === 'boolean') {
        project.sidebarCollapsed = candidate.sidebarCollapsed;
      }

      result.push(project);
    }

    return result;
  };

  const normalizeSettingsPaths = (input: unknown): { settings: LooseRecord; changed: boolean } => {
    const settings: LooseRecord = input && typeof input === 'object' ? input : {};
    let next = settings;
    let changed = false;

    const ensureNext = () => {
      if (next === settings) {
        next = { ...settings };
      }
    };

    const normalizePathField = (key: string) => {
      if (typeof settings[key] !== 'string' || settings[key].length === 0) {
        return;
      }
      const normalized = normalizePathForPersistence(settings[key]);
      if (normalized !== settings[key]) {
        ensureNext();
        next[key] = normalized;
        changed = true;
      }
    };

    const normalizePathArrayField = (key: string) => {
      if (!Array.isArray(settings[key])) {
        return;
      }

      const normalized = normalizeStringArray(
        settings[key]
          .map((entry: unknown) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
          .filter((entry) => typeof entry === 'string' && entry.length > 0)
      );

      if (!areStringArraysEqual(normalized, settings[key])) {
        ensureNext();
        next[key] = normalized;
        changed = true;
      }
    };

    normalizePathField('lastDirectory');
    normalizePathField('homeDirectory');
    normalizePathArrayField('pinnedDirectories');

    if (Array.isArray(settings.projects)) {
      const normalizedProjects = sanitizeProjects(settings.projects) || [];
      if (JSON.stringify(normalizedProjects) !== JSON.stringify(settings.projects)) {
        ensureNext();
        next.projects = normalizedProjects;
        changed = true;
      }
    }

    return { settings: next, changed };
  };

  const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  const normalizeTunnelBootstrapTtlMs = (value: unknown): number | null => {
    if (value === null) {
      return null;
    }
    if (!Number.isFinite(value)) {
      return tunnelBootstrapTtlDefaultMs;
    }
    return clampNumber(Math.round(value as number), tunnelBootstrapTtlMinMs, tunnelBootstrapTtlMaxMs);
  };

  const normalizeTunnelSessionTtlMs = (value: unknown): number => {
    if (!Number.isFinite(value)) {
      return tunnelSessionTtlDefaultMs;
    }
    return clampNumber(Math.round(value as number), tunnelSessionTtlMinMs, tunnelSessionTtlMaxMs);
  };

  const normalizeManagedRemoteTunnelHostname = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = (() => {
      try {
        if (trimmed.includes('://')) {
          return new URL(trimmed);
        }
        return new URL(`https://${trimmed}`);
      } catch {
        return null;
      }
    })();

    const hostname = parsed?.hostname?.trim().toLowerCase() || '';
    if (!hostname) {
      return undefined;
    }
    return hostname;
  };

  const normalizeManagedRemoteTunnelPresets = (value: unknown): ManagedRemoteTunnelPreset[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const result: ManagedRemoteTunnelPreset[] = [];
    const seenIds = new Set();
    const seenHostnames = new Set();

    for (const entry of value as LooseEntry[]) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(candidate.hostname);
      if (!id || !name || !hostname) continue;
      if (seenIds.has(id) || seenHostnames.has(hostname)) continue;
      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname });
    }

    return result;
  };

  const normalizeManagedRemoteTunnelPresetTokens = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const result: Record<string, string> = {};
    for (const [rawId, rawToken] of Object.entries(value)) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      const token = typeof rawToken === 'string' ? rawToken.trim() : '';
      if (!id || !token) {
        continue;
      }
      result[id] = token;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };

  const isUnsafeSkillRelativePath = (value: unknown): boolean => {
    if (typeof value !== 'string' || value.length === 0) {
      return true;
    }

    const normalized = value.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized)) {
      return true;
    }

    return normalized.split('/').some((segment) => segment === '..');
  };

  const sanitizeTypographySizesPartial = (input: unknown): Record<string, string> | undefined => {
    if (!input || typeof input !== 'object') {
      return undefined;
    }
    const candidate: LooseRecord = input;
    const result: Record<string, string> = {};
    let populated = false;

    const assign = (key: string) => {
      if (typeof candidate[key] === 'string' && candidate[key].length > 0) {
        result[key] = candidate[key];
        populated = true;
      }
    };

    assign('markdown');
    assign('code');
    assign('uiHeader');
    assign('uiLabel');
    assign('meta');
    assign('micro');

    return populated ? result : undefined;
  };

  const sanitizeModelRefs = (input: unknown, limit: number): ModelRef[] | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const result: ModelRef[] = [];
    const seen = new Set();

    for (const entry of input as LooseEntry[]) {
      if (!entry || typeof entry !== 'object') continue;
      const providerID = typeof entry.providerID === 'string' ? entry.providerID.trim() : '';
      const modelID = typeof entry.modelID === 'string' ? entry.modelID.trim() : '';
      if (!providerID || !modelID) continue;
      const key = `${providerID}/${modelID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ providerID, modelID });
      if (result.length >= limit) break;
    }

    return result;
  };

  const sanitizeSkillCatalogs = (input: unknown): SkillCatalog[] | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const result: SkillCatalog[] = [];
    const seen = new Set();

    for (const entry of input as LooseEntry[]) {
      if (!entry || typeof entry !== 'object') continue;

      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      const source = typeof entry.source === 'string' ? entry.source.trim() : '';
      const subpath = typeof entry.subpath === 'string' ? entry.subpath.trim() : '';
      const gitIdentityId = typeof entry.gitIdentityId === 'string' ? entry.gitIdentityId.trim() : '';

      if (!id || !label || !source) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      result.push({
        id,
        label,
        source,
        ...(subpath ? { subpath } : {}),
        ...(gitIdentityId ? { gitIdentityId } : {}),
      });
    }

    return result;
  };

  return {
    normalizeDirectoryPath,
    normalizePathForPersistence,
    normalizeSettingsPaths,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelPresetTokens,
    isUnsafeSkillRelativePath,
    sanitizeTypographySizesPartial,
    normalizeStringArray,
    sanitizeModelRefs,
    sanitizeSkillCatalogs,
    sanitizeProjects,
  };
};
