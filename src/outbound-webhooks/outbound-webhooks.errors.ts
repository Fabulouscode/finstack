import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class WebhookEndpointNotFoundException extends AppException {
  constructor() {
    super(
      'WEBHOOK_ENDPOINT_NOT_FOUND',
      'Webhook endpoint not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class WebhookDeliveryNotFoundException extends AppException {
  constructor() {
    super(
      'WEBHOOK_DELIVERY_NOT_FOUND',
      'Webhook delivery not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class WebhookUrlNotAllowedException extends AppException {
  constructor(reason: string) {
    super('WEBHOOK_URL_NOT_ALLOWED', reason, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
