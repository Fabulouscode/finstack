import { AsyncLocalStorage } from 'node:async_hooks';

/** Who is acting in the current request (set once authenticated). */
export type Actor =
  | { type: 'user'; id: string }
  | { type: 'api_key'; id: string; organizationId: string }
  | { type: 'system' };

export interface RequestContextStore {
  requestId: string;
  /** W3C trace id (from `traceparent`, or new), to join logs with traces. */
  traceId?: string;
  ipAddress?: string;
  actor?: Actor;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Per-request context propagated through async calls, so deeply nested code
 * (services, repositories, loggers) can read the request ID and the acting
 * principal without them being threaded through every function signature.
 */
export const RequestContext = {
  run<T>(store: RequestContextStore, callback: () => T): T {
    return storage.run(store, callback);
  },

  current(): RequestContextStore | undefined {
    return storage.getStore();
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  traceId(): string | undefined {
    return storage.getStore()?.traceId;
  },

  /** Records the authenticated principal; no-op outside a request. */
  setActor(actor: Actor): void {
    const store = storage.getStore();
    if (store) {
      store.actor = actor;
    }
  },

  /** The acting principal; background work (workers, jobs) is `system`. */
  actor(): Actor {
    return storage.getStore()?.actor ?? { type: 'system' };
  },
};
