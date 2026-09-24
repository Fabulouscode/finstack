import { Injectable } from '@nestjs/common';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { User, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import {
  AccountSuspendedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
} from './auth.errors';
import {
  AuthResponseDto,
  LoginRequestDto,
  RegisterRequestDto,
  TokenPairDto,
} from './dto/auth.dto';
import { PasswordHasher } from './password-hasher';
import { AccessTokenService } from './tokens/access-token.service';
import {
  IssuedRefreshToken,
  RefreshTokenService,
} from './tokens/refresh-token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordHasher,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async register(input: RegisterRequestDto): Promise<AuthResponseDto> {
    const user = await this.users.create({
      email: input.email,
      passwordHash: await this.passwords.hash(input.password),
      firstName: input.firstName,
      lastName: input.lastName,
    });

    return this.startSession(user);
  }

  async login(input: LoginRequestDto): Promise<AuthResponseDto> {
    const user = await this.users.findByEmailWithPasswordHash(input.email);

    const valid = user
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.verifyAgainstDummy(input.password);

    if (!user || !valid) {
      throw new InvalidCredentialsException();
    }
    // Checked only after the password, so suspension status isn't disclosed
    // to someone who doesn't know the credentials.
    if (user.status !== UserStatus.Active) {
      throw new AccountSuspendedException();
    }

    return this.startSession(user);
  }

  async refresh(refreshToken: string): Promise<TokenPairDto> {
    const rotated = await this.refreshTokens.rotate(refreshToken);

    const user = await this.users.findById(rotated.userId);
    if (!user || user.status !== UserStatus.Active) {
      await this.refreshTokens.revokeFamily(rotated.familyId);
      throw new InvalidRefreshTokenException();
    }

    return this.tokenPair(user, rotated);
  }

  logout(refreshToken: string): Promise<void> {
    return this.refreshTokens.revoke(refreshToken);
  }

  logoutEverywhere(userId: string): Promise<void> {
    return this.refreshTokens.revokeAllForUser(userId);
  }

  private async startSession(user: User): Promise<AuthResponseDto> {
    const refresh = await this.refreshTokens.issue(user.id);

    return {
      user: UserResponseDto.fromEntity(user),
      tokens: await this.tokenPair(user, refresh),
    };
  }

  private async tokenPair(
    user: User,
    refresh: IssuedRefreshToken,
  ): Promise<TokenPairDto> {
    return {
      tokenType: 'Bearer',
      accessToken: await this.accessTokens.sign({
        id: user.id,
        role: user.role,
      }),
      accessTokenExpiresIn: this.accessTokens.ttlSeconds,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }
}
