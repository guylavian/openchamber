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

const textField = z.string().trim().catch('');
const trimmed = (value) => textField.parse(value);

/** Providers whose sessions carry work in a process OpenChamber does not own. */
export const GATEWAY_PROVIDER_IDS = ['claude-code'];

/** How each gateway is named in what a person reads. */
const GATEWAY_LABELS = { 'claude-code': 'Claude Code' };

const gatewayLabel = (providerId) => GATEWAY_LABELS[providerId] || providerId;

/** Readers that throw → undefined; undefined carries that out of the layering. */
const read = async (reader) => {
  let value;
  try {
    value = await reader();
  } catch {
    return undefined;
  }
  return value === null || value === undefined ? undefined : value;
};

/** OpenCode's pending requests, in the vocabulary a run's attention speaks. */
const pendingAttention = (requests) => {
  const list = [];
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
const mapOpenCodeRequests = (requests) => {
  const waiting = pendingAttention(requests);
  if (waiting.length > 0) return { verdict: 'blocked', source: 'opencode', resolvable: true, attention: waiting[0] };
  return { verdict: 'idle', source: 'opencode', resolvable: true };
};

const blocked = (source, attention, resolvable, reason) => ({ verdict: 'blocked', source, resolvable, attention, reason });
const idle = (source) => ({ verdict: 'idle', source, resolvable: true });
const unknown = (source, reason) => ({ verdict: 'unknown', source, resolvable: false, reason });

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
}) => {
  const readExecutionTruth = async ({ sessionId, directory = '' }) => {
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