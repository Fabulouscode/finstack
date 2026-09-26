import { NextFunction, Request, Response } from 'express';
import { AppLogger } from './app-logger';
import { MetricsService } from './metrics.service';

/** Probes and scrapes are high-volume noise in logs and request metrics. */
const QUIET = /^\/(health|metrics)(\/|$)/;

/**
 * Times every request, records it as metrics, and writes one access-log
 * line. Routes are labelled by template (`/v1/payments/:paymentId`), not
 * the concrete path, so metrics stay bounded.
 */
export function httpObserver(metrics: MetricsService, logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (QUIET.test(req.path)) return;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeTemplate(req);
      metrics.observeHttp(req.method, route, res.statusCode, seconds);
      logger.event(
        res.statusCode >= 500 ? 'error' : 'info',
        'HTTP',
        `${req.method} ${route} ${res.statusCode}`,
        {
          method: req.method,
          route,
          status: res.statusCode,
          durationMs: Math.round(seconds * 1e5) / 100,
        },
      );
    });
    next();
  };
}

function routeTemplate(req: Request): string {
  const { route } = req as unknown as { route?: { path?: unknown } };
  return typeof route?.path === 'string'
    ? `${req.baseUrl}${route.path}`
    : 'unmatched';
}
