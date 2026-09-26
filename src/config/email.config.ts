import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { ConfigValidationError, validateConfig } from './validate-config';

export const EMAIL_DRIVERS = ['log', 'smtp'] as const;
export type EmailDriver = (typeof EMAIL_DRIVERS)[number];

class EmailEnvironmentVariables {
  /** `log` prints emails instead of sending them (development); `smtp` sends. */
  @IsIn(EMAIL_DRIVERS)
  EMAIL_DRIVER: EmailDriver = 'log';

  /** Sender, e.g. `Acme Pay <no-reply@acme.com>`. */
  @IsString()
  @MinLength(3)
  EMAIL_FROM: string = 'FinStack <no-reply@finstack.local>';

  /** `smtps://user:pass@smtp.example.com:465` (or `smtp://...:587` for STARTTLS). */
  @IsOptional()
  @Matches(/^smtps?:\/\/.+/, {
    message: 'SMTP_URL must look like smtps://user:pass@host:465',
  })
  SMTP_URL?: string;
}

export const emailConfig = registerAs('email', () => {
  const env = validateConfig('email', EmailEnvironmentVariables, process.env);
  if (env.EMAIL_DRIVER === 'smtp' && !env.SMTP_URL) {
    throw new ConfigValidationError('email', [
      'SMTP_URL is required when EMAIL_DRIVER=smtp',
    ]);
  }
  if (env.EMAIL_DRIVER === 'log' && process.env.NODE_ENV === 'production') {
    new Logger('Config').warn(
      'EMAIL_DRIVER=log in production: notification emails are logged, not sent',
    );
  }
  return {
    driver: env.EMAIL_DRIVER,
    from: env.EMAIL_FROM,
    smtpUrl: env.SMTP_URL ?? '',
  };
});

export type EmailConfig = ReturnType<typeof emailConfig>;
