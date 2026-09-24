import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsPositive } from 'class-validator';
import { toMinorUnits } from '../common/money/money';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import {
  MOCK_SIGNATURE_HEADER,
  MockPaymentProvider,
} from '../payment-providers/mock/mock-payment.provider';
import { PaymentProvidersService } from '../payment-providers/payment-providers.service';
import { WebhooksService } from './webhooks.service';

export class SimulateCheckoutRequestDto {
  @ApiProperty({ enum: ['successful', 'failed'], example: 'successful' })
  @IsIn(['successful', 'failed'])
  outcome: 'successful' | 'failed';

  @ApiPropertyOptional({
    description: 'Simulate the provider collecting a different amount',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  amount?: number;
}

export class SimulateCheckoutResponseDto {
  @ApiProperty({ example: 'evt_4f9a2c1e7b3d5a8c' })
  eventId: string;
}

/**
 * Development helper: plays the customer finishing the mock checkout. It
 * sends a signed webhook through the real webhook pipeline. Only available
 * while the mock provider is enabled (never in production).
 */
@ApiTags('Dev: mock provider')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Controller('dev/mock-provider')
export class MockCheckoutController {
  constructor(
    private readonly providers: PaymentProvidersService,
    private readonly mock: MockPaymentProvider,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post('payments/:providerReference/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a mock checkout (sends a signed webhook)',
  })
  @ApiOkResponse({ type: SimulateCheckoutResponseDto })
  async complete(
    @Param('providerReference') providerReference: string,
    @Body() body: SimulateCheckoutRequestDto,
  ): Promise<SimulateCheckoutResponseDto> {
    if (!this.providers.has('mock')) {
      throw new NotFoundException();
    }
    const { rawBody, signature } = this.mock.simulateOutcome(
      providerReference,
      body.outcome,
      {
        amount:
          body.amount !== undefined ? toMinorUnits(body.amount) : undefined,
      },
    );
    const result = await this.webhooks.receive('mock', rawBody, {
      [MOCK_SIGNATURE_HEADER]: signature,
    });
    return { eventId: result.eventId };
  }
}
