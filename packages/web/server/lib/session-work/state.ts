/**
 * `metadata.openchamber.work`: whether a session is in work and what Jev
 * currently suggests about it. Every function returns a JSON merge patch for
 * the session metadata store, or null when nothing changes, so the store can
 * decide against the record as it is at write time.
 *
 * The rule the patches keep: Jev only ever opens, the user alone closes. Jev
 * may reopen a session the user closed, but only for a request sent after the
 * user closed it.
 */
import { z } from 'zod';

const workSchema = z.object({
  state: z.enum(['open', 'done']),
  openedAt: z.number().optional(),
  openedBy: z.enum(['jev', 'user']).optional(),
  doneAt: z.number().optional(),
  suggestDoneAt: z.number().optional(),
});

type Work = z.infer<typeof workSchema>;

const metadataSchema = z.object({ openchamber: z.object({ work: workSchema }) });

/** The session's work record, or null when it has none (or a malformed one). */
export const readWork = (metadata: unknown): Work | null => metadataSchema.safeParse(metadata).data?.openchamber.work ?? null;

type WorkPatchData = {
  state?: 'open' | 'done';
  openedAt?: number | null;
  openedBy?: 'jev' | 'user' | null;
  doneAt?: number | null;
  suggestDoneAt?: number | null;
};

type WorkPatch = { openchamber: { work: WorkPatchData } };

const patchOf = (work: WorkPatchData): WorkPatch => ({ openchamber: { work } });

interface WorkOptions {
  requestAt: number;
  now: number;
}

interface SuggestOptions {
  now: number;
}

/** Jev saw a request that starts work, sent at `requestAt`. */
export const openByJevPatch = (metadata: unknown, { requestAt, now }: WorkOptions): WorkPatch | null => {
  const work = readWork(metadata);
  if (work?.state === 'open') return null;
  // Closed after this request was sent: the user's decision stands.
  if (work?.state === 'done' && Number.isFinite(requestAt) && (work.doneAt ?? 0) >= requestAt) return null;
  return patchOf({ state: 'open', openedAt: now, openedBy: 'jev', doneAt: null, suggestDoneAt: null });
};

/** The turn that just ended looks like the end of the work. */
export const suggestDonePatch = (metadata: unknown, { now }: SuggestOptions): WorkPatch | null => {
  if (readWork(metadata)?.state !== 'open') return null;
  return patchOf({ suggestDoneAt: now });
};

/** A new turn started: whatever Jev concluded about the last one no longer holds. */
export const clearSuggestionPatch = (metadata: unknown): WorkPatch | null => {
  const work = readWork(metadata);
  if (!work || work.suggestDoneAt === undefined) return null;
  return patchOf({ suggestDoneAt: null });
};
