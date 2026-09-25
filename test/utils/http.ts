import { Response } from 'supertest';

/**
 * Asserts a status and, unlike supertest's `.expect(status)`, includes the
 * response in the failure message, so intermittent failures explain
 * themselves in CI logs. Non-JSON bodies (e.g. from a proxy or Express's
 * default error handler) are shown as raw text.
 */
export function expectStatus(
  response: Response,
  status: number,
  label = 'request',
): Response {
  if (response.status !== status) {
    const body =
      response.text && !response.type.includes('json')
        ? response.text.slice(0, 2_000)
        : JSON.stringify(response.body);
    throw new Error(
      `Expected HTTP ${status} for ${label}, got ${response.status} ` +
        `(content-type: ${response.type || 'none'}, x-request-id: ${String(response.headers['x-request-id'])}, ` +
        `x-test-app: ${String(response.headers['x-test-app'])}): ${body}`,
    );
  }
  return response;
}
