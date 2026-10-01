/**
 * `finstack listen` polls each provider's API for new events and delivers
 * them to a local FinStack as signed webhooks: no tunnel, no public URL, no
 * dashboard setup. Safe because FinStack treats a webhook only as a hint and
 * re-checks every payment, refund and payout with the provider before moving
 * money.
 */

export type FetchFn = typeof fetch;

/** One event, ready to POST to FinStack's webhook endpoint. */
export interface Delivery {
  /** Unique per record and state: a delivered key is never sent again. */
  key: string;
  provider: string;
  /** The provider's event name, for the log. */
  type: string;
  /** Our reference (payment, refund or payout), for the log. */
  reference: string;
  body: string;
  headers: Record<string, string>;
}

export interface EventSource {
  readonly provider: string;
  /** Events for records created at or after `since`, oldest first. */
  poll(since: Date): Promise<Delivery[]>;
}

/** GETs JSON, failing with the provider's own message on errors. */
export async function getJson<T>(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetchFn(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    // Reported below with the status.
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String(body.message)
        : body && typeof body === 'object' && 'error' in body
          ? JSON.stringify(body.error)
          : text.slice(0, 200);
    throw new Error(
      `HTTP ${response.status} from ${new URL(url).host}: ${message}`,
    );
  }
  return body as T;
}
