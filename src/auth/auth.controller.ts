import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthRateLimit } from '../common/http/rate-limit';
import {
  ApiProblemResponse,
  ApiValidationProblemResponse,
} from '../docs/api-problem-response.decorator';
import { ACCESS_TOKEN_SCHEME } from '../docs/swagger';
import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './authenticated-user';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import {
  AuthResponseDto,
  LoginRequestDto,
  RefreshTokenRequestDto,
  RegisterRequestDto,
  TokenPairDto,
} from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Public()
  @AuthRateLimit()
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Registers a user and starts a session. The email is normalised to lowercase.',
  })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    409,
    'EMAIL_ALREADY_REGISTERED: the email is already in use',
  )
  register(@Body() body: RegisterRequestDto): Promise<AuthResponseDto> {
    return this.auth.register(body);
  }

  @Post('login')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Exchanges email and password for an access and refresh token.',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    401,
    'INVALID_CREDENTIALS: email or password is incorrect',
  )
  @ApiProblemResponse(403, 'ACCOUNT_SUSPENDED: the account has been suspended')
  login(@Body() body: LoginRequestDto): Promise<AuthResponseDto> {
    return this.auth.login(body);
  }

  @Post('refresh')
  @Public()
  @AuthRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate tokens',
    description:
      'Exchanges a refresh token for a new token pair. Each refresh token works once. ' +
      'Reusing one revokes the whole session, so clients must not refresh concurrently.',
  })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiValidationProblemResponse()
  @ApiProblemResponse(
    401,
    'INVALID_REFRESH_TOKEN: unknown, expired, revoked or reused token',
  )
  refresh(@Body() body: RefreshTokenRequestDto): Promise<TokenPairDto> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out',
    description:
      'Revokes the session the refresh token belongs to. Idempotent: unknown tokens also return 204. ' +
      'Issued access tokens remain valid until they expire.',
  })
  @ApiNoContentResponse({ description: 'Session revoked' })
  @ApiValidationProblemResponse()
  logout(@Body() body: RefreshTokenRequestDto): Promise<void> {
    return this.auth.logout(body.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth(ACCESS_TOKEN_SCHEME)
  @ApiOperation({
    summary: 'Sign out everywhere',
    description: 'Revokes every session (refresh token) of the current user.',
  })
  @ApiNoContentResponse({ description: 'All sessions revoked' })
  @ApiProblemResponse(401, 'UNAUTHENTICATED: missing or invalid access token')
  logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.auth.logoutEverywhere(user.id);
  }
}
