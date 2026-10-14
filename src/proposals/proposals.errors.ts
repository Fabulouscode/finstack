import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

export class ProposalNotFoundException extends AppException {
  constructor() {
    super('PROPOSAL_NOT_FOUND', 'Proposal not found', HttpStatus.NOT_FOUND);
  }
}

export class ProposalAlreadyDecidedException extends AppException {
  constructor(status: string) {
    super(
      'PROPOSAL_ALREADY_DECIDED',
      `This proposal is already ${status}`,
      HttpStatus.CONFLICT,
    );
  }
}

export class ProposalExpiredException extends AppException {
  constructor() {
    super(
      'PROPOSAL_EXPIRED',
      'This proposal has expired; ask for a new one',
      HttpStatus.CONFLICT,
    );
  }
}
