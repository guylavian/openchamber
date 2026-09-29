// Runs one refresh per key at a time and bounds how many keys refresh at once.
//
// A request that arrives while a refresh for its key is running does not join
// that run: the run may have read the working tree before the change the
// caller just made. Instead the request waits for one follow-up run that starts
// after the current one finishes, so every caller receives a result at least as
// fresh as its own arrival. All requests that arrive during one run share the
// same follow-up, which caps the work per key at "one running, one pending"
// no matter how many callers ask.

interface Follower<TRequest, TResult> {
  requests: TRequest[];
  execute: (requests: TRequest[]) => Promise<TResult>;
  promise: Promise<TResult>;
  resolve: ((value: TResult) => void) | undefined;
  reject: ((reason?: unknown) => void) | undefined;
}

interface Run<TRequest, TResult> {
  follower: Follower<TRequest, TResult> | null;
}

export interface SerialRefresh<TRequest, TResult> {
  run(key: string, request: TRequest, execute: (requests: TRequest[]) => Promise<TResult>): Promise<TResult>;
  readonly activeKeys: string[];
}

export function createSerialRefresh<TRequest = unknown, TResult = unknown>({ maxConcurrent = Number.POSITIVE_INFINITY }: { maxConcurrent?: number } = {}): SerialRefresh<TRequest, TResult> {
  const runs = new Map<string, Run<TRequest, TResult>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const acquire = () => new Promise<void>((resolve) => {
    if (running < maxConcurrent) {
      running += 1;
      resolve();
      return;
    }
    waiting.push(resolve);
  });

  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    running -= 1;
  };

  const start = (key: string, requests: TRequest[], execute: (requests: TRequest[]) => Promise<TResult>, deferred?: Follower<TRequest, TResult>): Promise<TResult> => {
    const run: Run<TRequest, TResult> = { follower: null };
    runs.set(key, run);
    const promise = (async () => {
      await acquire();
      try {
        return await execute(requests);
      } finally {
        release();
      }
    })();
    if (deferred) {
      promise.then(deferred.resolve, deferred.reject);
    }
    promise
      .catch(() => undefined)
      .then(() => {
        if (runs.get(key) !== run) return;
        if (run.follower) {
          const follower = run.follower;
          start(key, follower.requests, follower.execute, follower);
          return;
        }
        runs.delete(key);
      });
    return promise;
  };

  return {
    /**
     * @template TRequest, TResult
     * @param {string} key
     * @param {TRequest} request
     * @param {(requests: TRequest[]) => Promise<TResult>} execute receives every
     *   request the run answers, so it can widen the work to satisfy all of them
     * @returns {Promise<TResult>}
     */
    run(key, request, execute) {
      const current = runs.get(key);
      if (!current) {
        return start(key, [request], execute);
      }
      if (!current.follower) {
        let resolve: ((value: TResult) => void) | undefined;
        let reject: ((reason?: unknown) => void) | undefined;
        const promise = new Promise<TResult>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        current.follower = { requests: [], execute, promise, resolve, reject };
      }
      current.follower.requests.push(request);
      return current.follower.promise;
    },
    /** Keys with a running or pending refresh. Exposed for tests. */
    get activeKeys() {
      return Array.from(runs.keys());
    },
  };
}
