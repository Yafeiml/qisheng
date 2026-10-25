import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import { PrismaService } from "../database/prisma.service";
import { activeAdminRoleBindingWhere } from "./admin-scope-policy";

@Injectable()
export class AdminSessionService {
  constructor(
    @Inject(AdminTokenAuthenticator)
    private readonly tokenAuthenticator: AdminTokenAuthenticator,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async getSession(authorization: string | undefined) {
    const { sessionId, userId } = await this.tokenAuthenticator.authenticate(authorization);
    const user = await this.prisma.adminUser.findFirst({
      include: {
        roleBindings: {
          include: {
            enterprise: { select: { id: true, name: true, status: true } },
            role: {
              include: {
                permissions: { include: { permission: { select: { code: true } } } },
              },
            },
            tenant: { select: { customerType: true, id: true, name: true, status: true } },
          },
          orderBy: { createdAt: "asc" },
          where: activeAdminRoleBindingWhere,
        },
      },
      where: { id: userId, status: "ACTIVE" },
    });
    if (!user || (user.roleBindings.length === 0 && !user.employeeUserId)) {
      throw new UnauthorizedException("Authenticated SaaS administrator has no active role");
    }

    const tenantBindingIds = user.roleBindings.flatMap((binding) =>
      binding.scopeType === "TENANT" && binding.tenantId ? [binding.tenantId] : [],
    );
    const tenantEnterprises = await this.prisma.enterprise.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, status: true, tenantId: true },
      where: { status: "ACTIVE", tenantId: { in: [...new Set(tenantBindingIds)] } },
    });

    return {
      audience: "xhs-saas-admin",
      name: user.name,
      phone: user.phone,
      username: user.username,
      sessionId,
      scopes: user.roleBindings.map((binding) => ({
        enterprise:
          binding.enterprise?.status === "ACTIVE"
            ? { id: binding.enterprise.id, name: binding.enterprise.name }
            : null,
        inheritedEnterprises:
          binding.scopeType === "TENANT"
            ? tenantEnterprises
                .filter(({ tenantId }) => tenantId === binding.tenantId)
                .map(({ id, name }) => ({ id, name }))
            : [],
        permissions: binding.role.permissions.map(({ permission }) => permission.code).sort(),
        role: { code: binding.role.code, name: binding.role.name },
        scopeId: binding.scopeId,
        scopeType: binding.scopeType,
        tenant:
          binding.tenant?.status === "ACTIVE"
            ? {
                customerType: binding.tenant.customerType,
                id: binding.tenant.id,
                name: binding.tenant.name,
              }
            : null,
      })),
      userId: user.id,
    };
  }
}
