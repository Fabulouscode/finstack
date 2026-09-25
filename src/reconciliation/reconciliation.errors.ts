import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class ReconciliationRunNotFoundException extends AppException {
  constructor() {
    super(
      'RECONCILIATION_RUN_NOT_FOUND',
      'Reconciliation run not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ReconciliationItemNotFoundException extends AppException {
  constructor() {
    super(
      'RECONCILIATION_ITEM_NOT_FOUND',
      'Reconciliation item not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class ReconciliationItemNotOpenException extends AppException {
  constructor() {
    super(
      'RECONCILIATION_ITEM_NOT_OPEN',
      'Only open items can be resolved',
      HttpStatus.CONFLICT,
    );
  }
}

export class ProviderCannotReconcileException extends AppException {
  constructor(provider: string) {
    super(
      'PROVIDER_CANNOT_RECONCILE',
      `${provider} cannot list its records for reconciliation`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class InvalidReconciliationPeriodException extends AppException {
  constructor(detail: string) {
    super(
      'INVALID_RECONCILIATION_PERIOD',
      detail,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
