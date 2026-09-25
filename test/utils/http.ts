import { Response } from 'supertest';

/**
 * Asserts a status and, unlike supertest's `.expect(status)`, includes the
 * response body in the failure message, so intermittent failures explain
 * themselves in CI logs.
 */
export function expectStatus(
  response: Response,
  status: number,
  label = 'request',
): Response {
  if (response.status !== status) {
    throw new Error(
      `Expected HTTP ${status} for ${label}, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response;
}
