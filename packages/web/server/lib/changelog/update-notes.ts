// Release notes for the update dialog.
//
// The repo publishes `changelog/index.json` on `main`: one object per release,
// newest first, with the app notes grouped as New / Improvements / Fixes /
// SDK / Misc. This module fetches it and renders the releases between the installed
// version (exclusive) and the offered one (inclusive) as the Markdown the
// dialog already understands: a `## [x.y.z] - YYYY-MM-DD` header per release,
// the release title in bold, the intro, then the groups.
//
// Any failure (network, 404, unexpected shape) yields null: the update is
// still offered, only without notes.

export const CHANGELOG_INDEX_URL = 'https://raw.githubusercontent.com/openchamber/openchamber/main/changelog/index.json';

type GroupKey = 'new' | 'improvements' | 'fixes' | 'sdk' | 'misc';

interface ChangelogEntry {
  version?: unknown;
  date?: unknown;
  title?: unknown;
  intro?: unknown;
  app?: Partial<Record<GroupKey, unknown>> | null;
}

interface ReleaseGroup {
  heading: string;
  bullets: string[];
}

interface Release {
  version: string;
  date: string;
  title: string | null;
  intro: string | null;
  groups: ReleaseGroup[];
}

type CompareVersions = (left: string, right: string) => number;

interface FetchUpdateNotesOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const GROUPS: ReadonlyArray<readonly [GroupKey, string]> = [
  ['new', 'New'],
  ['improvements', 'Improvements'],
  ['fixes', 'Fixes'],
  ['sdk', 'SDK'],
  ['misc', 'Misc'],
];

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// The file crosses a network boundary with no schema library on this side, so
// each field is coerced into its domain shape here; a release without a valid
// version and date is dropped.
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value).trim() || null);
const bulletList = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item)) : []);

const parseRelease = (entry: ChangelogEntry | null | undefined): Release | null => {
  if (entry === null || entry === undefined) return null;
  const version = text(entry.version);
  const date = text(entry.date);
  if (!version || !VERSION_PATTERN.test(version) || !date || !DATE_PATTERN.test(date)) return null;
  const app = entry.app ?? {};
  return {
    version,
    date,
    title: text(entry.title),
    intro: text(entry.intro),
    groups: GROUPS.map(([key, heading]) => ({ heading, bullets: bulletList(app[key]) })),
  };
};

const renderRelease = (release: Release): string => {
  const lines = [`## [${release.version}] - ${release.date}`, ''];
  if (release.title) lines.push(`**${release.title}**`, '');
  if (release.intro) lines.push(release.intro, '');
  for (const { heading, bullets } of release.groups) {
    if (bullets.length === 0) continue;
    lines.push(`### ${heading}`, '', ...bullets.map((bullet) => `- ${bullet}`), '');
  }
  return lines.join('\n').trim();
};

/**
 * Markdown for the releases in (fromVersion, toVersion], newest first, or
 * null when the index holds none of them.
 */
export function renderUpdateNotes(index: unknown, fromVersion: string, toVersion: string, compareVersions: CompareVersions): string | null {
  if (!Array.isArray(index)) return null;
  const relevant = index
    .map(parseRelease)
    .filter((release) => release !== null)
    .filter((release) => compareVersions(release.version, fromVersion) > 0 && compareVersions(release.version, toVersion) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (relevant.length === 0) return null;
  return relevant.map(renderRelease).join('\n\n');
}

/** Fetch the index and render the notes for one update; null on any failure. */
export async function fetchUpdateNotes(fromVersion: string, toVersion: string, compareVersions: CompareVersions, options: FetchUpdateNotesOptions = {}): Promise<string | null> {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(CHANGELOG_INDEX_URL, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (!response.ok) return null;
    return renderUpdateNotes(await response.json(), fromVersion, toVersion, compareVersions);
  } catch {
    return null;
  }
}
