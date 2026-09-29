// The two settings files and how a merged document is split between them.
//
// `settings.json` holds instance facts (and, untouched, whatever legacy keys
// older builds left there). `preferences.json` holds the user's profile: the
// keys the settings registry marks `profile`, each with the time the store
// last accepted a new value for it. Device keys never reach either file.
//
// The VS Code extension host writes the same two files with the same shape
// (`packages/vscode/src/settings-files.ts`); keep the format changes in sync.
import { createRequire } from 'node:module';
import type { PlatformPath } from 'node:path';

export interface SettingsRegistryField {
  scope?: string;
  perSurface?: boolean;
  local?: boolean;
  computed?: boolean;
  derived?: boolean;
  secret?: boolean;
  owner?: string;
  adopt?: string;
  surfaces?: string[];
}

export interface SettingsRegistry {
  version: number;
  fields: Record<string, SettingsRegistryField>;
}

type SurfaceValue = { value: unknown; updatedAt: number };
export type PreferenceField = { value?: unknown; updatedAt: number; surfaces?: Partial<Record<string, SurfaceValue>> };
export type PreferenceFields = Record<string, PreferenceField>;

export type ParsedPreferencesDocument =
  | { ok: true; fields: PreferenceFields }
  | { ok: false; reason: string };

interface SurfaceRequest {
  query?: { surface?: unknown };
  get?: (name: string) => string | undefined;
}

const registry = createRequire(import.meta.url)('./settings-registry.json') as SettingsRegistry;

const PREFERENCES_FILE_NAME = 'preferences.json';
const PREFERENCES_DOCUMENT_VERSION = 1;

/** The registry scope for a key, or `null` when the registry does not know it. */
const getSettingsScope = (key: string): string | null => registry.fields[key]?.scope ?? null;

export const isProfileSettingsKey = (key: string): boolean => getSettingsScope(key) === 'profile';
export const isDeviceSettingsKey = (key: string): boolean => getSettingsScope(key) === 'device';

/** Profile keys the owner chose to store per surface kind (a change on a phone stays on phones). */
const isPerSurfaceSettingsKey = (key: string): boolean => registry.fields[key]?.perSurface === true;

const SETTINGS_SURFACES = Object.freeze(['web', 'desktop', 'vscode', 'mobile']);

export const normalizeSettingsSurface = (value: unknown): string | null => (
  typeof value === 'string' && SETTINGS_SURFACES.includes(value.trim()) ? value.trim() : null
);

/**
 * Which surface kind a settings request comes from; `null` means "base".
 * Clients send `?surface=<kind>` (a query parameter keeps the request
 * CORS-simple for cross-origin shells and older instances); the
 * `x-openchamber-surface` header is still honoured for clients that sent it.
 */
export const settingsSurfaceOf = (req: SurfaceRequest): string | null => (
  normalizeSettingsSurface(req.query?.surface) ?? normalizeSettingsSurface(req.get?.('x-openchamber-surface'))
);

export const preferencesFilePathFor = (settingsFilePath: string, path: PlatformPath): string => path.join(path.dirname(settingsFilePath), PREFERENCES_FILE_NAME);

const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const parseStamp = (value: unknown): number => (Number.isFinite(value) ? value as number : 0);

/**
 * Parse the text of a preferences file. A missing file is the caller's case
 * (ENOENT); anything that is not a version-1 document with a `fields` object
 * is a failure, never an empty profile.
 *
 * An entry is `{ value, updatedAt }` for the base value, optionally with
 * `surfaces: { [surface]: { value, updatedAt } }` for per-surface keys; a
 * per-surface key that was only ever set from one surface kind has no base.
 */
export const parsePreferencesDocument = (raw: string): ParsedPreferencesDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(parsed) || parsed.version !== PREFERENCES_DOCUMENT_VERSION || !isPlainObject(parsed.fields)) {
    return { ok: false, reason: 'not a version-1 preferences document' };
  }
  const fields: PreferenceFields = {};
  for (const [key, entry] of Object.entries(parsed.fields)) {
    if (!isPlainObject(entry) || (!('value' in entry) && !isPlainObject(entry.surfaces))) {
      return { ok: false, reason: `field "${key}" is not a { value, updatedAt } entry` };
    }
    const next: PreferenceField = { updatedAt: parseStamp(entry.updatedAt) };
    if ('value' in entry) next.value = entry.value;
    if (isPlainObject(entry.surfaces)) {
      next.surfaces = {};
      for (const [surface, surfaceEntry] of Object.entries(entry.surfaces)) {
        if (!SETTINGS_SURFACES.includes(surface) || !isPlainObject(surfaceEntry) || !('value' in surfaceEntry)) {
          return { ok: false, reason: `field "${key}" has an invalid surface entry "${surface}"` };
        }
        next.surfaces[surface] = { value: surfaceEntry.value, updatedAt: parseStamp(surfaceEntry.updatedAt) };
      }
    }
    fields[key] = next;
  }
  return { ok: true, fields };
};

export const serializePreferencesDocument = (fields: PreferenceFields): string => JSON.stringify({ version: PREFERENCES_DOCUMENT_VERSION, fields }, null, 2);

/**
 * The plain key → value view of preference fields as one surface kind sees it:
 * that surface's own value first, the base value otherwise; a key with neither
 * is absent (the client keeps what it holds, or its default).
 */
export const flattenPreferences = (fields: PreferenceFields, surface: string | null = null): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const own = surface && entry.surfaces ? entry.surfaces[surface] : undefined;
    if (own) {
      values[key] = own.value;
    } else if ('value' in entry) {
      values[key] = entry.value;
    }
  }
  return values;
};

/**
 * The next preference fields for a merged document: every profile key it
 * carries, stamped `now` when its value differs from what the file held and
 * keeping the earlier stamp otherwise. Profile keys the document no longer
 * carries are dropped (that is how a cleared key leaves the file).
 *
 * Per-surface keys: when the write comes from a surface kind (`surface`) and
 * the key is among the keys that write changed (`changedKeys`), the value goes
 * under `surfaces[surface]` and the base is left as it was; a per-surface key
 * the write did not change keeps its whole entry (the document only carries
 * that surface's resolved view of it). Without a surface (migrations, the
 * one-time seed) the base is written.
 */
export const buildPreferencesFields = (
  previousFields: PreferenceFields,
  document: Record<string, unknown>,
  now: number,
  { surface = null, changedKeys = null }: { surface?: string | null; changedKeys?: Iterable<string> | null } = {},
): PreferenceFields => {
  const fields: PreferenceFields = {};
  const changed = changedKeys ? new Set(changedKeys) : null;
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || !isProfileSettingsKey(key)) continue;
    const previous = previousFields[key];
    if (isPerSurfaceSettingsKey(key) && surface) {
      if (changed && !changed.has(key)) {
        if (previous) fields[key] = previous;
        continue;
      }
      const previousOwn = previous?.surfaces?.[surface];
      const own = previousOwn && sameValue(previousOwn.value, value) ? previousOwn : { value, updatedAt: now };
      fields[key] = {
        ...(previous ?? { updatedAt: 0 }),
        surfaces: { ...(previous?.surfaces ?? {}), [surface]: own },
      };
      continue;
    }
    if (previous && 'value' in previous && sameValue(previous.value, value)) {
      fields[key] = previous;
    } else {
      fields[key] = { ...(previous ?? {}), value, updatedAt: now };
    }
  }
  return fields;
};

/**
 * The part of a merged document that belongs in `settings.json`: everything
 * that is not a profile key. Device keys older builds persisted stay in place
 * as a read-once seed for clients; the write path never adds new ones.
 */
export const instancePartOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const instance: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined || isProfileSettingsKey(key)) continue;
    instance[key] = value;
  }
  return instance;
};

/** The profile keys of a document (the part `instancePartOf` leaves out). */
export const profilePartOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const profile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value !== undefined && isProfileSettingsKey(key)) profile[key] = value;
  }
  return profile;
};

/**
 * What `settings.json` holds after a write: the instance part plus a copy of
 * the profile's base values. The copy is for builds that predate the split —
 * they read only this file, so a rollback still finds the user's preferences.
 * Current builds ignore it: `preferences.json` wins in the merged read.
 */
export const legacySettingsDocumentOf = (document: Record<string, unknown>, preferenceFields: PreferenceFields): Record<string, unknown> => ({
  ...instancePartOf(document),
  ...flattenPreferences(preferenceFields),
});

/** The profile keys of a document, as they would seed a fresh preferences file. */
export const seedPreferencesFrom = (document: Record<string, unknown>, now: number): PreferenceFields => buildPreferencesFields({}, document, now);

/**
 * Synchronous merged read for server modules that consult one or two profile
 * keys on a hot path (small-model resolution, goal/assist toggles). A missing
 * or unreadable preferences file contributes nothing, and the caller's own
 * default applies — the same "missing is not default" rule the clients use.
 */
export const readMergedSettingsSync = ({ fs, path, settingsFilePath }: {
  fs: { readFileSync: (path: string, encoding: 'utf8') => string };
  path: PlatformPath;
  settingsFilePath: string;
}): Record<string, unknown> => {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    if (isPlainObject(parsed)) settings = parsed;
  } catch {
    settings = {};
  }
  let preferences: Record<string, unknown> = {};
  try {
    const parsed = parsePreferencesDocument(fs.readFileSync(preferencesFilePathFor(settingsFilePath, path), 'utf8'));
    if (parsed.ok) preferences = flattenPreferences(parsed.fields);
  } catch {
    preferences = {};
  }
  return { ...settings, ...preferences };
};
