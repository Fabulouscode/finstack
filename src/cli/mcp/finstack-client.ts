/** FinStack's REST API as one organization's API key sees it. */
export interface FinStackClientOptions {
  baseUrl: string;
  apiKey: string;
  organizationId: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class FinStackApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'FinStackApiError';
  }
}

export class FinStackClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: FinStackClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** A path under the organization, e.g. org('/wallets'). */
  org(path: string): string {
    return `/v1/organizations/${encodeURIComponent(this.options.organizationId)}${path}`;
  }

  get<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<T>('GET', `${path}${search}`);
  }

  post<T>(path: string, body: object): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': this.options.apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const problem = (parsed ?? {}) as {
        code?: string;
        detail?: string;
        title?: string;
      };
      throw new FinStackApiError(
        response.status,
        problem.code,
        problem.detail ?? problem.title ?? `HTTP ${response.status}`,
      );
    }
    return parsed as T;
  }
}
