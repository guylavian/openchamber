import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';
import type { OpenCodeClient, OpenCodeEvent } from '@opencode/client';

declare module 'bun:test' {
  export function it(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void;
}

interface EventTargetExtras {
  visibilityState?: DocumentVisibilityState;
  location?: { href: string; origin: string };
}

interface EventTargetStub extends EventTargetExtras {
  addEventListener: (event: string, handler: () => void) => void;
  removeEventListener: (event: string, handler: () => void) => void;
  dispatch?: (event: string) => void;
}

interface Dispatcher {
  dispatch: (event: string) => void;
}

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;
const savedNavigator = globalThis.navigator;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
  globalThis.navigator = savedNavigator;
});

function createEventTarget(extras: EventTargetExtras = {}): EventTargetStub {
  const listeners = new Map<string, Set<() => void>>();
  return {
    ...extras,
    addEventListener(event: string, handler: () => void) {
      const list = listeners.get(event);
      if (list) list.add(handler);
      else listeners.set(event, new Set([handler]));
    },
    removeEventListener(event: string, handler: () => void) {
      listeners.get(event)?.delete(handler);
    },
    dispatch(event: string) {
      const list = listeners.get(event);
      if (!list) return;
      for (const handler of Array.from(list)) {
        handler();
      }
    },
  };
}

describe('createEventPipeline — permanent server errors', () => {
  it('uses the long backoff cap for 4xx so we do not hammer at 5s intervals', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' }) as Document;
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    }) as Window & typeof globalThis;
    globalThis.navigator = { onLine: true } as Navigator;

    let sdkCallIndex = 0;
    const sdk = {
      event: {
        subscribe: (): AsyncIterable<OpenCodeEvent> => {
          const idx = sdkCallIndex++;
          if (idx <= 1) {
            // First two attempts: permanent 404. Under the old code these
            // would have entered the exponential path and the second retry
            // would fire after ~250-500ms. With the permanent-error override
            // both go to the long (60s) cap, so the test should observe
            // exactly one retry (after `online` interrupts) within its
            // observation window.
            const error: Error & { status?: number } = new Error('Not Found');
            error.status = 404;
            throw error;
          }
          return (async function* (): AsyncGenerator<OpenCodeEvent> {
              yield { id: 'evt_1', created: 1000, location: { directory: '/repo' }, type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } };
              await new Promise(() => {});
            })();
        },
      },
    } as OpenCodeClient;

    const startedAt = Date.now();
    let cleanupFn = () => {};

    // Phase 1: let the first 404 fire and verify the loop is NOT spinning.
    // If the permanent-error override is broken, the loop would retry every
    // 250-500ms and sdkCallIndex would climb past 1.
    await new Promise<void>((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onDisconnect: () => {
          // Wait 250ms after disconnect — long enough that the broken
          // exponential path would have retried at least once. If our
          // override works, sdkCallIndex stays at 1.
          setTimeout(resolve, 250);
        },
      });
      cleanupFn = cleanup;
    });

    expect(sdkCallIndex).toBe(1);

    // Phase 2: fire `online` to interrupt the long wait. Loop should fire
    // the second attempt (still 404) immediately, then the third attempt
    // which succeeds.
    const recovered = new Promise<void>((resolve) => {
      // Trigger an `online` event; waitForRetry's interrupter resolves and
      // the next attempt fires. That attempt is also a 404 (idx=1), then
      // another `online` advances us to the success path (idx=2).
      const advance = () => {
        (globalThis.window as Window & typeof globalThis & Dispatcher).dispatch('online');
      };
      advance();
      const t = setInterval(() => {
        if (sdkCallIndex >= 3) {
          clearInterval(t);
          resolve();
        } else {
          advance();
        }
      }, 50);
    });

    await recovered;
    cleanupFn();

    expect(sdkCallIndex).toBeGreaterThanOrEqual(3);
    // Total elapsed should be < 2s — well under the 60s cap that proves the
    // interrupters work for permanent-error retries too.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('retries 408 and 429 on the normal exponential path (not the permanent cap)', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' }) as Document;
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    }) as Window & typeof globalThis;
    globalThis.navigator = { onLine: true } as Navigator;

    let sdkCallIndex = 0;
    const sdk = {
      event: {
        subscribe: (): AsyncIterable<OpenCodeEvent> => {
          const idx = sdkCallIndex++;
          if (idx === 0) {
            const error: Error & { status?: number } = new Error('Rate limited');
            error.status = 429;
            throw error;
          }
          return (async function* (): AsyncGenerator<OpenCodeEvent> {
              yield { id: 'evt_1', created: 1000, location: { directory: '/repo' }, type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } };
              await new Promise(() => {});
            })();
        },
      },
    } as OpenCodeClient;

    const startedAt = Date.now();
    const elapsed = await new Promise<number>((resolve) => {
      let connects = 0;
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onReconnect: () => {
          connects += 1;
          if (connects === 1) {
            cleanup();
            resolve(Date.now() - startedAt);
          }
        },
      });
    });

    // 429 went through computeRetryDelay (consecutiveFailures=1) -> 250ms,
    // not the 60s permanent cap. Recovery should be sub-second.
    expect(sdkCallIndex).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
  });
});
