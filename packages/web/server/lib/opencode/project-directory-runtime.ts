import type { PlatformPath } from 'node:path';
import type { Request } from 'express';

import { createRealpathCache } from '../path-realpath-cache.js';
import type { LooseRecord, SanitizedProject } from './settings-normalization-runtime.js';

type ReadSettings = () => Promise<LooseRecord>;

export interface ProjectDirectoryRuntimeDependencies {
  fsPromises: typeof import('node:fs/promises');
  path: PlatformPath;
  normalizeDirectoryPath: (value: string) => string;
  readSettingsFromDiskMigrated: ReadSettings;
  getReadSettingsFromDiskMigrated?: (() => ReadSettings) | undefined;
  sanitizeProjects: (input: unknown) => SanitizedProject[] | undefined;
  refuseDirectory?: ((candidate: string) => string | null) | undefined;
}

interface DirectoryValidationFailure {
  ok: false;
  error: string;
}

interface DirectoryValidationSuccess {
  ok: true;
  directory: string;
  requestedDirectory: string;
}

export interface ProjectDirectoryResolution {
  directory: string | null;
  requestedDirectory: string | null;
  error: string | null;
}

// Browser transport percent-encodes directory hints and marks them explicitly.
// Only marked values are decoded so literal percent sequences from direct API
// clients are preserved.
const safeDecodeMarkedURIComponent = (value: string, encoding: string | null | undefined) => {
  if (encoding !== 'uri') return value;
  try { return decodeURIComponent(value); } catch { return value; }
};

export const createProjectDirectoryRuntime = (dependencies: ProjectDirectoryRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    normalizeDirectoryPath,
    readSettingsFromDiskMigrated,
    getReadSettingsFromDiskMigrated,
    sanitizeProjects,
    // `refuseDirectory(candidate)` answers the reason a directory may not be used on this host,
    // or null. It runs before the path is looked at, so a refused directory is never touched and
    // never falls back to another one. The isolated-spaces host refuses `/spaces/...` with it.
    refuseDirectory = () => null,
  } = dependencies;
  const realpathCache = createRealpathCache({
    realpath: fsPromises.realpath.bind(fsPromises),
  } as Parameters<typeof createRealpathCache>[0]);

  const resolveDirectoryCandidate = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = normalizeDirectoryPath(trimmed);
    return path.resolve(normalized);
  };

  const validateDirectoryPath = async (candidate: unknown): Promise<DirectoryValidationSuccess | DirectoryValidationFailure> => {
    const resolved = resolveDirectoryCandidate(candidate);
    if (!resolved) {
      return { ok: false, error: 'Directory parameter is required' };
    }
    const refusal = refuseDirectory(resolved);
    if (typeof refusal === 'string' && refusal.length > 0) {
      return { ok: false, error: refusal };
    }
    try {
      const stats = await fsPromises.stat(resolved);
      if (!stats.isDirectory()) {
        return { ok: false, error: 'Specified path is not a directory' };
      }
      const realPath = await realpathCache.resolve(resolved) as string;
      // `requestedDirectory` is the pre-realpath candidate the caller asked
      // for. Callers that address files in the user-visible path space (the
      // file tree, the read-family FS routes) need it when the project root
      // is itself a symlink and the canonical `directory` no longer contains
      // the paths the client sends.
      return { ok: true, directory: realPath, requestedDirectory: resolved };
    } catch (error) {
      const err = error as NodeJS.ErrnoException | null | undefined;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return { ok: false, error: 'Directory not found' };
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return { ok: false, error: 'Access to directory denied' };
      }
      return { ok: false, error: 'Failed to validate directory' };
    }
  };

  const resolveProjectDirectory = async (req: Request): Promise<ProjectDirectoryResolution> => {
    const rawHeaderDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const headerEncoding = typeof req.get === 'function' ? req.get('x-opencode-directory-encoding') : null;
    const headerDirectory = rawHeaderDirectory ? safeDecodeMarkedURIComponent(rawHeaderDirectory, headerEncoding) : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requested = [headerDirectory, queryDirectory].filter(Boolean);

    if (requested.length > 0) {
      let lastError: string | null = null;
      for (const candidate of requested) {
        const validated = await validateDirectoryPath(candidate);
        if (validated.ok) {
          return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
        }
        lastError = validated.error;
      }
      return { directory: null, requestedDirectory: null, error: lastError };
    }

    const readSettings = typeof getReadSettingsFromDiskMigrated === 'function'
      ? getReadSettingsFromDiskMigrated()
      : readSettingsFromDiskMigrated;
    const settings = await readSettings();

    // `lastDirectory` reflects the directory the UI is currently browsing —
    // useDirectoryStore.setDirectory() persists it on every navigation.
    // Prefer it over activeProjectId, because the user may have navigated
    // away from the project that was last "clicked" in the sidebar (e.g. via
    // `go to parent`, directory picker, or a deep link), leaving
    // activeProjectId stale. Fetches scoped to the stale project would 400
    // with "Path is outside of active workspace".
    if (typeof settings.lastDirectory === 'string' && settings.lastDirectory.trim()) {
      const validated = await validateDirectoryPath(settings.lastDirectory);
      if (validated.ok) {
        return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
      }
    }

    const projects = sanitizeProjects(settings.projects) || [];
    if (projects.length === 0) {
      return { directory: null, requestedDirectory: null, error: 'Directory parameter or active project is required' };
    }

    const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
    const active = projects.find((project) => project.id === activeId) || projects[0];
    if (!active || !active.path) {
      return { directory: null, requestedDirectory: null, error: 'Directory parameter or active project is required' };
    }

    const validated = await validateDirectoryPath(active.path);
    if (!validated.ok) {
      return { directory: null, requestedDirectory: null, error: validated.error };
    }

    return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
  };

  const resolveOptionalProjectDirectory = async (req: Request): Promise<ProjectDirectoryResolution> => {
    const rawHeaderDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const headerEncoding = typeof req.get === 'function' ? req.get('x-opencode-directory-encoding') : null;
    const headerDirectory = rawHeaderDirectory ? safeDecodeMarkedURIComponent(rawHeaderDirectory, headerEncoding) : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requested = [headerDirectory, queryDirectory].filter(Boolean);

    if (requested.length === 0) {
      return { directory: null, requestedDirectory: null, error: null };
    }

    let lastError: string | null = null;
    for (const candidate of requested) {
      const validated = await validateDirectoryPath(candidate);
      if (validated.ok) {
        return { directory: validated.directory, requestedDirectory: validated.requestedDirectory, error: null };
      }
      lastError = validated.error;
    }
    return { directory: null, requestedDirectory: null, error: lastError };
  };

  return {
    resolveDirectoryCandidate,
    validateDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
  };
};
