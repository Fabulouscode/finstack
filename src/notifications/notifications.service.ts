import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrgRole } from '../organizations/organization-permissions';
import { OrganizationsService } from '../organizations/organizations.service';
import type { DomainEventMessage } from '../outbox/outbox.service';
import { User, UserStatus } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import {
  EmailNotification,
  EmailNotificationStatus,
} from './email-notification.entity';
import { renderEmail } from './email-templates';
import { EmailTransport } from './email-transport';
import { NotificationRule, notificationRules } from './notification-rules';

/**
 * Emails people about their money (payments, refunds, payouts, transfers).
 * Each email is recorded first (unique per event, template and recipient),
 * so redelivered events don't send it again. A failure throws, so the
 * domain-event job retries it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(EmailNotification)
    private readonly notifications: Repository<EmailNotification>,
    private readonly transport: EmailTransport,
    private readonly users: UsersService,
    private readonly organizations: OrganizationsService,
  ) {}

  async handle(event: DomainEventMessage): Promise<number> {
    let sent = 0;
    for (const rule of notificationRules(event)) {
      for (const user of await this.recipients(rule)) {
        if (await this.send(event.eventId, rule, user)) sent++;
      }
    }
    return sent;
  }

  private async recipients(rule: NotificationRule): Promise<User[]> {
    if ('userId' in rule.to) {
      const user = await this.users.findById(rule.to.userId);
      return user ? [user] : [];
    }
    const members = await this.organizations.listMembers(
      rule.to.organizationAdminsOf,
    );
    return members
      .filter(({ membership }) =>
        [OrgRole.Owner, OrgRole.Admin].includes(membership.role),
      )
      .map(({ user }) => user);
  }

  /** Sends one email unless it was already sent. */
  private async send(
    eventId: string,
    rule: NotificationRule,
    user: User,
  ): Promise<boolean> {
    if (user.status !== UserStatus.Active) {
      return false;
    }
    const email = renderEmail(
      rule.subject,
      user.firstName,
      rule.paragraphs,
      rule.reference,
    );

    await this.notifications
      .createQueryBuilder()
      .insert()
      .into(EmailNotification)
      .values({
        eventId,
        template: rule.template,
        recipientUserId: user.id,
        toEmail: user.email,
        subject: email.subject.slice(0, 200),
        status: EmailNotificationStatus.Pending,
        attempts: 0,
      })
      .orIgnore()
      .execute();
    const record = await this.notifications.findOneByOrFail({
      eventId,
      template: rule.template,
      recipientUserId: user.id,
    });
    if (record.status === EmailNotificationStatus.Sent) {
      return false;
    }

    try {
      await this.transport.send({ to: user.email, ...email });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.notifications.update(record.id, {
        status: EmailNotificationStatus.Failed,
        attempts: record.attempts + 1,
        lastError: message.slice(0, 1000),
      });
      this.logger.warn(
        `Email ${rule.template} to user ${user.id} failed: ${message}`,
      );
      throw error;
    }
    await this.notifications.update(record.id, {
      status: EmailNotificationStatus.Sent,
      attempts: record.attempts + 1,
      lastError: null,
      sentAt: new Date(),
    });
    return true;
  }
}
