/**
 * Whether a session's turn has really ended, and what it is holding for the user.
 *
 * A parent session goes idle while a background subagent keeps working in a
 * child session. When the child finishes, OpenCode delivers its result to the
 * parent, which runs again and goes idle a second time. So the parent's first
 * idle is a pause, not the end of the turn: anything that treats idle as
 * "done" (goal audits, ready notifications) has to check the children too.
 *
 * The two requests OpenCode can be holding for a person — a pending permission
 * and an unanswered form — are readable at any time, not only while the event
 * that raised them is being handled. That is what lets a listener that was
 * started late, or restarted, still learn that a session is waiting.
 *
 * Every read answers `null` when OpenCode could not be asked: "could not look"
 * must never pass for "nothing is running".
 */

import { unwrapOpenCodeResponse } from './response-envelope.js';

type OpenCodeRecord = Partial<Record<string, unknown>>;

interface SessionPage {
  data?: (OpenCodeRecord | null | undefined)[];
  cursor?: { next?: string | null } | null;
}

interface SessionForm {
  state?: { status?: unknown } | null;
}

export interface SessionActivityProbeOptions {
  buildOpenCodeUrl: (path: string, prefix: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const CHILDREN_PAGE_SIZE = 50;
const CHILDREN_MAX_PAGES = 8;

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch }: SessionActivityProbeOptions) => {
  const openCodeGet = async (fetchPath: string, query?: Record<string, string>): Promise<unknown> => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const response = await fetchImpl(search ? `${base}?${search}` : base, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`OpenCode GET ${fetchPath} failed with ${response.status}`);
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  /**
   * `/api/session/active` is global and lists only the sessions running right
   * now (`{ data: { [id]: status } }`), so an absent id is idle.
   */
  const fetchActiveSessionStatuses = async (): Promise<OpenCodeRecord | null> => {
    const statuses = await openCodeGet('/api/session/active').catch(() => null);
    return statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? statuses : null;
  };

  /**
   * v2 has no `/session/{id}/children`; `GET /api/session?parentID=` lists a
   * parent's subagent sessions, newest first, in cursor pages. Later pages
   * carry the filter inside the cursor, so only the cursor and the limit
   * travel. A parent with more subagents than this walks is unknown (`null`).
   */
  const fetchChildSessionIds = async (sessionId: string): Promise<string[] | null> => {
    const ids: string[] = [];
    const seenCursors = new Set();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < CHILDREN_MAX_PAGES; pageNumber += 1) {
      const page = await openCodeGet('/api/session', {
        limit: String(CHILDREN_PAGE_SIZE),
        ...(cursor ? { cursor } : { parentID: sessionId }),
      }).catch(() => null) as SessionPage | null;
      if (!Array.isArray(page?.data)) return null;
      for (const child of page.data) {
        if (typeof child?.id === 'string' && child.id) ids.push(child.id);
      }
      const next = page.cursor?.next;
      if (!next || page.data.length === 0 || seenCursors.has(next)) return ids;
      seenCursors.add(next);
      cursor = next;
    }
    return null;
  };

  /** True when a subagent of the session is still running; null when unknown. */
  const hasWorkingChildren = async (sessionId: string, statuses: OpenCodeRecord): Promise<boolean | null> => {
    const children = await fetchChildSessionIds(sessionId);
    if (!children) return null;
    return children.some((id) => Boolean(statuses[id]));
  };

  /**
   * What the session is holding for the user right now: the permissions it has
   * asked for and the forms nobody answered yet. A form that was answered or
   * cancelled is not waiting and is not reported. `null` when OpenCode could
   * not be asked about either.
   */
  const fetchPendingUserRequests = async (sessionId: string): Promise<{ permissions: unknown[]; forms: SessionForm[] } | null> => {
    const path = `/api/session/${encodeURIComponent(sessionId)}`;
    const [permissions, forms] = await Promise.all([
      openCodeGet(`${path}/permission`).catch(() => null),
      openCodeGet(`${path}/form`).catch(() => null),
    ]);
    // A shape this build does not know is a layer it cannot read, not an
    // absence of requests.
    if (!Array.isArray(permissions) || !Array.isArray(forms)) return null;
    return {
      permissions,
      forms: forms.filter((form: SessionForm | null | undefined): form is SessionForm => form?.state?.status === 'pending'),
    };
  };

  return { fetchActiveSessionStatuses, fetchChildSessionIds, hasWorkingChildren, fetchPendingUserRequests };
};
