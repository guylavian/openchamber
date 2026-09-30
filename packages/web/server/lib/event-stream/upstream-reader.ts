import { parseSseEventEnvelope } from './protocol.js';
import type { SseEventEnvelope } from './protocol.js';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

type TimeoutSource = number | (() => number);

/** One parsed event the reader hands to `onEvent`. */
export interface UpstreamSseEvent {
  block: string;
  envelope: SseEventEnvelope;
  payload: SseEventEnvelope['payload'];
  eventId: string | null;
  directory: string | null;
}

/** Why a connection attempt failed: no usable response, or the stream broke. */
export type UpstreamSseError =
  | { type: 'upstream_unavailable'; status: number; response: Response }
  | { type: 'stream_error'; error: unknown };

export interface UpstreamSseReaderOptions {
  buildUrl: () => URL;
  getHeaders?: (() => unknown) | undefined;
  fetchImpl?: typeof fetch | undefined;
  parseBlock?: ((block: string) => SseEventEnvelope | null) | undefined;
  initialLastEventId?: unknown;
  signal?: AbortSignal | undefined;
  stallTimeoutMs?: TimeoutSource | undefined;
  reconnectDelayMs?: TimeoutSource | undefined;
  onEvent?: ((event: UpstreamSseEvent) => void) | undefined;
  onConnect?: ((info: { response: Response; lastEventId: string }) => void) | undefined;
  onDisconnect?: ((info: { reason: string }) => void) | undefined;
  onError?: ((error: UpstreamSseError) => void) | undefined;
}

export const DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000;
export const UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS * 3;
export const DEFAULT_UPSTREAM_RECONNECT_DELAY_MS = 250;

function resolveTimeoutMs(value: TimeoutSource, fallback: number) {
  const resolved = typeof value === 'function' ? value() : value;
  return Number.isFinite(resolved) ? resolved : fallback;
}

function waitForReconnectDelay(ms: number, signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  return { ...headers };
}

async function cancelResponseBody(response: Response) {
  if (response?.body && typeof response.body.cancel === 'function') {
    await response.body.cancel().catch(() => {});
  }
}

export function createUpstreamSseReader({
  buildUrl,
  getHeaders = () => ({}),
  fetchImpl = fetch,
  parseBlock = parseSseEventEnvelope,
  initialLastEventId = '',
  signal,
  stallTimeoutMs = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  reconnectDelayMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  onEvent,
  onConnect,
  onDisconnect,
  onError,
}: UpstreamSseReaderOptions) {
  let running: Promise<void> | null = null;
  let stopped = false;
  let activeController: AbortController | null = null;
  let lastEventId = typeof initialLastEventId === 'string' ? initialLastEventId : '';
  let stopListenerAttached = false;

  function detachStopListener() {
    if (!stopListenerAttached) return;
    signal?.removeEventListener('abort', stop);
    stopListenerAttached = false;
  }

  function attachStopListener() {
    if (!signal || signal.aborted || stopListenerAttached) return;
    signal.addEventListener('abort', stop, { once: true });
    stopListenerAttached = true;
  }

  function stop() {
    stopped = true;
    detachStopListener();
    if (activeController && !activeController.signal.aborted) {
      activeController.abort();
    }
  }

  const start = () => {
    if (running) {
      return running;
    }

    attachStopListener();
    stopped = false;
    running = (async () => {
      while (!stopped && !signal?.aborted) {
        const controller = new AbortController();
        activeController = controller;
        const abortActive = () => controller.abort();
        signal?.addEventListener('abort', abortActive, { once: true });

        let abortReason: string | null = null;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const clearStallTimer = () => {
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
        };
        const resetStallTimer = () => {
          clearStallTimer();
          const currentStallTimeoutMs = resolveTimeoutMs(stallTimeoutMs, DEFAULT_UPSTREAM_STALL_TIMEOUT_MS);
          if (currentStallTimeoutMs <= 0) {
            return;
          }

          stallTimer = setTimeout(() => {
            abortReason = 'upstream_stalled';
            controller.abort();
          }, currentStallTimeoutMs);
        };

        try {
          const url = buildUrl();
          const headers: Record<string, string> = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...normalizeHeaders(getHeaders()),
          };
          if (lastEventId) {
            headers['Last-Event-ID'] = lastEventId;
          }

          const response = await fetchImpl(url.toString(), {
            headers,
            signal: controller.signal,
          });

          if (!response?.ok || !response.body) {
            onError?.({
              type: 'upstream_unavailable',
              status: response?.status ?? 0,
              response,
            });
            await cancelResponseBody(response);
            await waitForReconnectDelay(resolveTimeoutMs(reconnectDelayMs, DEFAULT_UPSTREAM_RECONNECT_DELAY_MS), signal);
            continue;
          }

          onConnect?.({ response, lastEventId });

          const decoder = new TextDecoder();
          const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
          let buffer = '';

          resetStallTimer();

          while (!stopped && !signal?.aborted) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }

            resetStallTimer();
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

            let separatorIndex = buffer.indexOf('\n\n');
            while (separatorIndex !== -1 && !stopped && !signal?.aborted) {
              const block = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              const envelope = parseBlock(block);
              if (envelope?.payload) {
                if (typeof envelope.eventId === 'string' && envelope.eventId.length > 0) {
                  lastEventId = envelope.eventId;
                }
                onEvent?.({
                  block,
                  envelope,
                  payload: envelope.payload,
                  eventId: envelope.eventId,
                  directory: envelope.directory,
                });
              }
              separatorIndex = buffer.indexOf('\n\n');
            }
          }

          if (!stopped && !signal?.aborted && buffer.trim().length > 0) {
            const block = buffer.trim();
            const envelope = parseBlock(block);
            if (envelope?.payload) {
              if (typeof envelope.eventId === 'string' && envelope.eventId.length > 0) {
                lastEventId = envelope.eventId;
              }
              onEvent?.({
                block,
                envelope,
                payload: envelope.payload,
                eventId: envelope.eventId,
                directory: envelope.directory,
              });
            }
          }
        } catch (error) {
          if (!stopped && !signal?.aborted && abortReason !== 'upstream_stalled') {
            onError?.({
              type: 'stream_error',
              error,
            });
          }
        } finally {
          clearStallTimer();
          signal?.removeEventListener('abort', abortActive);
          if (activeController === controller) {
            activeController = null;
          }
          onDisconnect?.({ reason: abortReason ?? (stopped || signal?.aborted ? 'stopped' : 'closed') });
        }

        if (!stopped && !signal?.aborted) {
          // A function is read before every wait, so a caller can back off between attempts.
          await waitForReconnectDelay(resolveTimeoutMs(reconnectDelayMs, DEFAULT_UPSTREAM_RECONNECT_DELAY_MS), signal);
        }
      }
    })().finally(() => {
      detachStopListener();
      running = null;
    });

    return running;
  };

  return {
    start,
    stop,
    getLastEventId() {
      return lastEventId;
    },
  };
}
