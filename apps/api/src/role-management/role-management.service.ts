import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type GlobalUserStatus, Prisma } from "@xhs-agentic/database";
import {
  type AccessScope,
  enterpriseAccessScope,
  persistedAccessScope,
  tenantAccessScope,
} from "../access/access-scope";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { normalizeChineseMobilePhone } from "../employee/phone";
import { resetChangedAdminEmail } from "../identity/admin-email-policy";
import { hashPassword, normalizeUsername } from "../identity/password";
import {
  type CreateAdminUserDto,
  type GrantPlatformAdminDto,
  type GrantRoleBindingDto,
  GrantScopeType,
  type GrantTenantAdminDto,
  type RevokeRoleBindingDto,
  type UpdateAdminUserProfileDto,
} from "./role-management.dto";

@Injectable()
export class RoleManagementService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  async listPlatformAdministrators() {
    this.requirePlatform();
    const now = new Date();
    const bindings = await this.prisma.roleBinding.findMany({
      include: {
        role: { select: { code: true } },
        user: {
          select: {
            adminSessions: {
              select: { id: true },
              where: { expiresAt: { gt: now }, revokedAt: null },
            },
            email: true,
            id: true,
            lastLoginAt: true,
            name: true,
            organizationProfiles: {
              select: { department: true, jobTitle: true },
              take: 1,
              where: { scopeId: "platform", scopeType: "PLATFORM" },
            },
            phone: true,
            username: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
      where: {
        role: { code: "PLATFORM_ADMIN", status: "ACTIVE" },
        scopeId: "platform",
        scopeType: "PLATFORM",
      },
    });
    return bindings.map(platformAdministratorView);
  }

  async grantPlatformAdministrator(input: GrantPlatformAdminDto) {
    const principal = this.requirePlatform();
    return withAdminUserConflictTranslation(() =>
      this.prisma.$transaction(async (transaction) => {
        const role = await transaction.role.findFirst({
          where: { code: "PLATFORM_ADMIN", scopeType: "PLATFORM", status: "ACTIVE" },
        });
        if (!role) throw new NotFoundException("Active PLATFORM_ADMIN role was not found");
        const user = await upsertUser(transaction, input.phone, input, input.username);
        if (user.id === principal.userId) {
          throw new ConflictException("Administrators cannot grant a platform role to themselves");
        }
        const binding = await upsertBinding(transaction, {
          createdBy: principal.userId,
          roleId: role.id,
          scope: { type: "PLATFORM" },
          userId: user.id,
        });
        await upsertAdminOrganizationProfile(transaction, user.id, { type: "PLATFORM" }, input);
        await auditRoleChange(transaction, {
          action: "role-binding.grant",
          actorUserId: principal.userId,
          bindingId: binding.id,
          reason: input.reason,
          state: { phone: user.phone, roleCode: role.code, scopeId: "platform" },
        });
        return platformAdministratorByBinding(transaction, binding.id);
      }),
    );
  }

  async revokePlatformAdministrator(bindingId: string, input: RevokeRoleBindingDto) {
    const principal = this.requirePlatform();
    return this.prisma.$transaction(async (transaction) => {
      const binding = await transaction.roleBinding.findFirst({
        include: { role: true, user: true },
        where: {
          id: bindingId,
          role: { code: "PLATFORM_ADMIN" },
          scopeId: "platform",
          scopeType: "PLATFORM",
        },
      });
      if (!binding) throw new NotFoundException("Platform administrator binding was not found");
      await assertCanRemoveActivePlatformAdmin(transaction, binding.userId);
      if (binding.userId === principal.userId) {
        throw new ConflictException("Administrators cannot revoke their own platform binding");
      }
      await transaction.roleBinding.delete({ where: { id: binding.id } });
      const revokedSessions = await revokeAdminSessions(
        transaction,
        binding.userId,
        "PLATFORM_ROLE_REVOKED",
      );
      await auditRoleChange(transaction, {
        action: "role-binding.revoke",
        actorUserId: principal.userId,
        bindingId: binding.id,
        reason: input.reason,
        state: {
          phone: binding.user.phone,
          revokedSessions,
          roleCode: binding.role.code,
          scopeId: binding.scopeId,
        },
      });
      return { id: binding.id, revoked: true };
    });
  }

  async setPlatformAdministratorStatus(userId: string, status: GlobalUserStatus, reason: string) {
    const principal = this.requirePlatform();
    return this.prisma.$transaction(async (transaction) => {
      const user = await requirePlatformAdministratorUser(transaction, userId);
      if (user.status === status) {
        return platformAdministratorAction(transaction, user.id);
      }
      if (status === "DISABLED") {
        await assertCanRemoveActivePlatformAdmin(transaction, user.id);
      }
      if (userId === principal.userId) {
        throw new ConflictException("Administrators cannot change their own account status");
      }
      await transaction.adminUser.update({ data: { status }, where: { id: user.id } });
      const revokedSessions =
        status === "DISABLED"
          ? await revokeAdminSessions(transaction, user.id, "PLATFORM_ACCOUNT_DISABLED")
          : 0;
      await transaction.auditLog.create({
        data: {
          action: status === "ACTIVE" ? "platform-admin.restore" : "platform-admin.disable",
          actorType: "USER",
          actorUserId: principal.userId,
          metadata: { revokedSessions },
          reason,
          resourceId: user.id,
          resourceType: "AdminUser",
          stateAfter: { status },
          stateBefore: { status: user.status },
        },
      });
      return platformAdministratorAction(transaction, user.id);
    });
  }

  async logoutPlatformAdministratorSessions(userId: string, reason: string) {
    const principal = this.requirePlatform();
    if (userId === principal.userId) {
      throw new ConflictException("Use the personal logout-all action for the current account");
    }
    return this.prisma.$transaction(async (transaction) => {
      const user = await requirePlatformAdministratorUser(transaction, userId);
      const revokedSessions = await revokeAdminSessions(
        transaction,
        user.id,
        "PLATFORM_FORCED_LOGOUT",
      );
      await transaction.auditLog.create({
        data: {
          action: "platform-admin.logout-all",
          actorType: "USER",
          actorUserId: principal.userId,
          metadata: { revokedSessions },
          reason,
          resourceId: user.id,
          resourceType: "AdminUser",
        },
      });
      return platformAdministratorAction(transaction, user.id);
    });
  }

  async grantTenantAdmin(tenantId: string, input: GrantTenantAdminDto) {
    const principal = this.requirePlatform();
    return withAdminUserConflictTranslation(() =>
      this.prisma.$transaction(async (transaction) => {
        await lockAdministratorScope(transaction, `TENANT:${tenantId}`);
        const [tenant, role] = await Promise.all([
          transaction.tenant.findFirst({
            select: { id: true },
            where: { id: tenantId, status: "ACTIVE" },
          }),
          transaction.role.findUnique({ where: { code: "TENANT_ADMIN" } }),
        ]);
        if (!tenant || !role || role.status !== "ACTIVE") {
          throw new NotFoundException("Active tenant or TENANT_ADMIN role was not found");
        }
        const user = await upsertUser(transaction, input.phone, input, input.username);
        const currentPrimaryAdministrator = await transaction.roleBinding.findFirst({
          where: {
            roleId: role.id,
            scopeId: tenantId,
            scopeType: "TENANT",
            tenantId,
          },
        });
        if (currentPrimaryAdministrator && currentPrimaryAdministrator.userId !== user.id) {
          throw new ConflictException({
            code: "TENANT_PRIMARY_ADMIN_ALREADY_ASSIGNED",
            message: "集团已设置主管理员，不能新增第二名同级管理员",
          });
        }
        if (user.id === principal.userId) {
          throw new ConflictException("Administrators cannot grant a new role to themselves");
        }
        const binding = await upsertBinding(transaction, {
          createdBy: principal.userId,
          roleId: role.id,
          scope: tenantAccessScope(tenantId),
          userId: user.id,
        });
        await upsertAdminOrganizationProfile(
          transaction,
          user.id,
          tenantAccessScope(tenantId),
          input,
        );
        await auditRoleChange(transaction, {
          action: "role-binding.grant",
          actorUserId: principal.userId,
          bindingId: binding.id,
          reason: input.reason,
          state: { phone: user.phone, roleCode: role.code, scopeId: tenantId },
          tenantId,
        });
        return bindingView(transaction, binding.id);
      }),
    );
  }

  async listTenantBindings(tenantId: string) {
    this.requireTenant(tenantId);
    return this.prisma.roleBinding.findMany({
      include: {
        role: true,
        user: {
          select: { email: true, id: true, name: true, phone: true, username: true, status: true },
        },
      },
      orderBy: { createdAt: "asc" },
      where: { enterpriseId: null, scopeType: "TENANT", tenantId },
    });
  }

  async listEnterpriseBindings(tenantId: string, enterpriseId: string) {
    this.requireEnterprise(tenantId, enterpriseId);
    return this.prisma.roleBinding.findMany({
      include: {
        role: true,
        user: {
          select: { email: true, id: true, name: true, phone: true, username: true, status: true },
        },
      },
      orderBy: { createdAt: "asc" },
      where: { enterpriseId, tenantId },
    });
  }

  async listTenantAdminUsers(tenantId: string) {
    this.requireTenant(tenantId);
    return this.listAdminUsers({ tenantId });
  }

  async listEnterpriseAdminUsers(tenantId: string, enterpriseId: string) {
    this.requireEnterprise(tenantId, enterpriseId);
    return this.listAdminUsers({ enterpriseId, tenantId });
  }

  async createAdminUserFromTenant(tenantId: string, input: CreateAdminUserDto) {
    const principal = this.requireTenant(tenantId);
    const targetScope = await this.resolveTenantTargetScope(tenantId, input);
    return this.createAdminUser(principal, targetScope, input);
  }

  async createAdminUserFromEnterprise(
    tenantId: string,
    enterpriseId: string,
    input: CreateAdminUserDto,
  ) {
    const principal = this.requireEnterprise(tenantId, enterpriseId);
    if (input.scopeType !== GrantScopeType.ENTERPRISE || input.enterpriseId !== enterpriseId) {
      throw new ForbiddenException(
        "Enterprise administrators can only add backend users in their enterprise",
      );
    }
    return this.createAdminUser(principal, enterpriseAccessScope(tenantId, enterpriseId), input);
  }

  async updateTenantAdminUser(
    tenantId: string,
    userId: string,
    scopeType: GrantScopeType,
    enterpriseId: string | undefined,
    input: UpdateAdminUserProfileDto,
  ) {
    const principal = this.requireTenant(tenantId);
    const targetScope = await this.resolveTenantTargetScope(tenantId, {
      enterpriseId,
      scopeType,
    });
    return this.updateAdminUser(principal, targetScope, userId, input);
  }

  async updateEnterpriseAdminUser(
    tenantId: string,
    enterpriseId: string,
    userId: string,
    input: UpdateAdminUserProfileDto,
  ) {
    const principal = this.requireEnterprise(tenantId, enterpriseId);
    return this.updateAdminUser(
      principal,
      enterpriseAccessScope(tenantId, enterpriseId),
      userId,
      input,
    );
  }

  async listGrantableRoles(targetScope: "TENANT" | "ENTERPRISE") {
    const principal = this.accessContext.requireSaasAdmin();
    return this.prisma.role
      .findMany({
        include: { permissions: { include: { permission: true } } },
        orderBy: { code: "asc" },
        where: { scopeType: targetScope, status: "ACTIVE" },
      })
      .then((roles) =>
        roles.filter(
          (role) =>
            canGovernRole(principal.permissions, role.code) &&
            role.permissions.every(({ permission }) =>
              principal.permissions.includes(permission.code),
            ),
        ),
      );
  }

  async grantFromTenant(tenantId: string, input: GrantRoleBindingDto) {
    const principal = this.requireTenant(tenantId);
    const targetScope = await this.resolveTenantTargetScope(tenantId, input);
    return this.grantWithinScope(principal, targetScope, input);
  }

  async grantFromEnterprise(tenantId: string, enterpriseId: string, input: GrantRoleBindingDto) {
    const principal = this.requireEnterprise(tenantId, enterpriseId);
    if (input.scopeType !== GrantScopeType.ENTERPRISE || input.enterpriseId !== enterpriseId) {
      throw new ForbiddenException(
        "Enterprise administrators can only grant roles in their enterprise",
      );
    }
    return this.grantWithinScope(principal, enterpriseAccessScope(tenantId, enterpriseId), input);
  }

  async revokeFromTenant(tenantId: string, bindingId: string, input: RevokeRoleBindingDto) {
    const principal = this.requireTenant(tenantId);
    return this.revokeWithinScope(principal, { tenantId }, bindingId, input);
  }

  async revokeFromEnterprise(
    tenantId: string,
    enterpriseId: string,
    bindingId: string,
    input: RevokeRoleBindingDto,
  ) {
    const principal = this.requireEnterprise(tenantId, enterpriseId);
    return this.revokeWithinScope(principal, { enterpriseId, tenantId }, bindingId, input);
  }

  private async grantWithinScope(
    principal: ReturnType<RequestAccessContext["requireSaasAdmin"]>,
    targetScope: AccessScope,
    input: GrantRoleBindingDto,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const role = await transaction.role.findFirst({
        include: { permissions: { include: { permission: true } } },
        where: { code: input.roleCode, scopeType: targetScope.type, status: "ACTIVE" },
      });
      if (!role) {
        throw new NotFoundException("Active role was not found for the requested scope");
      }
      assertCanGovernRole(principal.permissions, role.code);
      assertPermissionSubset(
        principal.permissions,
        role.permissions.map(({ permission }) => permission.code),
      );
      const user = await upsertUser(transaction, input.phone, undefined, input.username);
      if (user.id === principal.userId) {
        throw new ConflictException("Administrators cannot grant a new role to themselves");
      }
      const binding = await upsertBinding(transaction, {
        createdBy: principal.userId,
        roleId: role.id,
        scope: targetScope,
        userId: user.id,
      });
      const persisted = persistedAccessScope(targetScope);
      await auditRoleChange(transaction, {
        action: "role-binding.grant",
        actorUserId: principal.userId,
        bindingId: binding.id,
        enterpriseId: persisted.enterpriseId ?? undefined,
        reason: input.reason,
        state: { phone: user.phone, roleCode: role.code, scopeId: persisted.scopeId },
        tenantId: persisted.tenantId ?? undefined,
      });
      return bindingView(transaction, binding.id);
    });
  }

  private async createAdminUser(
    principal: ReturnType<RequestAccessContext["requireSaasAdmin"]>,
    targetScope: AccessScope,
    input: CreateAdminUserDto,
  ) {
    const roleCodes = [...new Set(input.roleCodes)];
    return withAdminUserConflictTranslation(() =>
      this.prisma.$transaction(async (transaction) => {
        const roles = await transaction.role.findMany({
          include: { permissions: { include: { permission: true } } },
          where: {
            code: { in: roleCodes },
            scopeType: targetScope.type,
            status: "ACTIVE",
          },
        });
        if (roles.length !== roleCodes.length) {
          throw new NotFoundException("One or more backend roles were not found in this scope");
        }
        for (const role of roles) {
          assertCanGovernRole(principal.permissions, role.code);
          assertPermissionSubset(
            principal.permissions,
            role.permissions.map(({ permission }) => permission.code),
          );
        }

        const user = await upsertUser(transaction, input.phone, input, input.username);
        if (user.id === principal.userId) {
          throw new ConflictException("Administrators cannot grant a new role to themselves");
        }

        const persisted = persistedAccessScope(targetScope);
        await transaction.adminOrganizationProfile.upsert({
          create: {
            ...persisted,
            department: input.department,
            jobTitle: input.jobTitle,
            userId: user.id,
          },
          update: { department: input.department, jobTitle: input.jobTitle },
          where: {
            userId_scopeType_scopeId: {
              scopeId: persisted.scopeId,
              scopeType: persisted.scopeType,
              userId: user.id,
            },
          },
        });
        const bindings = [];
        for (const role of roles) {
          bindings.push(
            await upsertBinding(transaction, {
              createdBy: principal.userId,
              roleId: role.id,
              scope: targetScope,
              userId: user.id,
            }),
          );
        }
        await transaction.auditLog.create({
          data: {
            action: "admin-user.add",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId: persisted.enterpriseId,
            metadata: { bindingIds: bindings.map(({ id }) => id) },
            resourceId: user.id,
            resourceType: "AdminUser",
            stateAfter: {
              department: input.department ?? null,
              email: input.email ?? null,
              jobTitle: input.jobTitle ?? null,
              name: input.name,
              phone: user.phone,
              username: user.username,
              roleCodes,
              scopeId: persisted.scopeId,
              scopeType: persisted.scopeType,
            },
            tenantId: persisted.tenantId,
          },
        });
        return this.adminUserById(transaction, user.id, scopeFilter(targetScope));
      }),
    );
  }

  private async updateAdminUser(
    principal: ReturnType<RequestAccessContext["requireSaasAdmin"]>,
    targetScope: AccessScope,
    userId: string,
    input: UpdateAdminUserProfileDto,
  ) {
    const persisted = persistedAccessScope(targetScope);
    return withAdminUserConflictTranslation(() =>
      this.prisma.$transaction(async (transaction) => {
        const current = await transaction.adminUser.findFirst({
          where: { id: userId, roleBindings: { some: exactScopeBindingWhere(targetScope) } },
        });
        if (!current) throw new NotFoundException("Backend user was not found in this scope");
        await assertAdminEmailAvailable(transaction, input.email, current.id);
        const user = await transaction.adminUser.update({
          data: {
            email: input.email ?? current.email,
            name: input.name,
            ...resetChangedAdminEmail(current.email, input.email),
          },
          where: { id: userId, AND: { email: current.email } },
        });
        await transaction.adminOrganizationProfile.upsert({
          create: {
            ...persisted,
            department: input.department,
            jobTitle: input.jobTitle,
            userId,
          },
          update: { department: input.department, jobTitle: input.jobTitle },
          where: {
            userId_scopeType_scopeId: {
              scopeId: persisted.scopeId,
              scopeType: persisted.scopeType,
              userId,
            },
          },
        });
        await transaction.auditLog.create({
          data: {
            action: "admin-user.profile.update",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId: persisted.enterpriseId,
            resourceId: user.id,
            resourceType: "AdminUser",
            stateAfter: {
              department: input.department ?? null,
              email: user.email,
              jobTitle: input.jobTitle ?? null,
              name: user.name,
            },
            stateBefore: { email: current.email, name: current.name },
            tenantId: persisted.tenantId,
          },
        });
        return this.adminUserById(transaction, user.id, scopeFilter(targetScope));
      }),
    );
  }

  private listAdminUsers(where: Readonly<{ tenantId: string; enterpriseId?: string }>) {
    return this.prisma.adminUser
      .findMany({
        include: adminUserInclude(where),
        orderBy: [{ name: "asc" }, { phone: "asc" }],
        where: { roleBindings: { some: where } },
      })
      .then((users) => users.map(adminUserView));
  }

  private adminUserById(
    transaction: Prisma.TransactionClient,
    userId: string,
    where: Readonly<{ tenantId: string; enterpriseId?: string }>,
  ) {
    return transaction.adminUser
      .findUniqueOrThrow({ include: adminUserInclude(where), where: { id: userId } })
      .then(adminUserView);
  }

  private async revokeWithinScope(
    principal: ReturnType<RequestAccessContext["requireSaasAdmin"]>,
    whereScope: Readonly<{ tenantId: string; enterpriseId?: string }>,
    bindingId: string,
    input: RevokeRoleBindingDto,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const binding = await transaction.roleBinding.findFirst({
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
          user: true,
        },
        where: { id: bindingId, ...whereScope },
      });
      if (!binding) {
        throw new NotFoundException("Role binding was not found in the active scope");
      }
      if (binding.userId === principal.userId) {
        throw new ConflictException("Administrators cannot revoke their own active role binding");
      }
      assertCanGovernRole(principal.permissions, binding.role.code);
      assertPermissionSubset(
        principal.permissions,
        binding.role.permissions.map(({ permission }) => permission.code),
      );
      await assertCanRemoveOrganizationAdministrator(transaction, binding);
      await transaction.roleBinding.delete({ where: { id: binding.id } });
      await auditRoleChange(transaction, {
        action: "role-binding.revoke",
        actorUserId: principal.userId,
        bindingId: binding.id,
        enterpriseId: binding.enterpriseId ?? undefined,
        reason: input.reason,
        state: { phone: binding.user.phone, roleCode: binding.role.code, scopeId: binding.scopeId },
        tenantId: binding.tenantId ?? undefined,
      });
      return { id: binding.id, revoked: true };
    });
  }

  private async resolveTenantTargetScope(
    tenantId: string,
    input: Readonly<{ enterpriseId?: string; scopeType: GrantScopeType }>,
  ): Promise<AccessScope> {
    if (input.scopeType === GrantScopeType.TENANT) {
      if (input.enterpriseId) {
        throw new ConflictException("enterpriseId is not allowed for a tenant role");
      }
      return tenantAccessScope(tenantId);
    }
    if (!input.enterpriseId) {
      throw new ConflictException("enterpriseId is required for an enterprise role");
    }
    const enterprise = await this.prisma.enterprise.findFirst({
      select: { id: true },
      where: { id: input.enterpriseId, status: "ACTIVE", tenantId },
    });
    if (!enterprise) {
      throw new NotFoundException("Enterprise was not found in the active tenant");
    }
    return enterpriseAccessScope(tenantId, enterprise.id);
  }

  private requirePlatform() {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ForbiddenException("This operation requires platform scope");
    }
    return principal;
  }

  private requireTenant(tenantId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "TENANT" || principal.scope.tenantId !== tenantId) {
      throw new ForbiddenException("Active request scope does not match the requested tenant");
    }
    return principal;
  }

  private requireEnterprise(tenantId: string, enterpriseId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== tenantId ||
      principal.scope.enterpriseId !== enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match the requested enterprise");
    }
    return principal;
  }
}

function adminUserInclude(where: Readonly<{ tenantId: string; enterpriseId?: string }>) {
  return {
    adminSessions: {
      select: { id: true },
      where: { expiresAt: { gt: new Date() }, revokedAt: null },
    },
    organizationProfiles: {
      include: {
        enterprise: { select: { id: true, name: true } },
        tenant: { select: { id: true, name: true } },
      },
      where,
    },
    roleBindings: {
      include: {
        enterprise: { select: { id: true, name: true } },
        role: { select: { code: true, description: true, name: true } },
        tenant: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" as const },
      where,
    },
  } as const satisfies Prisma.AdminUserInclude;
}

type AdminUserRecord = Prisma.AdminUserGetPayload<{
  include: ReturnType<typeof adminUserInclude>;
}>;

function adminUserView(user: AdminUserRecord) {
  const profiles = new Map(
    user.organizationProfiles.map((profile) => [
      `${profile.scopeType}:${profile.scopeId}`,
      profile,
    ]),
  );
  const scopes = new Map<
    string,
    {
      department: string | null;
      enterprise: { id: string; name: string } | null;
      jobTitle: string | null;
      roles: Array<{ bindingId: string; code: string; description: string | null; name: string }>;
      scopeId: string;
      scopeType: "ENTERPRISE" | "PLATFORM" | "TENANT";
      tenant: { id: string; name: string } | null;
    }
  >();
  for (const binding of user.roleBindings) {
    const key = `${binding.scopeType}:${binding.scopeId}`;
    const profile = profiles.get(key);
    const scope = scopes.get(key) ?? {
      department: profile?.department ?? null,
      enterprise: binding.enterprise,
      jobTitle: profile?.jobTitle ?? null,
      roles: [],
      scopeId: binding.scopeId,
      scopeType: binding.scopeType,
      tenant: binding.tenant,
    };
    scope.roles.push({
      bindingId: binding.id,
      code: binding.role.code,
      description: binding.role.description,
      name: binding.role.name,
    });
    scopes.set(key, scope);
  }
  return {
    activeSessionCount: user.adminSessions.length,
    createdAt: user.createdAt,
    email: user.email,
    id: user.id,
    lastLoginAt: user.lastLoginAt,
    name: user.name,
    phone: user.phone,
    username: user.username,
    scopes: [...scopes.values()],
    status: user.status,
    updatedAt: user.updatedAt,
  };
}

function scopeFilter(scope: AccessScope): Readonly<{ tenantId: string; enterpriseId?: string }> {
  if (scope.type === "PLATFORM") {
    throw new ConflictException("Platform users are managed from the platform console");
  }
  return scope.type === "TENANT"
    ? { tenantId: scope.tenantId }
    : { enterpriseId: scope.enterpriseId, tenantId: scope.tenantId };
}

function exactScopeBindingWhere(scope: AccessScope): Prisma.RoleBindingWhereInput {
  const persisted = persistedAccessScope(scope);
  return {
    enterpriseId: persisted.enterpriseId,
    scopeId: persisted.scopeId,
    scopeType: persisted.scopeType,
    tenantId: persisted.tenantId,
  };
}

function normalizedAdminPhone(rawPhone: string): string {
  try {
    return normalizeChineseMobilePhone(rawPhone);
  } catch (error) {
    throw new ConflictException(error instanceof Error ? error.message : "Phone is invalid");
  }
}

async function upsertUser(
  transaction: Prisma.TransactionClient,
  rawPhone: string | undefined,
  profile?: Readonly<{ email?: string; name?: string; password?: string }>,
  rawUsername?: string,
) {
  if ((!rawPhone && !rawUsername) || (rawPhone && rawUsername))
    throw new ConflictException("请提供账号名或历史手机号之一");
  if (profile?.password && !rawUsername)
    throw new ConflictException("设置登录密码时必须提供账号名");
  const username = rawUsername ? normalizeUsername(rawUsername) : undefined;
  const phone = rawPhone ? normalizedAdminPhone(rawPhone) : undefined;
  const existing = await transaction.adminUser.findUnique({
    where: username ? { username } : { phone },
  });
  if (username && !existing && !profile?.password)
    throw new NotFoundException("账号不存在，新增账号时请设置登录密码");
  if (existing && profile?.password)
    throw new ConflictException("账号已存在，授权时请留空密码；此操作不会修改已有密码");
  if (username && existing && !existing.passwordHash)
    throw new ConflictException("该账号尚未设置登录密码，请先通过受信任的密码恢复工具处理");
  if (existing?.status === "DISABLED")
    throw new ConflictException(
      "This backend account is disabled and must be restored by a platform administrator",
    );
  await assertAdminEmailAvailable(transaction, profile?.email, existing?.id);
  if (!existing) {
    return transaction.adminUser.create({
      data: {
        email: profile?.email,
        name: profile?.name,
        phone,
        username,
        passwordHash: profile?.password ? await hashPassword(profile.password) : undefined,
      },
    });
  }
  if (!profile?.email && !profile?.name) return existing;
  return transaction.adminUser.update({
    data: {
      email: profile.email ?? existing.email,
      name: profile.name ?? existing.name,
      ...resetChangedAdminEmail(existing.email, profile.email),
    },
    where: { id: existing.id, AND: { email: existing.email } },
  });
}

async function upsertAdminOrganizationProfile(
  transaction: Prisma.TransactionClient,
  userId: string,
  scope: AccessScope,
  profile: Readonly<{ department?: string; jobTitle?: string }>,
) {
  const persisted = persistedAccessScope(scope);
  return transaction.adminOrganizationProfile.upsert({
    create: {
      ...persisted,
      department: profile.department,
      jobTitle: profile.jobTitle,
      userId,
    },
    update: { department: profile.department, jobTitle: profile.jobTitle },
    where: {
      userId_scopeType_scopeId: {
        scopeId: persisted.scopeId,
        scopeType: persisted.scopeType,
        userId,
      },
    },
  });
}

async function upsertBinding(
  transaction: Prisma.TransactionClient,
  input: Readonly<{ userId: string; roleId: string; scope: AccessScope; createdBy?: string }>,
) {
  const scope = persistedAccessScope(input.scope);
  return transaction.roleBinding.upsert({
    create: {
      ...scope,
      createdBy: input.createdBy,
      roleId: input.roleId,
      userId: input.userId,
    },
    update: {},
    where: {
      userId_roleId_scopeType_scopeId: {
        roleId: input.roleId,
        scopeId: scope.scopeId,
        scopeType: scope.scopeType,
        userId: input.userId,
      },
    },
  });
}

function bindingView(transaction: Prisma.TransactionClient, bindingId: string) {
  return transaction.roleBinding.findUniqueOrThrow({
    include: {
      role: true,
      user: {
        select: { email: true, id: true, name: true, phone: true, username: true, status: true },
      },
    },
    where: { id: bindingId },
  });
}

async function platformAdministratorByBinding(
  transaction: Prisma.TransactionClient,
  bindingId: string,
) {
  const now = new Date();
  const binding = await transaction.roleBinding.findUniqueOrThrow({
    include: {
      role: { select: { code: true } },
      user: {
        select: {
          adminSessions: {
            select: { id: true },
            where: { expiresAt: { gt: now }, revokedAt: null },
          },
          email: true,
          id: true,
          lastLoginAt: true,
          name: true,
          organizationProfiles: {
            select: { department: true, jobTitle: true },
            take: 1,
            where: { scopeId: "platform", scopeType: "PLATFORM" },
          },
          phone: true,
          username: true,
          status: true,
        },
      },
    },
    where: { id: bindingId },
  });
  return platformAdministratorView(binding);
}

function platformAdministratorView(binding: {
  createdAt: Date;
  id: string;
  role: { code: string };
  user: {
    adminSessions: readonly unknown[];
    email: string | null;
    id: string;
    lastLoginAt: Date | null;
    name: string | null;
    organizationProfiles: readonly { department: string | null; jobTitle: string | null }[];
    phone: string | null;
    username: string | null;
    status: GlobalUserStatus;
  };
}) {
  return {
    activeSessionCount: binding.user.adminSessions.length,
    bindingId: binding.id,
    createdAt: binding.createdAt,
    department: binding.user.organizationProfiles[0]?.department ?? null,
    email: binding.user.email,
    jobTitle: binding.user.organizationProfiles[0]?.jobTitle ?? null,
    lastLoginAt: binding.user.lastLoginAt,
    name: binding.user.name,
    phone: binding.user.phone,
    username: binding.user.username,
    roleCode: binding.role.code,
    status: binding.user.status,
    userId: binding.user.id,
  };
}

async function requirePlatformAdministratorUser(
  transaction: Prisma.TransactionClient,
  userId: string,
) {
  const user = await transaction.adminUser.findFirst({
    where: {
      id: userId,
      roleBindings: {
        some: {
          role: { code: "PLATFORM_ADMIN", status: "ACTIVE" },
          scopeId: "platform",
          scopeType: "PLATFORM",
        },
      },
    },
  });
  if (!user) throw new NotFoundException("Platform administrator account was not found");
  return user;
}

async function assertCanRemoveActivePlatformAdmin(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const target = await transaction.adminUser.findUnique({
    select: { status: true },
    where: { id: userId },
  });
  if (target?.status !== "ACTIVE") return;
  await lockAdministratorScope(transaction, "PLATFORM:platform");
  const activeBindings = await transaction.roleBinding.count({
    where: {
      role: { code: "PLATFORM_ADMIN", status: "ACTIVE" },
      scopeId: "platform",
      scopeType: "PLATFORM",
      user: { status: "ACTIVE" },
    },
  });
  if (activeBindings <= 1) {
    throw new ConflictException({
      code: "LAST_PLATFORM_ADMIN_PROTECTED",
      message: "The final active platform administrator cannot be revoked or disabled",
    });
  }
}

async function assertCanRemoveOrganizationAdministrator(
  transaction: Prisma.TransactionClient,
  binding: Readonly<{
    enterpriseId: string | null;
    role: { code: string };
    scopeId: string;
    scopeType: string;
    tenantId: string | null;
    user: { status: GlobalUserStatus };
  }>,
): Promise<void> {
  if (binding.user.status !== "ACTIVE") return;

  if (binding.role.code === "TENANT_ADMIN" && binding.scopeType === "TENANT") {
    await lockAdministratorScope(transaction, `TENANT:${binding.scopeId}`);
    const activeAdministrators = await transaction.roleBinding.count({
      where: {
        role: { code: "TENANT_ADMIN", status: "ACTIVE" },
        scopeId: binding.scopeId,
        scopeType: "TENANT",
        user: { status: "ACTIVE" },
      },
    });
    if (activeAdministrators <= 1) {
      throw new ConflictException({
        code: "LAST_TENANT_ADMIN_PROTECTED",
        message: "集团必须保留至少一名有效集团管理员",
      });
    }
    return;
  }

  if (
    binding.role.code !== "ENTERPRISE_ADMIN" ||
    binding.scopeType !== "ENTERPRISE" ||
    !binding.tenantId ||
    !binding.enterpriseId
  ) {
    return;
  }
  const tenant = await transaction.tenant.findUnique({
    select: { customerType: true },
    where: { id: binding.tenantId },
  });
  if (tenant?.customerType !== "SINGLE_ENTERPRISE") return;

  await lockAdministratorScope(transaction, `ENTERPRISE:${binding.enterpriseId}`);
  const activeAdministrators = await transaction.roleBinding.count({
    where: {
      enterpriseId: binding.enterpriseId,
      role: { code: "ENTERPRISE_ADMIN", status: "ACTIVE" },
      scopeId: binding.enterpriseId,
      scopeType: "ENTERPRISE",
      tenantId: binding.tenantId,
      user: { status: "ACTIVE" },
    },
  });
  if (activeAdministrators <= 1) {
    throw new ConflictException({
      code: "LAST_SINGLE_ENTERPRISE_ADMIN_PROTECTED",
      message: "单体企业必须保留至少一名有效企业管理员",
    });
  }
}

async function assertAdminEmailAvailable(
  transaction: Prisma.TransactionClient,
  email: string | undefined,
  currentUserId?: string,
): Promise<void> {
  if (!email) return;
  const duplicate = await transaction.adminUser.findFirst({
    select: { id: true },
    where: {
      email: { equals: email, mode: "insensitive" },
      id: currentUserId ? { not: currentUserId } : undefined,
    },
  });
  if (duplicate) throw adminEmailConflict();
}

async function withAdminUserConflictTranslation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isAdminEmailUniqueConflict(error)) throw adminEmailConflict();
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new ConflictException("账号或手机号已被使用，请刷新后重试");
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ConflictException("个人资料已发生变化，请刷新后重新保存");
    }
    throw error;
  }
}

function isAdminEmailUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.some((field) => field === "email")
    : typeof target === "string" && target.includes("email");
}

function adminEmailConflict(): ConflictException {
  return new ConflictException({
    code: "ADMIN_EMAIL_ALREADY_EXISTS",
    message: "该邮箱已被其他后台用户使用",
  });
}

async function lockAdministratorScope(
  transaction: Prisma.TransactionClient,
  scopeKey: string,
): Promise<void> {
  await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`admin-scope:${scopeKey}`}))`;
}

async function revokeAdminSessions(
  transaction: Prisma.TransactionClient,
  userId: string,
  reason: string,
): Promise<number> {
  const updated = await transaction.adminSession.updateMany({
    data: { revokeReason: reason.slice(0, 120), revokedAt: new Date() },
    where: { revokedAt: null, userId },
  });
  return updated.count;
}

async function platformAdministratorAction(transaction: Prisma.TransactionClient, userId: string) {
  const user = await transaction.adminUser.findUniqueOrThrow({
    select: {
      adminSessions: {
        select: { id: true },
        where: { expiresAt: { gt: new Date() }, revokedAt: null },
      },
      id: true,
      status: true,
    },
    where: { id: userId },
  });
  return {
    activeSessionCount: user.adminSessions.length,
    status: user.status,
    userId: user.id,
  };
}

function assertPermissionSubset(
  actorPermissions: readonly string[],
  targetPermissions: string[],
): void {
  const actor = new Set(actorPermissions);
  const excessive = targetPermissions.filter((permission) => !actor.has(permission));
  if (excessive.length > 0) {
    throw new ForbiddenException("Cannot grant or revoke a role with permissions you do not hold");
  }
}

function canGovernRole(actorPermissions: readonly string[], roleCode: string): boolean {
  if (roleCode === "TENANT_ADMIN") return false;
  if (roleCode === "ENTERPRISE_ADMIN") {
    return actorPermissions.includes("tenant.role.manage");
  }
  return true;
}

function assertCanGovernRole(actorPermissions: readonly string[], roleCode: string): void {
  if (canGovernRole(actorPermissions, roleCode)) return;
  if (roleCode === "TENANT_ADMIN") {
    throw new ForbiddenException(
      "集团主管理员不能从客户后台新增或移除，只能通过专门的主管理员转交流程更换",
    );
  }
  throw new ForbiddenException("企业管理员不能新增或移除同级企业管理员，请由集团主管理员操作");
}

async function auditRoleChange(
  transaction: Prisma.TransactionClient,
  input: Readonly<{
    action: string;
    actorUserId: string;
    bindingId: string;
    tenantId?: string;
    enterpriseId?: string;
    reason?: string;
    state: Prisma.InputJsonValue;
  }>,
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      action: input.action,
      actorType: "USER",
      actorUserId: input.actorUserId,
      enterpriseId: input.enterpriseId,
      reason: input.reason,
      resourceId: input.bindingId,
      resourceType: "RoleBinding",
      stateAfter: input.action.endsWith("grant") ? input.state : undefined,
      stateBefore: input.action.endsWith("revoke") ? input.state : undefined,
      tenantId: input.tenantId,
    },
  });
}
