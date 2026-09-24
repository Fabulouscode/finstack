import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { RequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Client-supplied IDs are echoed into logs and responses, so only accept a
// conservative character set and length to prevent header or log injection.
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(incoming: string | undefined): string {
  return incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Assigns every request an ID (reusing a valid inbound `X-Request-Id`),
 * returns it in the response header and exposes it via RequestContext.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(req.header(REQUEST_ID_HEADER));

  res.setHeader(REQUEST_ID_HEADER, requestId);
  RequestContext.run({ requestId }, next);
}
