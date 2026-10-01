import { Delivery, EventSource, FetchFn } from './event-source';

/** A delivery FinStack keeps refusing is dropped after this many tries. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface ListenerOptions {
  sources: EventSource[];
  /** FinStack's base URL, e.g. http://localhost:3000. */
  forwardTo: string;
  /** Only records created since then are looked at. */
  since: Date;
  /** Also deliver events that already existed when the listener started. */
  replay: boolean;
  fetchFn: FetchFn;
  log: (line: string) => void;
}

/**
 * Polls every source and POSTs new events to FinStack's webhook endpoint
 * (`/v1/webhooks/:provider`). Each event is delivered once: on start the
 * events that already exist are only noted (unless replaying), and failed
 * deliveries are retried on later polls, up to MAX_DELIVERY_ATTEMPTS.
 */
export class Listener {
  private readonly delivered = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly lastError = new Map<string, string>();
  private started = false;

  constructor(private readonly options: ListenerOptions) {}

  /** One round: poll every source and deliver what is new. */
  async tick(): Promise<void> {
    const baseline = !this.started && !this.options.replay;
    this.started = true;

    for (const source of this.options.sources) {
      let deliveries: Delivery[];
      try {
        deliveries = await source.poll(this.options.since);
        this.lastError.delete(source.provider);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Said once, not on every poll.
        if (this.lastError.get(source.provider) !== message) {
          this.options.log(`! ${source.provider}: ${message}`);
          this.lastError.set(source.provider, message);
        }
        continue;
      }

      for (const delivery of deliveries) {
        if (this.delivered.has(delivery.key)) continue;
        if (baseline) {
          this.delivered.add(delivery.key);
          continue;
        }
        await this.deliver(delivery);
      }
    }
  }

  private async deliver(delivery: Delivery): Promise<void> {
    const url = `${this.options.forwardTo}/v1/webhooks/${delivery.provider}`;
    const label = `${delivery.provider} ${delivery.type} ${delivery.reference}`;
    let outcome: string;
    let ok = false;
    try {
      const response = await this.options.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...delivery.headers },
        body: delivery.body,
        signal: AbortSignal.timeout(10_000),
      });
      ok = response.ok;
      outcome = String(response.status);
      if (!ok) {
        const text = await response.text();
        outcome += ` ${text.slice(0, 200)}`;
      }
    } catch (error) {
      outcome = `not delivered: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (ok) {
      this.delivered.add(delivery.key);
      this.attempts.delete(delivery.key);
      this.options.log(`→ ${label}  [${outcome}]`);
      return;
    }
    const attempts = (this.attempts.get(delivery.key) ?? 0) + 1;
    this.attempts.set(delivery.key, attempts);
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.delivered.add(delivery.key);
      this.options.log(
        `✗ ${label}  [${outcome}] (giving up after ${attempts} tries)`,
      );
    } else {
      this.options.log(`✗ ${label}  [${outcome}] (will retry)`);
    }
  }
}
