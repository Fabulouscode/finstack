import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import {
  catchError,
  from,
  mergeMap,
  Observable,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { Owner, organizationOwner, userOwner } from '../common/owner/owner';
import type { OrganizationRequest } from '../organizations/guards/organization-access';
import { IdempotencyKeyRequiredException } from './idempotency.errors';
import { IdempotencyService } from './idempotency.service';
import { isValidIdempotencyKey, requestHash } from './request-fingerprint';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * Makes an authenticated endpoint safe to retry: the first request with a
 * given Idempotency-Key executes; later ones with the same key and body get
 * the stored response. Apply with @Idempotent().
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<OrganizationRequest>();
    const response = http.getResponse<Response>();

    const key = request.header(IDEMPOTENCY_KEY_HEADER);
    if (!isValidIdempotencyKey(key)) {
      return throwError(() => new IdempotencyKeyRequiredException());
    }
    // Keys are scoped to the organization on organization routes (so members
    // and API keys share one key space), otherwise to the user.
    const access = request.organizationAccess;
    const owner: Owner | null = access
      ? organizationOwner(access.organizationId)
      : request.user
        ? userOwner(request.user.id)
        : null;
    if (!owner) {
      return throwError(
        () => new Error('@Idempotent() requires an authenticated route'),
      );
    }

    const path = request.originalUrl.split('?')[0] ?? request.originalUrl;
    const status = this.successStatus(context, request.method);

    return from(
      this.idempotency.begin({
        owner,
        key,
        method: request.method,
        path,
        requestHash: requestHash(request.method, path, request.body),
      }),
    ).pipe(
      switchMap((outcome) => {
        if (outcome.kind === 'replay') {
          response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
          response.status(outcome.status);
          return of(outcome.body);
        }

        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            // Store exactly what the client receives (Dates become strings).
            const serialised =
              body === undefined || body === null
                ? null
                : (JSON.parse(JSON.stringify(body)) as object);
            await this.idempotency.complete(
              outcome.recordId,
              status,
              serialised,
            );
            return body;
          }),
          catchError((error: unknown) =>
            from(this.idempotency.release(outcome.recordId)).pipe(
              mergeMap(() => throwError(() => error)),
            ),
          ),
        );
      }),
    );
  }

  private successStatus(context: ExecutionContext, method: string): number {
    return (
      this.reflector.get<number | undefined>(
        HTTP_CODE_METADATA,
        context.getHandler(),
      ) ?? (method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK)
    );
  }
}
