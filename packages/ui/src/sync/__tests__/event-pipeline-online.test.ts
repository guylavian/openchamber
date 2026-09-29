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

// Multi-listener event-target stub. The simpler single-slot stub used in
// event-pipeline-resume.test.js would break here because waitForRetry and the
// top-level onOnline handler both register for `online`.
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

describe('createEventPipeline — online event', () => {
  it('cuts the inter-attempt wait short when `online` fires after disconnect', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' }) as Document;
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    }) as Window & typeof globalThis;
    globalThis.navigator = { onLine: false } as Navigator;

    let sdkCallIndex = 0;
    const sdk = {
      event: {
        subscribe: (): AsyncIterable<OpenCodeEvent> => {
          const idx = sdkCallIndex++;
          if (idx === 0) {
            // Force a real failure so the loop enters the offline backoff path
            // (computeRetryDelay returns the long cap because navigator.onLine
            // is false). Without our `online` interrupt this would wait the
            // full hidden/offline cap of 60s and the test would time out.
            throw new Error('simulated network error');
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
        onDisconnect: () => {
          // We're now inside waitForRetry on the long offline cap.
          // Flip the browser back online and fire the event; waitForRetry
          // should resolve early and the next attempt should fire.
          setTimeout(() => {
            globalThis.navigator = { onLine: true } as Navigator;
            (globalThis.window as Window & typeof globalThis & Dispatcher).dispatch('online');
          }, 30);
        },
        onReconnect: () => {
          connects += 1;
          if (connects === 1) {
            cleanup();
            resolve(Date.now() - startedAt);
          }
        },
      });
    });

    // Two attempts: the failed one + the recovery one. If the `online`
    // interrupt didn't fire, the test would have hung on the 60s offline cap.
    expect(sdkCallIndex).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
  });
});
