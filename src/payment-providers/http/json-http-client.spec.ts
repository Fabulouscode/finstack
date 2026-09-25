import { PaymentProviderError } from '../payment-provider';
import { FetchFn, JsonHttpClient } from './json-http-client';

const respond =
  (status: number, body: string): FetchFn =>
  () =>
    Promise.resolve(new Response(body, { status }));

const request = {
  method: 'GET' as const,
  url: 'https://api.example.test/x',
  timeoutMs: 1_000,
};

async function failure(fetchFn: FetchFn): Promise<PaymentProviderError> {
  const error = await new JsonHttpClient(fetchFn)
    .request(request)
    .catch((e: unknown) => e);
  if (!(error instanceof PaymentProviderError))
    throw new Error('expected PaymentProviderError');
  return error;
}

describe('JsonHttpClient', () => {
  it('returns parsed JSON for 2xx', async () => {
    const client = new JsonHttpClient(respond(200, '{"ok":true}'));

    await expect(client.request(request)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it.each([
    [400, false],
    [401, false],
    [404, false],
    [422, false],
    [429, true],
    [500, true],
    [503, true],
  ])('classifies HTTP %i as retryable=%s', async (status, retryable) => {
    const error = await failure(respond(status, '{"message":"nope"}'));

    expect(error.retryable).toBe(retryable);
    expect(error.message).toContain(`HTTP ${status}: nope`);
  });

  it('treats network errors and timeouts as retryable (the outcome is unknown)', async () => {
    const network = await failure(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const timeout = await failure(() =>
      Promise.reject(
        Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
      ),
    );

    expect(network).toMatchObject({ retryable: true });
    expect(timeout).toMatchObject({
      retryable: true,
      message: 'Request failed: timed out',
    });
  });

  it('treats a non-JSON 502 from a proxy as retryable, and a non-JSON 200 as not', async () => {
    expect(
      (await failure(respond(502, '<html>Bad gateway</html>'))).retryable,
    ).toBe(true);
    expect((await failure(respond(200, 'not json'))).retryable).toBe(false);
  });
});
