import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { RequestContext } from '../request-context/request-context';
import { PROBLEM_JSON_CONTENT_TYPE } from './problem-details';
import { toProblemDetails } from './to-problem-details';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = RequestContext.requestId();

    const problem = toProblemDetails(exception, request.originalUrl, requestId);

    if (problem.status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} failed (requestId=${requestId ?? 'n/a'})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response
      .status(problem.status)
      .type(PROBLEM_JSON_CONTENT_TYPE)
      .json(problem);
  }
}
