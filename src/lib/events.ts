import { logger } from "./logger";

/**
 * Tiny typed in-process event bus. The alerts feature subscribes here to
 * fan events out to Slack; emitters never know or care who listens.
 * Listener errors are logged and swallowed - an alert sink failing must
 * never break a sync.
 */

export interface AppEvents {
  /** A connected connector has had no successful sync for too long (spec 5). */
  "connector.silent": {
    vendor: string;
    /** Last successful sync finish, ISO; null = never synced since connect. */
    lastSuccessAt: string | null;
    /** The threshold that tripped, hours (connector_silent_alert_hours). */
    thresholdHours: number;
  };
}

export type AppEventName = keyof AppEvents;

type Listener<K extends AppEventName> = (payload: AppEvents[K]) => void | Promise<void>;

const listeners = new Map<AppEventName, Set<Listener<AppEventName>>>();

export function onEvent<K extends AppEventName>(
  event: K,
  listener: Listener<K>,
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener as Listener<AppEventName>);
  return () => set.delete(listener as Listener<AppEventName>);
}

export function emitEvent<K extends AppEventName>(
  event: K,
  payload: AppEvents[K],
): void {
  logger.info("event emitted", { event, ...payload });
  for (const listener of listeners.get(event) ?? []) {
    try {
      void Promise.resolve(listener(payload)).catch((err) => {
        logger.error("event listener failed", { event, error: err });
      });
    } catch (err) {
      logger.error("event listener failed", { event, error: err });
    }
  }
}

/** Test-only: drop all listeners between test files. */
export function clearEventListeners(): void {
  listeners.clear();
}
