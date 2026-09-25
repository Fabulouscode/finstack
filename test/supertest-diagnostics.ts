// Diagnostics for status assertions: supertest's `.expect(status)` reports
// only the status line. Include the body and identifying headers (including
// which test app answered, see createTestApp), so intermittent failures
// explain themselves.

interface DiagnosedResponse {
  text?: string;
  type?: string;
  headers: Record<string, string | undefined>;
}
type AssertStatus = (
  status: number,
  res: DiagnosedResponse,
) => Error | undefined;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Test = require('supertest/lib/test') as {
  prototype: { _assertStatus: AssertStatus };
};
const assertStatus = Test.prototype._assertStatus;

Test.prototype._assertStatus = function (
  this: unknown,
  status: number,
  res: DiagnosedResponse,
): Error | undefined {
  const error = assertStatus.call(this, status, res);
  if (error) {
    error.message +=
      ` [x-test-app: ${res.headers['x-test-app'] ?? 'none'}, x-request-id: ${res.headers['x-request-id'] ?? 'none'}, ` +
      `content-type: ${res.type || 'none'}] ${(res.text ?? '').slice(0, 1_000)}`;
  }
  return error;
};
