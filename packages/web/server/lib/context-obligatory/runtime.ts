import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import type { createSessionKnowledgeRuntime } from '../session-knowledge/runtime.js';
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_FETCH_LIMIT = 20;

interface PinnedMessage {
  id: string;
  createdAt: number;
  role: 'user' | 'assistant';
}

interface ContentPart {
  type?: unknown;
  text?: unknown;
}

interface OpenCodeMessage {
  id?: string;
  type?: string;
  status?: string;
  time?: { completed?: number };
}

interface OpenCodeRecord {
  parentID?: unknown;
  data?: OpenCodeMessage[];
  content?: ContentPart[];
  text?: unknown;
}

interface OpenCodeFetchOptions {
  directory?: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
}

type SessionKnowledgeRuntime = Pick<ReturnType<typeof createSessionKnowledgeRuntime>, 'resolvePending' | 'readPins' | 'metadataKey'>;

interface ContextObligatoryRuntimeOptions {
  buildOpenCodeUrl: (path: string, directory: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  sessionKnowledgeRuntime?: SessionKnowledgeRuntime | null;
  persistContextCursor?: ((sessionId: string, directory: string, patch: { openchamber: Record<string, string> }) => Promise<unknown>) | null;
  readSessionMetadata?: ((sessionId: string) => Promise<unknown>) | null;
}

interface ContextPayload {
  type?: string;
  properties?: { sessionID?: unknown; directory?: string };
}

type Thrown = { message?: unknown } | null | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readContextState = (session: { metadata: unknown }) => {
  const metadata = isRecord(session?.metadata) ? session.metadata : {};
  const openchamber = isRecord(metadata.openchamber) ? metadata.openchamber : {};
  const messages = Array.isArray(openchamber.context_obligatory_messages)
    ? openchamber.context_obligatory_messages.filter((item): item is PinnedMessage =>
      isRecord(item)
      && typeof item.id === 'string'
      && typeof item.createdAt === 'number'
      && (item.role === 'user' || item.role === 'assistant'))
    : [];
  return { metadata, openchamber, messages };
};

const buildContextPrompt = (entries: { pinned: PinnedMessage; text: string }[]) => {
  const timeline = entries.map(({ pinned, text }) => {
    const timestamp = new Date(pinned.createdAt).toISOString();
    return `## ${pinned.role} — ${timestamp}\n\n${text}`;
  }).join('\n\n---\n\n');
  return [
    'The following messages are from the compacted conversation. The user explicitly marked them as important and required in your context. Pay close attention to them; they may have been sent by either the user or you before compaction.',
    'Use them while continuing the pre-compaction work. Do not treat this context restoration as a new standalone task.',
    'If any tasks or next steps remain, do not acknowledge, summarize, or mention this restored context in a separate response. Simply continue the work and use it silently as background context. Do not append a recap of it after completing those tasks. Only if no tasks or next steps remain, give the user a very brief summary of the important restored context in no more than one short paragraph, without lists or a detailed recap.',
    '',
    timeline,
  ].join('\n');
};

/**
 * Re-injects the messages the user pinned as obligatory after a compaction.
 *
 * Both the pinned list and the cursor live in OpenChamber's own session
 * metadata store — v2 accepts session metadata only at create time.
 * `readSessionMetadata` reads it and `persistContextCursor` records how far we
 * got; without both seams the runtime stays inert.
 */
export const createContextObligatoryRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  persistContextCursor = null,
  readSessionMetadata = null,
}: ContextObligatoryRuntimeOptions) => {
  const inflight = new Set<string>();
  let stopped = false;

  const openCodeFetch = async (fetchPath: string, { directory, method = 'GET', body, query }: OpenCodeFetchOptions = {}) => {
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const response = await fetch(`${buildOpenCodeUrl(fetchPath, '')}${search ? `?${search}` : ''}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
    return unwrapOpenCodeResponse(await response.json().catch(() => null)) as OpenCodeRecord | null;
  };

  const tick = async (sessionId: string, directory: string) => {
    const session = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
    if (session?.parentID) return;
    // Pins and the cursor are OpenChamber's, not OpenCode's.
    const stored = { metadata: await readSessionMetadata!(sessionId) };
    const state = readContextState(stored);

    /**
     * Project knowledge rides along with the pinned messages. Compaction takes
     * both away, and both are restored for the same reason, so they travel as
     * one message: two synthetic turns back to back would read as the agent
     * being interrupted twice.
     */
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime
        .resolvePending(
          directory,
          // Compaction removed the previously delivered block, so its stored
          // signature is no longer evidence that the session still carries it.
          '',
          sessionKnowledgeRuntime.readPins(stored),
        )
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };

    if (state.messages.length === 0 && !knowledge.text) return;

    const recent = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_FETCH_LIMIT) },
    });
    // v2 pages messages as `{ data, cursor }`, newest first, and a compaction
    // is its own message role rather than an assistant message flagged
    // `summary`.
    const recentMessages = Array.isArray(recent?.data) ? recent.data : [];
    if (recentMessages.length === 0) return;
    const summary = recentMessages.find((message) => message?.type === 'compaction' && message?.status === 'completed');
    if (!summary?.id || !summary?.time?.completed) return;
    if (state.openchamber.context_obligatory_last_compaction_message_id === summary.id) return;

    const fetched = await Promise.allSettled(state.messages.map(async (pinned) => {
      const message = await openCodeFetch(
        `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(pinned.id)}`,
        { directory },
      );
      // A user message carries `text`; an assistant one carries `content[]`.
      const parts = Array.isArray(message?.content)
        ? message.content
        : (typeof message?.text === 'string' ? [{ type: 'text', text: message.text }] : []);
      const text = parts
        .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join('\n\n');
      return { pinned, text };
    }));
    const entries = fetched
      .filter((result) => result.status === 'fulfilled' && result.value.text)
      .map((result) => (result as PromiseFulfilledResult<{ pinned: PinnedMessage; text: string }>).value)
      .sort((left, right) => left.pinned.createdAt - right.pinned.createdAt);
    if (entries.length === 0 && !knowledge.text) return;

    // v2 has no inline synthetic parts, and the model/agent selection lives on
    // the session, so the restored context is simply its own synthetic message.
    await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
      directory,
      method: 'POST',
      body: {
        text: [knowledge.text, entries.length > 0 ? buildContextPrompt(entries) : '']
          .filter(Boolean)
          .join('\n\n---\n\n'),
        resume: false,
      },
    });

    // A merge patch: the store folds this into whatever else the session's
    // `openchamber` namespace holds, so a concurrent goal or assist write is
    // not clobbered.
    const patch: Record<string, string> = { context_obligatory_last_compaction_message_id: summary.id };
    if (knowledge.signature) {
      // Recorded together with the cursor: the session now carries this
      // knowledge again, so the next send must not repeat it.
      patch[sessionKnowledgeRuntime!.metadataKey] = knowledge.signature;
    }
    await persistContextCursor!(sessionId, directory, { openchamber: patch });
  };

  let parkedNoticeLogged = false;
  const processPayload = (payload: ContextPayload | null | undefined, directoryHint = '') => {
    if (stopped) return;
    if (typeof persistContextCursor !== 'function' || typeof readSessionMetadata !== 'function') {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[context-obligatory] parked: no session metadata store is wired, so the compaction cursor cannot be saved');
      }
      return;
    }
    if (payload?.type !== 'session.compacted') return;
    const sessionId = payload?.properties?.sessionID;
    if (typeof sessionId !== 'string' || inflight.has(sessionId)) return;
    const directory = payload?.properties?.directory || directoryHint;
    inflight.add(sessionId);
    return tick(sessionId, directory)
      .catch((error: unknown) => console.warn('[context-obligatory] injection failed:', (error as Thrown)?.message || error))
      .finally(() => inflight.delete(sessionId));
  };

  const stop = () => {
    stopped = true;
  };

  return { processPayload, stop };
};
