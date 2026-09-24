import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AppException, RequestValidationException } from './app.exception';
import { toProblemDetails } from './to-problem-details';

describe('toProblemDetails', () => {
  it('maps an AppException using its code and detail', () => {
    const problem = toProblemDetails(
      new AppException(
        'INSUFFICIENT_FUNDS',
        'Available balance is too low',
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
      '/v1/transfers',
      'req-1',
    );

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'Available balance is too low',
      instance: '/v1/transfers',
      code: 'INSUFFICIENT_FUNDS',
      requestId: 'req-1',
    });
  });

  it('includes field errors for validation failures', () => {
    const problem = toProblemDetails(
      new RequestValidationException([
        { field: 'amount', messages: ['amount must be an integer number'] },
      ]),
      '/v1/transfers',
    );

    expect(problem).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      errors: [
        { field: 'amount', messages: ['amount must be an integer number'] },
      ],
    });
    expect(problem).not.toHaveProperty('requestId');
  });

  it('maps built-in HTTP exceptions to a status-based code', () => {
    expect(
      toProblemDetails(new NotFoundException('Wallet not found'), '/x'),
    ).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Wallet not found',
    });
  });

  it('joins message arrays from HTTP exceptions', () => {
    const exception = new BadRequestException([
      'first problem',
      'second problem',
    ]);

    expect(toProblemDetails(exception, '/x').detail).toBe(
      'first problem; second problem',
    );
  });

  it('never exposes the message of a 5xx HTTP exception', () => {
    const problem = toProblemDetails(
      new InternalServerErrorException('connect ECONNREFUSED 10.0.0.5:5432'),
      '/x',
    );

    expect(problem).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(problem.detail).not.toContain('10.0.0.5');
  });

  it('turns unknown errors into a generic 500', () => {
    const problem = toProblemDetails(
      new Error(
        'duplicate key value violates unique constraint "users_email_key"',
      ),
      '/x',
    );

    expect(problem).toMatchObject({
      status: 500,
      title: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred',
    });
  });

  it('handles non-Error throwables', () => {
    expect(toProblemDetails('boom', '/x').status).toBe(500);
  });

  it('maps exposable client errors from middleware by status', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });

    expect(toProblemDetails(tooLarge, '/x')).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('does not trust errors that are not marked as exposable', () => {
    const internal = Object.assign(new Error('secret'), { status: 400 });

    expect(toProblemDetails(internal, '/x').status).toBe(500);
  });
});
