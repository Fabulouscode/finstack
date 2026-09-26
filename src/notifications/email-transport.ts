import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { emailConfig } from '../config/email.config';
import type { EmailConfig } from '../config/email.config';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Where emails go. Swap the driver with EMAIL_DRIVER. */
export abstract class EmailTransport {
  abstract send(message: EmailMessage): Promise<void>;
}

/**
 * Development and tests: logs each email and keeps the latest ones in
 * memory (so tests can read them), instead of sending.
 */
@Injectable()
export class LogEmailTransport extends EmailTransport {
  private readonly logger = new Logger('Email');
  readonly outbox: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 500) this.outbox.shift();
    this.logger.log(`To ${message.to}: ${message.subject}`);
    return Promise.resolve();
  }
}

/** Any SMTP service (SES, Postmark, SendGrid, Mailgun, your own). */
@Injectable()
export class SmtpEmailTransport extends EmailTransport {
  private readonly transporter: Transporter;

  constructor(@Inject(emailConfig.KEY) private readonly config: EmailConfig) {
    super();
    this.transporter = createTransport(config.smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.config.from, ...message });
  }
}
