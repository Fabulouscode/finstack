import { Controller, Get, UseFilters, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';
import { HealthCheckFilter } from './health-check.filter';
import { RedisHealthIndicator } from './redis.health';

// Probes are unversioned (/health/*) and never rate limited: orchestrators
// poll them constantly and expect a stable URL.
@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
@Public()
@SkipThrottle()
@UseFilters(HealthCheckFilter)
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Reports that the process is running. Does not check dependencies, so a database outage never causes the orchestrator to restart healthy instances.',
  })
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Reports whether the instance can serve traffic. Returns 503 when PostgreSQL or Redis is unreachable (1.5s timeout each).',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.pingCheck('database').withTimeout(1500),
      () => this.redis.pingCheck('redis'),
    ]);
  }
}
