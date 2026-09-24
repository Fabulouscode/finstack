import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class FxRateUnavailableException extends AppException {
  constructor(source: string, target: string) {
    super(
      'FX_RATE_UNAVAILABLE',
      `No exchange rate is configured for ${source}/${target}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/** The newest rate is older than FX_RATE_MAX_AGE_SECONDS: refuse to quote. */
export class FxRateStaleException extends AppException {
  constructor(source: string, target: string) {
    super(
      'FX_RATE_STALE',
      `The ${source}/${target} exchange rate is out of date`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

export class SameCurrencyConversionException extends AppException {
  constructor() {
    super(
      'SAME_CURRENCY',
      'Source and target currencies must differ',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ConversionAmountTooSmallException extends AppException {
  constructor() {
    super(
      'AMOUNT_TOO_SMALL',
      'The amount is too small to convert',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class FxQuoteNotFoundException extends AppException {
  constructor() {
    super('FX_QUOTE_NOT_FOUND', 'Quote not found', HttpStatus.NOT_FOUND);
  }
}

export class FxQuoteExpiredException extends AppException {
  constructor() {
    super(
      'FX_QUOTE_EXPIRED',
      'The quote has expired',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class FxQuoteAlreadyUsedException extends AppException {
  constructor() {
    super(
      'FX_QUOTE_ALREADY_USED',
      'The quote has already been used for another conversion',
      HttpStatus.CONFLICT,
    );
  }
}
