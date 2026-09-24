import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ApiProblemResponse } from '../docs/api-problem-response.decorator';
import { WebhooksService } from './webhooks.service';

export class WebhookAckDto {
  @ApiProperty({ example: true })
  received: true;

  @ApiProperty({
    description: 'True if this event was already received before',
    example: false,
  })
  duplicate: boolean;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  // Public (providers can't send our JWTs; the signature authenticates them)
  // and unthrottled (providers burst and retry; verification is cheap).
  @Post(':provider')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a payment provider webhook',
    description:
      'Verifies the signature over the raw body, stores the event, ignores duplicates and settles the payment after confirming its state with the provider. ' +
      'Processing errors are recorded and retried by FinStack, so the provider still gets 200.',
  })
  @ApiOkResponse({ type: WebhookAckDto })
  @ApiProblemResponse(400, 'INVALID_WEBHOOK_PAYLOAD')
  @ApiProblemResponse(401, 'INVALID_WEBHOOK_SIGNATURE')
  @ApiProblemResponse(422, 'UNKNOWN_PAYMENT_PROVIDER')
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<WebhookAckDto> {
    const result = await this.webhooks.receive(
      provider,
      request.rawBody,
      request.headers,
    );
    return { received: true, duplicate: result.duplicate };
  }
}
