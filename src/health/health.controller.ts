import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
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
      'Reports whether the instance can serve traffic. Returns 503 when PostgreSQL is unreachable (1.5s timeout).',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.pingCheck('database').withTimeout(1500),
    ]);
  }
}
