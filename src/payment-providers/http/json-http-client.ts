import { Injectable } from '@nestjs/common';
import { PaymentProviderError } from '../payment-provider';

/** The transport; tests pass a fake to exercise adapters without the network. */
export type FetchFn = typeof fetch;

export interface JsonRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: object;
  /** Sent as application/x-www-form-urlencoded (e.g. Stripe). */
  form?: Record<string, string>;
  timeoutMs: number;
}

export interface JsonResponse<T> {
  status: number;
  body: T;
}

/**
 * Minimal JSON client for provider APIs. Classifies failures the way the
 * payment layer needs them:
 * - network errors, timeouts, 5xx and 429 -> retryable (outcome unknown)
 * - other 4xx -> not retryable (the provider rejected the request)
 */
@Injectable()
export class JsonHttpClient {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async request<T>(request: JsonRequest): Promise<JsonResponse<T>> {
    let response: Response;
    try {
      response = await this.fetchFn(request.url, {
        method: request.method,
        headers: {
          Accept: 'application/json',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
          ...(request.form
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
          ...request.headers,
        },
        body: request.form
          ? new URLSearchParams(request.form).toString()
          : request.body
            ? JSON.stringify(request.body)
            : undefined,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      // Includes timeouts: the provider may or may not have acted.
      throw new PaymentProviderError(
        `Request failed: ${describe(error)}`,
        true,
      );
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      throw new PaymentProviderError(
        `Non-JSON response (HTTP ${response.status})`,
        response.status >= 500,
      );
    }

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      throw new PaymentProviderError(
        `HTTP ${response.status}: ${providerMessage(body)}`,
        retryable,
      );
    }
    return { status: response.status, body: body as T };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timed out' : error.message;
  }
  return String(error);
}

/** `{ message }` (Paystack) or `{ error: { message } }` (Stripe). */
function providerMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return 'no message';
  if ('message' in body) {
    return String(body.message).slice(0, 300);
  }
  if (
    'error' in body &&
    body.error &&
    typeof body.error === 'object' &&
    'message' in body.error
  ) {
    return String(body.error.message).slice(0, 300);
  }
  return 'no message';
}
