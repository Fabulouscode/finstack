import { ConsoleLogger, LoggerService } from '@nestjs/common';
import { RequestContext } from '../common/request-context/request-context';
import type {
  LogLevel,
  ObservabilityConfig,
} from '../config/observability.config';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

type Write = (line: string) => void;

/**
 * The application logger. `json`: one object per line with time, level,
 * context, message and the request's id, trace id and actor, for log
 * collectors. `pretty`: Nest's console output, for people.
 */
export class AppLogger implements LoggerService {
  private readonly pretty: ConsoleLogger | null;
  private readonly minimum: number;

  constructor(
    config: ObservabilityConfig,
    private readonly write: Write = (line) => process.stdout.write(`${line}\n`),
  ) {
    this.minimum = RANK[config.logLevel];
    this.pretty =
      config.logFormat === 'pretty'
        ? new ConsoleLogger({
            logLevels: (
              ['debug', 'log', 'warn', 'error', 'fatal'] as const
            ).slice(this.minimum),
          })
        : null;
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  /** A structured line with extra fields (e.g. the HTTP access log). */
  event(
    level: LogLevel,
    context: string,
    message: string,
    fields: object,
  ): void {
    if (RANK[level] < this.minimum) return;
    if (this.pretty) {
      const method = level === 'info' ? 'log' : level;
      this.pretty[method](`${message} ${JSON.stringify(fields)}`, context);
      return;
    }
    this.write(
      JSON.stringify({ ...this.base(level, context, message), ...fields }),
    );
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (RANK[level] < this.minimum) return;
    // Nest calls logger.x(message, [stack,] context).
    const context =
      params.length > 0 && typeof params.at(-1) === 'string'
        ? (params.at(-1) as string)
        : undefined;
    const stack =
      level === 'error' && params.length > 1 && typeof params[0] === 'string'
        ? params[0]
        : message instanceof Error
          ? message.stack
          : undefined;

    if (this.pretty) {
      const method = level === 'info' ? 'log' : level;
      const args = [
        message,
        ...(stack ? [stack] : []),
        ...(context ? [context] : []),
      ];
      (this.pretty[method] as (...a: unknown[]) => void)(...args);
      return;
    }
    const text =
      message instanceof Error
        ? message.message
        : typeof message === 'string'
          ? message
          : JSON.stringify(message);
    this.write(
      JSON.stringify({
        ...this.base(level, context, text),
        ...(stack ? { stack } : {}),
      }),
    );
  }

  private base(
    level: LogLevel,
    context: string | undefined,
    message: string,
  ): Record<string, unknown> {
    const store = RequestContext.current();
    const actor = store?.actor;
    return {
      time: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      message,
      ...(store?.requestId ? { requestId: store.requestId } : {}),
      ...(store?.traceId ? { traceId: store.traceId } : {}),
      ...(actor && actor.type !== 'system'
        ? { actor: `${actor.type}:${actor.id}` }
        : {}),
    };
  }
}
