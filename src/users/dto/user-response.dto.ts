import { ApiProperty } from '@nestjs/swagger';
import { User, UserRole, UserStatus } from '../user.entity';

export class UserResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '3f0e8d5a-8b5c-4c1e-9f3a-2d7b6c5e4a1b',
  })
  id: string;

  @ApiProperty({ example: 'ada@example.com' })
  email: string;

  @ApiProperty({ example: 'Ada' })
  firstName: string;

  @ApiProperty({ example: 'Lovelace' })
  lastName: string;

  @ApiProperty({ enum: UserRole, example: UserRole.User })
  role: UserRole;

  @ApiProperty({ enum: UserStatus, example: UserStatus.Active })
  status: UserStatus;

  @ApiProperty({ format: 'date-time', example: '2026-09-24T10:00:00.000Z' })
  createdAt: Date;

  static fromEntity(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    };
  }
}
