import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthConfig, authConfig } from '../config/auth.config';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PasswordHasher } from './password-hasher';
import { AccessTokenService } from './tokens/access-token.service';
import { RefreshToken } from './tokens/refresh-token.entity';
import { RefreshTokenService } from './tokens/refresh-token.service';

@Module({
  imports: [
    UsersModule,
    ApiKeysModule,
    TypeOrmModule.forFeature([RefreshToken]),
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: ({ accessToken }: AuthConfig) => ({
        secret: accessToken.secret,
        signOptions: {
          algorithm: 'HS256',
          expiresIn: accessToken.ttlSeconds,
          issuer: accessToken.issuer,
          audience: accessToken.audience,
        },
        verifyOptions: {
          // Pin the algorithm: never let the token header choose it.
          algorithms: ['HS256'],
          issuer: accessToken.issuer,
          audience: accessToken.audience,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordHasher,
    AccessTokenService,
    RefreshTokenService,
    // Order matters: authenticate first, then authorise.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
