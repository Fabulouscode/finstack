import { HttpException, HttpStatus } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { AppException } from './app.exception';
import { ProblemDetails } from './problem-details';

const CODES_BY_STATUS: Partial<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

const INTERNAL_ERROR_DETAIL = 'An unexpected error occurred';

interface Classified {
  status: number;
  code: string;
  detail: string;
  errors?: ProblemDetails['errors'];
}

/**
 * Converts any thrown value into an RFC 9457 problem. Only errors that are
 * explicitly client-facing keep their message; everything else becomes a
 * generic 500 so internals (SQL, stack traces, hostnames) never leak.
 */
export function toProblemDetails(
  exception: unknown,
  instance: string,
  requestId?: string,
): ProblemDetails {
  const { status, code, detail, errors } = classify(exception);

  return {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    detail,
    instance,
    code,
    ...(requestId ? { requestId } : {}),
    ...(errors ? { errors } : {}),
  };
}

function classify(exception: unknown): Classified {
  if (exception instanceof AppException) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      detail: exception.detail,
      errors: exception.errors,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      status,
      code: codeFor(status),
      detail:
        status >= 500 ? INTERNAL_ERROR_DETAIL : httpExceptionDetail(exception),
    };
  }

  if (isClientHttpError(exception)) {
    return {
      status: exception.status,
      code: codeFor(exception.status),
      detail: exception.message,
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: codeFor(HttpStatus.INTERNAL_SERVER_ERROR),
    detail: INTERNAL_ERROR_DETAIL,
  };
}

function codeFor(status: number): string {
  return CODES_BY_STATUS[status] ?? `HTTP_${status}`;
}

function httpExceptionDetail(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;

  if (typeof response === 'object' && 'message' in response) {
    const { message } = response;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }

  return exception.message;
}

interface ClientHttpError {
  status: number;
  message: string;
  expose: true;
}

/**
 * Errors raised by Express middleware such as body-parser (e.g. 413 payload
 * too large) follow the `http-errors` convention: `expose: true` marks them
 * as safe to show. Nest itself converts malformed-JSON errors into a plain
 * BadRequestException before they reach the filter.
 */
function isClientHttpError(value: unknown): value is ClientHttpError {
  if (!(value instanceof Error)) return false;
  const candidate = value as Error & Partial<ClientHttpError>;

  return (
    candidate.expose === true &&
    typeof candidate.status === 'number' &&
    candidate.status >= 400 &&
    candidate.status < 500
  );
}
