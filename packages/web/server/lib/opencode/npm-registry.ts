import fs from 'fs';

import { resolveNpmRegistryRequest } from './npm-registry-config.js';
import { PACKAGE_JSON_PATH } from '../package-root.js';

interface NpmPackagePayload {
  ok: true;
  latest: string | null;
  versions: string[];
  distTags: Record<string, string>;
}

interface NpmLookupError {
  ok: false;
  status: number | 'network';
  error: string;
}

export type NpmLookupResult = NpmPackagePayload | NpmLookupError;

interface NpmInfoOptions {
  forceRefresh?: boolean | undefined;
}

interface CacheEntry {
  fetchedAt: number;
  payload: NpmLookupResult;
}

interface ThrownValue {
  message?: unknown;
}

const NPM_CACHE_TTL_MS = 3_600_000;
const NPM_FETCH_TIMEOUT_MS = 5_000;

/**
 * @typedef {Object} NpmPackagePayload
 * @property {true} ok
 * @property {string|null} latest
 * @property {string[]} versions
 * @property {Record<string, string>} distTags
 *
 * @typedef {Object} NpmLookupError
 * @property {false} ok
 * @property {number|'network'} status
 * @property {string} error
 *
 * @typedef {NpmPackagePayload | NpmLookupError} NpmLookupResult
 * @typedef {{ forceRefresh?: boolean }} NpmInfoOptions
 * @typedef {{ fetchedAt: number, payload: NpmLookupResult }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const _cache = new Map<string, CacheEntry>();

/** @type {Map<string, Promise<NpmLookupResult>>} */
const _inFlight = new Map<string, Promise<NpmLookupResult>>();

/** @type {string | null} */
let _userAgent: string | null = null;

// The @openchamber/web manifest. Counting `..` from here reached the monorepo
// root in a checkout and the consumer's own package.json once installed.
function _getPackageJsonPath() {
  return PACKAGE_JSON_PATH;
}

function _getUserAgent() {
  if (_userAgent) return _userAgent;

  try {
    const pkg = JSON.parse(fs.readFileSync(_getPackageJsonPath(), 'utf8')) as { version?: unknown };
    _userAgent = `openchamber-server/${typeof pkg.version === 'string' ? pkg.version : '0.0.0'}`;
  } catch {
    _userAgent = 'openchamber-server/dev';
  }

  return _userAgent;
}

function parseDistTags(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => typeof entry[1] === 'string'),
  );
}

function parseVersions(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value);
}

function cacheResult(name: string, payload: NpmLookupResult) {
  if (payload.ok || payload.status === 404) {
    _cache.set(name, { fetchedAt: Date.now(), payload });
  }
}

/**
 * Fetch package metadata directly from the npm registry.
 *
 * @param {string} name npm package name
 * @returns {Promise<NpmLookupResult>}
 */
export async function lookupNpmPackage(name: string): Promise<NpmLookupResult> {
  try {
    const request = resolveNpmRegistryRequest(name);
    const response = await fetch(request.url, {
      headers: {
        'User-Agent': _getUserAgent(),
        Accept: 'application/json',
        ...request.headers,
      },
      signal: AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      const data = await response.json() as { 'dist-tags'?: unknown; versions?: unknown } | null;
      const distTags = parseDistTags(data?.['dist-tags']);
      return {
        ok: true,
        latest: distTags.latest ?? null,
        versions: parseVersions(data?.versions),
        distTags,
      };
    }

    if (response.status === 404) {
      return { ok: false, status: 404, error: 'Package not found' };
    }

    return { ok: false, status: response.status, error: `Registry returned ${response.status}` };
  } catch (error) {
    return { ok: false, status: 'network', error: String((error as ThrownValue | null | undefined)?.message ?? error) };
  }
}

/**
 * Fetch package metadata with TTL cache and in-flight request deduplication.
 *
 * @param {string} name npm package name
 * @param {NpmInfoOptions} [options]
 * @returns {Promise<NpmLookupResult>}
 */
export async function getNpmInfo(name: string, options: NpmInfoOptions = {}): Promise<NpmLookupResult> {
  const { forceRefresh = false } = options;
  const cached = _cache.get(name);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < NPM_CACHE_TTL_MS) {
    return cached.payload;
  }

  const existing = _inFlight.get(name);
  if (existing && !forceRefresh) {
    return existing;
  }

  const lookup = (async () => {
    const result = await lookupNpmPackage(name);
    cacheResult(name, result);
    return result;
  })();

  _inFlight.set(name, lookup);
  try {
    return await lookup;
  } finally {
    if (_inFlight.get(name) === lookup) {
      _inFlight.delete(name);
    }
  }
}

export function clearCache() {
  _cache.clear();
  _inFlight.clear();
}
