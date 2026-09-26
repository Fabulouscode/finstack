import { RequestContext } from '../common/request-context/request-context';
import { AppLogger } from './app-logger';

const jsonLogger = (
  logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info',
): { logger: AppLogger; lines: Record<string, unknown>[] } => {
  const lines: Record<string, unknown>[] = [];
  const logger = new AppLogger(
    {
      logFormat: 'json',
      logLevel,
      metricsEnabled: true,
      metricsToken: null,
    },
    (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  );
  return { logger, lines };
};

describe('AppLogger (json)', () => {
  it('writes one object per line with the request context', () => {
    const { logger, lines } = jsonLogger();
    RequestContext.run({ requestId: 'req-1', traceId: 'a'.repeat(32) }, () => {
      RequestContext.setActor({ type: 'user', id: 'u-1' });
      logger.log('Payment settled', 'PaymentsService');
    });

    expect(lines).toEqual([
      {
        time: expect.any(String) as unknown,
        level: 'info',
        context: 'PaymentsService',
        message: 'Payment settled',
        requestId: 'req-1',
        traceId: 'a'.repeat(32),
        actor: 'user:u-1',
      },
    ]);
  });

  it('keeps error stacks, and drops levels below the minimum', () => {
    const { logger, lines } = jsonLogger('warn');
    logger.log('ignored');
    logger.error('Failed', 'Error: boom\n    at x', 'Worker');

    expect(lines).toEqual([
      expect.objectContaining({
        level: 'error',
        context: 'Worker',
        message: 'Failed',
        stack: 'Error: boom\n    at x',
      }),
    ]);
  });

  it('adds structured fields to events', () => {
    const { logger, lines } = jsonLogger();
    logger.event('info', 'HTTP', 'GET /v1/wallets 200', {
      status: 200,
      durationMs: 3.2,
    });
    expect(lines[0]).toMatchObject({
      context: 'HTTP',
      status: 200,
      durationMs: 3.2,
    });
  });
});
