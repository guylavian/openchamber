/**
 * Execution truth: what is really happening to a run's session.
 *
 * A Run's status has to describe the execution, not the outer turn. For an
 * ordinary OpenCode session those are the same thing: OpenCode asks for its own
 * permissions and forms, raises `permission.asked` / `form.created`, and only
 * then reports the turn as finished.
 *
 * A gateway-carried session is not the same thing. OpenCode's `claude-code`
 * provider is a gateway — it drives the local `claude` CLI, which brings its
 * own tools and settles its own permissions. OpenCode's event vocabulary has
 * exactly two channels for "the user is needed", and neither is ever raised
 * for a Claude Code decision, so such a request cannot become a `permission.
 * asked`. The outer turn can report success while the CLI is still holding the
 * question, and treating that as completion is how a blocked run used to look
 * finished.
 *
 * So each layer is read through the thing that owns it:
 *
 *   OpenCode      pending permissions and unanswered forms, which it owns and
 *                 which a person settles in the UI — resolvable from here.
 *   Claude Code   its own durable transcript, where an assistant `tool_use`
 *                 with no matching `tool_result` is Claude Code's own record
 *                 of a call nobody answered. OpenChamber has no route into
 *                 that decision, so a run stopped there says so instead of
 *                 offering a button that cannot work.
 *
 * Every reader answers `null` when its layer could not be read, and `unknown`
 * is never `clear`: a session nobody can see into is not a finished session.
 * Guessing from silence — a stream that stopped moving — is exactly the guess
 * this module exists to refuse.
 */

import { z } from 'zod';

import type { Attention } from './types.js';

const textField = z.string().trim().catch('');
const trimmed = (value: unknown): string => textField.parse(value);

// What the readers hand back, as this module has always read them. The
// shapes describe that contract; nothing here checks them at run time.
type Maybe<Value> = Value | null | undefined;
type Awaitable<Value> = Value | Promise<Value>;
interface PendingRequests {
  permissions?: Maybe<Iterable<Maybe<{ message?: unknown; action?: unknown }>>>;
  forms?: Maybe<Iterable<Maybe<{ title?: unknown }>>>;
}
interface SessionReading {
  model?: Maybe<{ providerID?: unknown }>;
}
interface GatewayReading {
  blockers?: Maybe<ArrayLike<unknown>>;
}
interface SessionLocation {
  sessionId: string;
  directory?: string;
}

export type ExecutionTruth =
  // `attention` is always present; it holds the first pending request, which
  // the checker cannot prove exists behind `waiting.length > 0`.
  | { verdict: 'blocked'; source: string; resolvable: boolean; attention: Attention | undefined; reason?: string | undefined }
  | { verdict: 'idle'; source: string; resolvable: true }
  | { verdict: 'unknown'; source: string; resolvable: false; reason: string };

export interface ExecutionTruthReaders {
  readPendingRequests?: Maybe<(location: { sessionId: string; directory: string }) => Awaitable<Maybe<PendingRequests>>>;
  readSession?: Maybe<(location: { sessionId: string; directory: string }) => Awaitable<Maybe<SessionReading>>>;
  readGatewayBlockers?: Maybe<(location: { sessionId: string; directory: string; providerId: string; session: SessionReading | undefined }) => Awaitable<Maybe<GatewayReading>>>;
  gatewayProviders?: readonly string[];
}

/** Providers whose sessions carry work in a process OpenChamber does not own. */
export const GATEWAY_PROVIDER_IDS: string[] = ['claude-code'];

/** How each gateway is named in what a person reads. */
const GATEWAY_LABELS: Partial<Record<string, string>> = { 'claude-code': 'Claude Code' };

const gatewayLabel = (providerId: string): string => GATEWAY_LABELS[providerId] || providerId;

/** Readers that throw → undefined; undefined carries that out of the layering. */
const read = async <Value>(reader: () => Awaitable<Value>): Promise<NonNullable<Value> | undefined> => {
  let value: Value;
  try {
    value = await reader();
  } catch {
    return undefined;
  }
  return value === null || value === undefined ? undefined : value;
};

/** OpenCode's pending requests, in the vocabulary a run's attention speaks. */
const pendingAttention = (requests: PendingRequests): Attention[] => {
  const list: Attention[] = [];
  for (const permission of requests.permissions ?? []) {
    const message = trimmed(permission?.message) || trimmed(permission?.action);
    list.push({ type: 'permission', ...(message ? { message } : {}) });
  }
  for (const form of requests.forms ?? []) {
    const message = trimmed(form?.title);
    list.push({ type: 'question', ...(message ? { message } : {}) });
  }
  return list;
};

/** Map OpenCode pending requests → verdict, or idle when none waiting. */
const mapOpenCodeRequests = (requests: PendingRequests): ExecutionTruth => {
  const waiting = pendingAttention(requests);
  if (waiting.length > 0) return { verdict: 'blocked', source: 'opencode', resolvable: true, attention: waiting[0] };
  return { verdict: 'idle', source: 'opencode', resolvable: true };
};

const blocked = (source: string, attention: Attention, resolvable: boolean, reason?: string): ExecutionTruth => ({ verdict: 'blocked', source, resolvable, attention, reason });
const idle = (source: string): ExecutionTruth => ({ verdict: 'idle', source, resolvable: true });
const unknown = (source: string, reason: string): ExecutionTruth => ({ verdict: 'unknown', source, resolvable: false, reason });

/**
 * Decides what a session is really doing, reading each layer through its owner.
 *
 * @param {{readPendingRequests, readSession, readGatewayBlockers, gatewayProviders}} deps
 * @returns {{readExecutionTruth: function}} → ({sessionId, directory}) → verdict object
 */
export const createExecutionTruthProbe = ({
  readPendingRequests,
  readSession,
  readGatewayBlockers,
  gatewayProviders = GATEWAY_PROVIDER_IDS,
}: ExecutionTruthReaders): { readExecutionTruth: (location: SessionLocation) => Promise<ExecutionTruth> } => {
  const readExecutionTruth = async ({ sessionId, directory = '' }: SessionLocation): Promise<ExecutionTruth> => {
    // 1. OpenCode's own requests — a person can settle these, outranking underneath.
    const requests = await read(() => readPendingRequests ? readPendingRequests({ sessionId, directory }) : undefined);
    if (requests !== undefined) {
      const mapResult = mapOpenCodeRequests(requests);
      if (mapResult.verdict !== 'idle') return mapResult;
    }

    // 2. If no further readers are available, we are idle (no hidden blockers).
    if (!readSession && !readGatewayBlockers) return idle('no-further-layers');

    // 3. Which model carries this session.
    const session = await read(() => readSession ? readSession({ sessionId, directory }) : undefined);
    const providerId = session?.model?.providerID ? trimmed(session.model.providerID) : undefined;
    if (!providerId) return unknown('opencode', 'cannot determine model');

    // 4. Non-gateway sessions: assume idle (existing behaviour preserved).
    if (!gatewayProviders.includes(providerId)) return idle(providerId);

    // 5. Gateway session (claude-code): check its own layer.
    const gateway = await read(() => readGatewayBlockers ? readGatewayBlockers({ sessionId, directory, providerId, session }) : undefined);
    if (gateway === undefined || gateway?.blockers == null) {
      return unknown(
        providerId,
        `${gatewayLabel(providerId)} runs this session, and OpenChamber cannot see whether it is waiting for you`,
      );
    }
    if (gateway.blockers.length === 0) return idle(providerId);
    return blocked(
      providerId,
      { type: 'permission', message: `${gatewayLabel(providerId)} requires permission: ${gateway.blockers[0]}` },
      false,
      'This decision belongs to Claude Code, not to OpenChamber; answer it there',
    );
  };

  return { readExecutionTruth };
};