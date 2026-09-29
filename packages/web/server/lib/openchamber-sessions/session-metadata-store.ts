/**
 * OpenChamber per-session metadata, held by OpenCode.
 *
 * Goal mode, session assist, obligatory context re-injection and pinned
 * notes/plans keep their per-session state in the session's `metadata`, under
 * the `openchamber` namespace. OpenCode 2.0.15 added `PATCH /api/session/{id}`
 * with `metadata`, so the OpenCode record is the single authority and every
 * client reading `session.metadata` sees the same thing.
 *
 * OpenCode replaces the whole object on PATCH. Writers here send a JSON Merge
 * Patch (RFC 7386): nested objects merge key by key and a `null` deletes. The
 * store reads the record, merges, and writes the result back, one write per
 * session at a time, so goal mode saving progress cannot drop an assist recap
 * that was written a moment earlier.
 *
 * Before 2.0.15 the state lived in `sessions-metadata.json` under the data dir.
 * Entries still in that file are the newest metadata their sessions have: they
 * are served from the file and pushed to OpenCode, lazily on the session's
 * first write and in one sweep once OpenCode is up. A pushed entry leaves the
 * file; an empty file is renamed to `sessions-metadata.json.migrated` and kept
 * so nothing is lost if a migration turns out wrong.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

import { createOpenCodeClient as createOpenCodeClientDefault } from './opencode-client.js';
import type { JsonValue } from '@opencode/client';

const LEGACY_FILE_NAME = 'sessions-metadata.json';

type Metadata = { [key: string]: JsonValue };

type Thrown = { code?: unknown; message?: unknown } | null | undefined;

interface SessionMetadataOpenCode {
  read: (sessionID: string, options?: { directory?: string }) => Promise<Metadata | null>;
  write: (sessionID: string, metadata: Metadata, options?: { directory?: string }) => Promise<unknown>;
}

interface SessionMetadataStoreOptions {
  dataDir: string;
  openCode: SessionMetadataOpenCode;
  fsPromises?: typeof fsDefault.promises;
  path?: typeof pathDefault;
  now?: () => number;
}

const asNonEmptyString = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPlainObject = (value: unknown): value is Metadata => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * RFC 7386 merge. Returns a new object; `null` in the patch removes the key,
 * and a non-object patch value replaces whatever was there.
 */
export const mergeMetadataPatch = (current: unknown, patch: unknown): Metadata => {
  const base: Metadata = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = isPlainObject(value) ? mergeMetadataPatch(base[key], value) : value;
  }
  return base;
};

const isSessionNotFound = (error: unknown) => (error as { _tag?: unknown } | null | undefined)?._tag === 'SessionNotFoundError';

/**
 * Reads and writes one session's metadata on OpenCode. `read` resolves `null`
 * when OpenCode does not know the session; any other failure throws, because
 * "could not ask" must not become "empty".
 */
export const createOpenCodeSessionMetadata = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  createOpenCodeClient = createOpenCodeClientDefault,
}: {
  buildOpenCodeUrl: (path: string, directory: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  createOpenCodeClient?: typeof createOpenCodeClientDefault;
}) => {
  const clientFor = (directory: string) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });
  return {
    read: async (sessionID: string, { directory = '' }: { directory?: string } = {}) => {
      let session;
      try {
        // The 2.x client unwraps the `{ data }` envelope: this is the record itself.
        session = await clientFor(directory).session.get({ sessionID });
      } catch (error) {
        if (isSessionNotFound(error)) return null;
        throw error;
      }
      return isPlainObject(session?.metadata) ? session.metadata : {};
    },
    write: (sessionID: string, metadata: Metadata, { directory = '' }: { directory?: string } = {}) =>
      clientFor(directory).session.update({ sessionID, metadata }),
  };
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory; holds the legacy file.
 * @param {{ read: Function, write: Function }} options.openCode See {@link createOpenCodeSessionMetadata}.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 */
export const createSessionMetadataStore = ({
  dataDir,
  openCode,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}: SessionMetadataStoreOptions) => {
  const legacyPath = path.join(dataDir, LEGACY_FILE_NAME);

  /** sessionID → metadata from the legacy file that OpenCode does not hold yet. */
  const unmigrated = new Map<string, Metadata>();
  let legacyLoad: Promise<void> | null = null;

  /**
   * One chain per session: read, merge and write cannot interleave with another
   * write to the same session. Different sessions proceed in parallel.
   */
  const sessionChains = new Map<string, Promise<void>>();
  const runForSession = <T>(id: string, work: () => Promise<T>) => {
    const previous = sessionChains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    sessionChains.set(id, settled);
    void settled.then(() => {
      if (sessionChains.get(id) === settled) sessionChains.delete(id);
    });
    return next;
  };

  /** Legacy file rewrites, one at a time so an older snapshot never lands last. */
  let fileChain = Promise.resolve();
  const runFileWrite = <T>(work: () => Promise<T>) => {
    const next = fileChain.then(work, work);
    fileChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const parseLegacy = (raw: string) => {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('session metadata file is not a JSON object');
    const result = new Map<string, Metadata>();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      if (id && isPlainObject(value)) result.set(id, value);
    }
    return result;
  };

  /**
   * Resolves once the legacy file has been read. A read failure rejects and
   * lets the next call retry: writing while the file is unknown could push an
   * older record over one the file still holds, or the file's older record over
   * a newer write later on.
   */
  const loadLegacy = () => {
    if (!legacyLoad) {
      legacyLoad = (async () => {
        let raw;
        try {
          raw = await fsPromises.readFile(legacyPath, 'utf8');
        } catch (error) {
          if ((error as Thrown)?.code === 'ENOENT') return;
          throw new Error(`session metadata is unavailable: ${(error as Thrown)?.message ?? error}`);
        }
        try {
          for (const [id, metadata] of parseLegacy(raw)) unmigrated.set(id, metadata);
        } catch (error) {
          // Unreadable bytes are kept for the user; there is nothing to migrate.
          const backup = `${legacyPath}.corrupt-${now()}`;
          await fsPromises.rename(legacyPath, backup).catch(() => undefined);
          console.warn(`[openchamber-sessions] legacy session metadata was unreadable and was moved to ${backup}: ${(error as Thrown)?.message ?? error}`);
        }
      })().catch((error: unknown) => {
        legacyLoad = null;
        throw error;
      });
    }
    return legacyLoad;
  };

  /** Writes what is left to migrate, or retires the file once nothing is. */
  const persistLegacy = () => runFileWrite(async () => {
    if (unmigrated.size === 0) {
      await fsPromises.rename(legacyPath, `${legacyPath}.migrated`).catch((error: unknown) => {
        if ((error as Thrown)?.code !== 'ENOENT') throw error;
      });
      return;
    }
    const tmpPath = `${legacyPath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(Object.fromEntries(unmigrated)), 'utf8');
    await fsPromises.rename(tmpPath, legacyPath);
  });

  /**
   * Drops a pushed entry from the legacy file. OpenCode already holds the
   * record, so a failed rewrite does not fail the write that caused it. The
   * entry then stays on disk and the next start pushes that older copy again;
   * the next rewrite of the file (any other migrated session) clears it first.
   */
  const forgetLegacy = async (id: string) => {
    unmigrated.delete(id);
    await persistLegacy().catch((error: unknown) => {
      console.warn('[openchamber-sessions] could not update the legacy session metadata file:', (error as Thrown)?.message ?? error);
    });
  };

  /**
   * The session's full metadata: the legacy entry while it is still waiting to
   * be migrated, OpenCode's record otherwise. `{}` for a session OpenCode does
   * not know. Throws when OpenCode could not be asked.
   */
  const get = async (sessionID: unknown, { directory = '' }: { directory?: string } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return {};
    await loadLegacy();
    if (unmigrated.has(id)) return unmigrated.get(id)!;
    return (await openCode.read(id, { directory })) ?? {};
  };

  /**
   * Applies a merge patch on OpenCode and returns the full metadata afterwards.
   * Nothing is written when the current record cannot be read, so a patch never
   * replaces fields it could not see.
   */
  const setSessionMetadata = async (sessionID: unknown, patch: unknown, { directory = '' }: { directory?: string } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (!isPlainObject(patch)) throw new Error('a session metadata patch must be an object');
    await loadLegacy();

    return runForSession(id, async () => {
      const fromLegacy = unmigrated.has(id);
      const current = fromLegacy ? unmigrated.get(id)! : await openCode.read(id, { directory });
      if (current === null) throw new Error(`session ${id} was not found`);
      const merged = mergeMetadataPatch(current, patch);
      await openCode.write(id, merged, { directory });
      if (fromLegacy) await forgetLegacy(id);
      return merged;
    });
  };

  /**
   * Like `setSessionMetadata`, but the patch is decided from the record as it
   * is when this session's turn in the write queue comes: `decide(current)`
   * returns a merge patch, or null to leave the record alone. A writer whose
   * change depends on the current value (open only when not closed after the
   * request) cannot be overtaken between its read and its write this way.
   * Resolves `{ metadata, changed }`.
   */
  const updateSessionMetadata = async (sessionID: unknown, decide: (current: Metadata) => unknown, { directory = '' }: { directory?: string } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    await loadLegacy();

    return runForSession(id, async () => {
      const fromLegacy = unmigrated.has(id);
      const current = fromLegacy ? unmigrated.get(id)! : await openCode.read(id, { directory });
      if (current === null) throw new Error(`session ${id} was not found`);
      const patch = decide(current);
      if (!isPlainObject(patch)) return { metadata: current, changed: false };
      const merged = mergeMetadataPatch(current, patch);
      await openCode.write(id, merged, { directory });
      if (fromLegacy) await forgetLegacy(id);
      return { metadata: merged, changed: true };
    });
  };

  /**
   * Pushes every legacy entry to OpenCode. A session OpenCode no longer knows
   * has nothing to receive its metadata, so its entry is dropped. Any other
   * failure keeps the entry for the next sweep. Resolves the number of entries
   * still waiting.
   */
  const migrateLegacy = async () => {
    await loadLegacy();
    const pending = [...unmigrated.keys()];
    if (pending.length === 0) return 0;
    let changed = false;
    await Promise.all(pending.map((id) => runForSession(id, async () => {
      // A write that ran first already migrated it.
      if (!unmigrated.has(id)) return;
      try {
        await openCode.write(id, unmigrated.get(id)!);
      } catch (error) {
        if (!isSessionNotFound(error)) {
          console.warn(`[openchamber-sessions] could not migrate metadata for ${id}:`, (error as Thrown)?.message ?? error);
          return;
        }
      }
      unmigrated.delete(id);
      changed = true;
    })));
    if (changed) await persistLegacy();
    return unmigrated.size;
  };

  /**
   * `{ [sessionID]: metadata }` for sessions whose metadata still lives in the
   * legacy file. The proxy lays these over OpenCode's records until they are
   * migrated; empty once migration is done.
   */
  const listUnmigrated = async () => {
    await loadLegacy();
    return Object.fromEntries(unmigrated);
  };

  return {
    get,
    setSessionMetadata,
    updateSessionMetadata,
    migrateLegacy,
    listUnmigrated,
    legacyPath,
  };
};
