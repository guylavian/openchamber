import { readDiskCache, writeDiskCache } from './disk-cache.js';

interface RepoMeta {
  stars: number | null;
  repoUpdatedAt: string | null;
}

interface MetaCacheEntry {
  expiresAt: number;
  value: RepoMeta;
}

interface GitHubRepoPayload {
  stargazers_count?: number;
  pushed_at?: unknown;
}

const GITHUB_API_BASE = 'https://api.github.com';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
// Keep well under the catalog route's client request deadline so optional
// metadata enrichment can never abort catalog loading.
const FETCH_TIMEOUT_MS = 1500;
const DISK_CACHE_FILE = 'skills-github-meta.json';

const metaCache = new Map<string, MetaCacheEntry>();
const inFlight = new Map<string, Promise<RepoMeta | null>>();

let diskLoaded = false;
let diskWriteTimer: NodeJS.Timeout | null = null;

const loadDiskEntries = (): void => {
  if (diskLoaded) {
    return;
  }
  diskLoaded = true;
  const persisted = readDiskCache(DISK_CACHE_FILE);
  if (!persisted) {
    return;
  }
  const now = Date.now();
  for (const [repo, entry] of Object.entries(persisted as Record<string, MetaCacheEntry | null | undefined>)) {
    if (
      entry
      && typeof entry === 'object'
      && typeof entry.expiresAt === 'number'
      && entry.expiresAt > now
      && entry.value
      && typeof entry.value === 'object'
    ) {
      metaCache.set(repo, entry);
    }
  }
};

const scheduleDiskWrite = (): void => {
  if (diskWriteTimer) {
    return;
  }
  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    const now = Date.now();
    const persisted: Record<string, MetaCacheEntry> = {};
    for (const [repo, entry] of metaCache.entries()) {
      if (entry.expiresAt > now) {
        persisted[repo] = entry;
      }
    }
    writeDiskCache(DISK_CACHE_FILE, persisted);
  }, 1000);
  if (typeof diskWriteTimer.unref === 'function') {
    diskWriteTimer.unref();
  }
};

const parseMeta = (payload: GitHubRepoPayload | null | undefined): RepoMeta | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const pushedAt = payload.pushed_at;
  return {
    stars: Number.isFinite(payload.stargazers_count) ? payload.stargazers_count! : null,
    repoUpdatedAt: typeof pushedAt === 'string' && pushedAt ? pushedAt : null,
  };
};

const fetchRepoMeta = async (normalizedRepo: string): Promise<RepoMeta | null> => {
  loadDiskEntries();
  const cached = metaCache.get(normalizedRepo);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const existing = inFlight.get(normalizedRepo);
  if (existing) {
    return existing;
  }

  const run = (async (): Promise<RepoMeta | null> => {
    try {
      const response = await fetch(`${GITHUB_API_BASE}/repos/${normalizedRepo}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Cache failures briefly so repeated catalog loads do not re-hit a
        // rate-limited or failing API for the same repository.
        metaCache.set(normalizedRepo, {
          expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
          value: { stars: null, repoUpdatedAt: null },
        });
        scheduleDiskWrite();
        return null;
      }

      const value = parseMeta(await response.json() as GitHubRepoPayload | null);
      if (value) {
        metaCache.set(normalizedRepo, { expiresAt: Date.now() + CACHE_TTL_MS, value });
        scheduleDiskWrite();
      }
      return value;
    } catch {
      metaCache.set(normalizedRepo, {
        expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
        value: { stars: null, repoUpdatedAt: null },
      });
      scheduleDiskWrite();
      return null;
    } finally {
      inFlight.delete(normalizedRepo);
    }
  })();

  inFlight.set(normalizedRepo, run);
  return run;
};

/**
 * Fetch GitHub repository metadata (stars, last push) for a list of
 * `owner/repo` strings. Best-effort: failed lookups resolve to null and
 * never block the catalog response.
 */
export async function fetchGitHubRepoMetas(normalizedRepos: ReadonlyArray<string | null | undefined>): Promise<Record<string, RepoMeta | null>> {
  const unique = [...new Set(normalizedRepos.filter(Boolean))] as string[];
  const entries = await Promise.all(unique.map(async (repo): Promise<[string, RepoMeta | null]> => [repo, await fetchRepoMeta(repo)]));
  return Object.fromEntries(entries);
}

/** For tests only: clear the in-memory repository metadata cache. */
export function clearGitHubMetaCache(): void {
  metaCache.clear();
  inFlight.clear();
  diskLoaded = true;
}
