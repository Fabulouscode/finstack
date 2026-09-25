import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolation } from '../database/postgres-errors';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { Membership } from './membership.entity';
import { OrgRole } from './organization-permissions';
import { Organization } from './organization.entity';
import {
  MemberAlreadyExistsException,
  MemberNotFoundException,
  OrganizationNotFoundException,
  OwnerChangeNotAllowedException,
  UserNotFoundForEmailException,
} from './organizations.errors';

export interface OrganizationWithRole {
  organization: Organization;
  role: OrgRole;
}

export interface MemberView {
  membership: Membership;
  user: User;
}

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(Membership)
    private readonly memberships: Repository<Membership>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The creator becomes the owner, atomically. */
  async create(userId: string, name: string): Promise<OrganizationWithRole> {
    const organization = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(Organization, { name }),
      );
      await manager.save(
        manager.create(Membership, {
          organizationId: created.id,
          userId,
          role: OrgRole.Owner,
        }),
      );
      await this.audit.record(manager, {
        action: AuditAction.OrganizationCreated,
        organizationId: created.id,
        targetType: 'organization',
        targetId: created.id,
        metadata: { name },
      });
      return created;
    });
    return { organization, role: OrgRole.Owner };
  }

  async listForUser(userId: string): Promise<OrganizationWithRole[]> {
    const memberships = await this.memberships.find({
      where: { userId },
      relations: { organization: true },
      order: { createdAt: 'ASC' },
    });
    return memberships.flatMap((membership) =>
      membership.organization
        ? [{ organization: membership.organization, role: membership.role }]
        : [],
    );
  }

  async get(organizationId: string): Promise<Organization> {
    const organization = await this.organizations.findOneBy({
      id: organizationId,
    });
    if (!organization) {
      throw new OrganizationNotFoundException();
    }
    return organization;
  }

  findMembership(
    organizationId: string,
    userId: string,
  ): Promise<Membership | null> {
    return this.memberships.findOneBy({ organizationId, userId });
  }

  async rename(organizationId: string, name: string): Promise<Organization> {
    const before = await this.get(organizationId);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(Organization, { id: organizationId }, { name });
      await this.audit.record(manager, {
        action: AuditAction.OrganizationRenamed,
        organizationId,
        targetType: 'organization',
        targetId: organizationId,
        metadata: { from: before.name, to: name },
      });
    });
    return this.get(organizationId);
  }

  async listMembers(organizationId: string): Promise<MemberView[]> {
    const memberships = await this.memberships.find({
      where: { organizationId },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    return memberships.flatMap((membership) =>
      membership.user ? [{ membership, user: membership.user }] : [],
    );
  }

  async addMember(
    organizationId: string,
    email: string,
    role: OrgRole,
  ): Promise<MemberView> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      throw new UserNotFoundForEmailException();
    }
    try {
      const membership = await this.dataSource.transaction(async (manager) => {
        const saved = await manager.save(
          manager.create(Membership, {
            organizationId,
            userId: user.id,
            role,
          }),
        );
        await this.audit.record(manager, {
          action: AuditAction.MemberAdded,
          organizationId,
          targetType: 'user',
          targetId: user.id,
          metadata: { role },
        });
        return saved;
      });
      return { membership, user };
    } catch (error) {
      if (isUniqueViolation(error, 'uq_organization_members_org_user')) {
        throw new MemberAlreadyExistsException();
      }
      throw error;
    }
  }

  async changeRole(
    organizationId: string,
    userId: string,
    role: OrgRole,
  ): Promise<MemberView> {
    const target = await this.requireMember(organizationId, userId);
    if (target.membership.role === OrgRole.Owner) {
      throw new OwnerChangeNotAllowedException();
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.update(Membership, { id: target.membership.id }, { role });
      await this.audit.record(manager, {
        action: AuditAction.MemberRoleChanged,
        organizationId,
        targetType: 'user',
        targetId: userId,
        metadata: { from: target.membership.role, to: role },
      });
    });
    return { ...target, membership: { ...target.membership, role } };
  }

  async removeMember(organizationId: string, userId: string): Promise<void> {
    const target = await this.requireMember(organizationId, userId);
    if (target.membership.role === OrgRole.Owner) {
      throw new OwnerChangeNotAllowedException();
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Membership, { id: target.membership.id });
      await this.audit.record(manager, {
        action: AuditAction.MemberRemoved,
        organizationId,
        targetType: 'user',
        targetId: userId,
        metadata: { role: target.membership.role },
      });
    });
  }

  /**
   * Hands ownership to another member; the previous owner becomes an admin.
   * Demote first, then promote: the partial unique index allows one owner.
   */
  async transferOwnership(
    organizationId: string,
    newOwnerUserId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const members = await manager
        .createQueryBuilder(Membership, 'member')
        .setLock('pessimistic_write')
        .where('member.organizationId = :organizationId', { organizationId })
        .getMany();

      const next = members.find((member) => member.userId === newOwnerUserId);
      if (!next) {
        throw new MemberNotFoundException();
      }
      if (next.role === OrgRole.Owner) {
        return;
      }
      await manager.update(
        Membership,
        { organizationId, role: OrgRole.Owner },
        { role: OrgRole.Admin },
      );
      await manager.update(
        Membership,
        { id: next.id },
        { role: OrgRole.Owner },
      );
      await this.audit.record(manager, {
        action: AuditAction.OwnershipTransferred,
        organizationId,
        targetType: 'user',
        targetId: newOwnerUserId,
        metadata: {
          previousOwnerUserId:
            members.find((member) => member.role === OrgRole.Owner)?.userId ??
            null,
        },
      });
    });
  }

  private async requireMember(
    organizationId: string,
    userId: string,
  ): Promise<MemberView> {
    const membership = await this.memberships.findOne({
      where: { organizationId, userId },
      relations: { user: true },
    });
    if (!membership?.user) {
      throw new MemberNotFoundException();
    }
    return { membership, user: membership.user };
  }
}
