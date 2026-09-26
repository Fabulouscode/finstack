import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  NotFoundException,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/decorators/public.decorator';
import { AppException } from '../common/http/app.exception';
import { observabilityConfig } from '../config/observability.config';
import type { ObservabilityConfig } from '../config/observability.config';
import { MetricsService } from './metrics.service';

/** Prometheus scrape endpoint: unversioned, unthrottled, token-protected. */
@ApiExcludeController()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
@Public()
@SkipThrottle()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(observabilityConfig.KEY)
    private readonly config: ObservabilityConfig,
  ) {}

  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.config.metricsEnabled) {
      throw new NotFoundException();
    }
    if (this.config.metricsToken && !this.authorised(authorization)) {
      throw new AppException(
        'UNAUTHENTICATED',
        'A valid metrics token is required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.render());
  }

  private authorised(authorization: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.config.metricsToken}`);
    const given = Buffer.from(authorization ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
