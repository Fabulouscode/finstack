import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  ASSIGNABLE_ROLES,
  OrgRole,
  ROLE_PERMISSIONS,
} from '../organization-permissions';
import { OrganizationStatus } from '../organization.entity';
import { MemberView, OrganizationWithRole } from '../organizations.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateOrganizationRequestDto {
  @ApiProperty({ example: 'Acme Payments Ltd', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;
}

export class UpdateOrganizationRequestDto extends CreateOrganizationRequestDto {}

export class AddMemberRequestDto {
  @ApiProperty({ example: 'bola@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiProperty({ enum: ASSIGNABLE_ROLES, example: OrgRole.Member })
  @IsIn(ASSIGNABLE_ROLES)
  role: OrgRole;
}

export class ChangeRoleRequestDto {
  @ApiProperty({ enum: ASSIGNABLE_ROLES, example: OrgRole.Admin })
  @IsIn(ASSIGNABLE_ROLES)
  role: OrgRole;
}

export class TransferOwnershipRequestDto {
  @ApiProperty({
    format: 'uuid',
    description: 'An existing member who becomes the owner',
  })
  @IsUUID()
  userId: string;
}

export class OrganizationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Acme Payments Ltd' })
  name: string;

  @ApiProperty({ enum: OrganizationStatus, example: OrganizationStatus.Active })
  status: OrganizationStatus;

  @ApiProperty({
    enum: OrgRole,
    nullable: true,
    description:
      'Your role in this organization (null when calling with an API key)',
    example: OrgRole.Owner,
  })
  role: OrgRole | null;

  @ApiProperty({
    type: [String],
    description:
      "What you may do: your role's permissions, or the API key's scopes",
    example: ['organization:read'],
  })
  permissions: string[];

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from({
    organization,
    role,
  }: OrganizationWithRole): OrganizationResponseDto {
    return OrganizationResponseDto.forAccess(organization, role, [
      ...ROLE_PERMISSIONS[role],
    ]);
  }

  static forAccess(
    organization: OrganizationWithRole['organization'],
    role: OrgRole | null,
    permissions: string[],
  ): OrganizationResponseDto {
    return {
      id: organization.id,
      name: organization.name,
      status: organization.status,
      role,
      permissions,
      createdAt: organization.createdAt,
    };
  }
}

export class MemberResponseDto {
  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ example: 'bola@example.com' })
  email: string;

  @ApiProperty({ example: 'Bola' })
  firstName: string;

  @ApiProperty({ example: 'Ade' })
  lastName: string;

  @ApiProperty({ enum: OrgRole, example: OrgRole.Member })
  role: OrgRole;

  @ApiProperty({ format: 'date-time' })
  joinedAt: Date;

  static from({ membership, user }: MemberView): MemberResponseDto {
    return {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: membership.role,
      joinedAt: membership.createdAt,
    };
  }
}
