import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/http/app.exception';

/** Also returned to non-members, so organization ids can't be probed. */
export class OrganizationNotFoundException extends AppException {
  constructor() {
    super(
      'ORGANIZATION_NOT_FOUND',
      'Organization not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

export class OrganizationPermissionDeniedException extends AppException {
  constructor(permission: string) {
    super(
      'ORGANIZATION_PERMISSION_DENIED',
      `This requires the "${permission}" permission in the organization`,
      HttpStatus.FORBIDDEN,
    );
  }
}

export class OrganizationSuspendedException extends AppException {
  constructor() {
    super(
      'ORGANIZATION_SUSPENDED',
      'This organization is suspended',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class MemberAlreadyExistsException extends AppException {
  constructor() {
    super(
      'MEMBER_ALREADY_EXISTS',
      'This user is already a member',
      HttpStatus.CONFLICT,
    );
  }
}

export class MemberNotFoundException extends AppException {
  constructor() {
    super('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
  }
}

export class OwnerChangeNotAllowedException extends AppException {
  constructor(
    detail = 'The owner cannot be removed or demoted; transfer ownership first',
  ) {
    super('OWNER_CHANGE_NOT_ALLOWED', detail, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class UserNotFoundForEmailException extends AppException {
  constructor() {
    super(
      'USER_NOT_FOUND',
      'No user with this email',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
