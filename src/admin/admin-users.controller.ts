import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { OrganizationResponseDto } from '../organizations/dto/organization.dto';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UserRole, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { WalletResponseDto } from '../wallets/dto/wallet.dto';
import { WalletsService } from '../wallets/wallets.service';
import { AdminService } from './admin.service';
import { AdminReasonRequestDto, SearchUsersQueryDto } from './dto/admin.dto';

class AdminUsersPageDto {
  @ApiProperty({ type: [UserResponseDto] })
  data: UserResponseDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

class AdminUserDetailDto {
  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;

  @ApiProperty({ type: [WalletResponseDto] })
  wallets: WalletResponseDto[];

  @ApiProperty({ type: [OrganizationResponseDto] })
  organizations: OrganizationResponseDto[];
}

@ApiTags('Admin')
@ApiBearerAuth(ACCESS_TOKEN_SCHEME)
@Roles(UserRole.Admin)
@ApiProblemResponse(401, 'UNAUTHENTICATED')
@ApiProblemResponse(403, 'FORBIDDEN: admin role required')
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly admin: AdminService,
    private readonly users: UsersService,
    private readonly wallets: WalletsService,
    private readonly organizations: OrganizationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search users', description: 'Newest first.' })
  @ApiOkResponse({ type: AdminUsersPageDto })
  @ApiValidationProblemResponse()
  async search(
    @Query() query: SearchUsersQueryDto,
  ): Promise<AdminUsersPageDto> {
    const page = await this.users.search(
      { email: query.email, status: query.status },
      {
        limit: query.limit,
        before: query.cursor ? decodeCursor(query.cursor) : undefined,
      },
    );
    return {
      data: page.users.map((user) => UserResponseDto.fromEntity(user)),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    };
  }

  @Get(':userId')
  @ApiOperation({ summary: 'A user with their wallets and organizations' })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiProblemResponse(404, 'USER_NOT_FOUND')
  async get(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminUserDetailDto> {
    const user = await this.admin.getUser(userId);
    const [wallets, organizations] = await Promise.all([
      this.wallets.listFor(userId),
      this.organizations.listForUser(userId),
    ]);
    return {
      user: UserResponseDto.fromEntity(user),
      wallets: wallets.map((wallet) => WalletResponseDto.from(wallet)),
      organizations: organizations.map((org) =>
        OrganizationResponseDto.from(org),
      ),
    };
  }

  @Post(':userId/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend a user',
    description:
      'Takes effect immediately: every request is refused and all sessions are revoked. Audited with the reason.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'USER_NOT_FOUND')
  @ApiProblemResponse(409, 'INVALID_STATUS_CHANGE: already suspended')
  @ApiProblemResponse(422, 'CANNOT_SUSPEND_SELF')
  async suspend(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: AdminReasonRequestDto,
  ): Promise<UserResponseDto> {
    return UserResponseDto.fromEntity(
      await this.admin.setUserStatus(
        admin.id,
        userId,
        UserStatus.Suspended,
        body.reason,
      ),
    );
  }

  @Post(':userId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended user' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(404, 'USER_NOT_FOUND')
  @ApiProblemResponse(409, 'INVALID_STATUS_CHANGE: already active')
  async reactivate(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: AdminReasonRequestDto,
  ): Promise<UserResponseDto> {
    return UserResponseDto.fromEntity(
      await this.admin.setUserStatus(
        admin.id,
        userId,
        UserStatus.Active,
        body.reason,
      ),
    );
  }
}
