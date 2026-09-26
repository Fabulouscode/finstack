import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { emailConfig } from '../config/email.config';
import type { EmailConfig } from '../config/email.config';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { EmailNotification } from './email-notification.entity';
import {
  EmailTransport,
  LogEmailTransport,
  SmtpEmailTransport,
} from './email-transport';
import { NotificationsEventHandler } from './notifications.event-handler';
import { NotificationsService } from './notifications.service';

/** Emails to users about their money, from domain events. */
@Module({
  imports: [
    TypeOrmModule.forFeature([EmailNotification]),
    UsersModule,
    OrganizationsModule,
  ],
  providers: [
    LogEmailTransport,
    {
      provide: EmailTransport,
      inject: [emailConfig.KEY, LogEmailTransport],
      useFactory: (config: EmailConfig, log: LogEmailTransport) =>
        config.driver === 'smtp' ? new SmtpEmailTransport(config) : log,
    },
    NotificationsService,
    NotificationsEventHandler,
  ],
  exports: [NotificationsEventHandler, LogEmailTransport],
})
export class NotificationsModule {}
