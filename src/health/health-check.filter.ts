import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Keeps Terminus' native body for failed probes (`{ status, info, error,
 * details }`) instead of the global problem+json format, so standard health
 * tooling can read which dependency is down.
 */
@Catch(ServiceUnavailableException)
export class HealthCheckFilter implements ExceptionFilter {
  catch(exception: ServiceUnavailableException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.getStatus())
      .json(exception.getResponse());
  }
}
