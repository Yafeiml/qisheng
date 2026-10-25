import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Scope,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Prisma } from "@xhs-agentic/database";
import { PrismaService } from "../database/prisma.service";
import {
  type AccessScope,
  enterpriseAccessScope,
  platformAccessScope,
  tenantAccessScope,
} from "./access-scope";
import { AdminTokenAuthenticator } from "./admin-token-authenticator";
import type { PermissionCode } from "./permission-catalog";
import { RequestAccessContext } from "./request-access-context";
import {
  ADMIN_ACCESS_REQUIREMENT,
  type AdminAccessRequirement,
} from "./require-admin-access.decorator";

type HttpRequest = Readonly<{
  headers: Readonly<Record<string, string | string[] | undefined>>;
  params: Readonly<Record<string, string | undefined>>;
}>;

@Injectable({ scope: Scope.REQUEST })
export class AdminAccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AdminTokenAuthenticator)
    private readonly tokenAuthenticator: AdminTokenAuthenticator,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<AdminAccessRequirement>(
      ADMIN_ACCESS_REQUIREMENT,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) {
      throw new ForbiddenException("Admin route has no access requirement");
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const { userId } = await this.tokenAuthenticator.authenticate(request.headers.authorization);

    const scope = requestedScope(requirement, request.params);
    await this.requireActiveScope(scope);
    const bindings = await this.prisma.roleBinding.findMany({
      select: {
        role: {
          select: {
            permissions: {
              select: { permission: { select: { code: true } } },
            },
          },
        },
      },
      where: {
        ...eligibleBindingWhere(scope),
        role: { status: "ACTIVE" },
        userId,
      },
    });
    if (bindings.length === 0) {
      throw new ForbiddenException("No active role binding grants access to this scope");
    }

    const permissions = new Set(
      bindings.flatMap(({ role }) =>
        role.permissions.map(({ permission }) => permission.code as PermissionCode),
      ),
    );
    const missing = requirement.permissions.filter((permission) => !permissions.has(permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing required permission: ${missing.join(", ")}`);
    }

    this.accessContext.initialize({
      audience: "SAAS_ADMIN",
      permissions: Object.freeze([...permissions]),
      scope,
      userId,
    });
    return true;
  }

  private async requireActiveScope(scope: AccessScope): Promise<void> {
    if (scope.type === "PLATFORM") return;
    const active =
      scope.type === "TENANT"
        ? await this.prisma.tenant.count({ where: { id: scope.tenantId, status: "ACTIVE" } })
        : await this.prisma.enterprise.count({
            where: {
              id: scope.enterpriseId,
              status: "ACTIVE",
              tenant: { status: "ACTIVE" },
              tenantId: scope.tenantId,
            },
          });
    if (active !== 1) {
      throw new ForbiddenException("Requested tenant or enterprise is suspended or disabled");
    }
  }
}

function requestedScope(
  requirement: AdminAccessRequirement,
  params: HttpRequest["params"],
): AccessScope {
  switch (requirement.scope) {
    case "PLATFORM":
      return platformAccessScope();
    case "TENANT":
      return tenantAccessScope(requiredRouteParam(params, "tenantId"));
    case "ENTERPRISE":
      return enterpriseAccessScope(
        requiredRouteParam(params, "tenantId"),
        requiredRouteParam(params, "enterpriseId"),
      );
  }
}

function eligibleBindingWhere(scope: AccessScope): Prisma.RoleBindingWhereInput {
  switch (scope.type) {
    case "PLATFORM":
      return { scopeId: "platform", scopeType: "PLATFORM" };
    case "TENANT":
      return {
        enterpriseId: null,
        scopeId: scope.tenantId,
        scopeType: "TENANT",
        tenantId: scope.tenantId,
      };
    case "ENTERPRISE":
      return {
        OR: [
          {
            enterpriseId: null,
            scopeId: scope.tenantId,
            scopeType: "TENANT",
            tenantId: scope.tenantId,
          },
          {
            enterpriseId: scope.enterpriseId,
            scopeId: scope.enterpriseId,
            scopeType: "ENTERPRISE",
            tenantId: scope.tenantId,
          },
        ],
      };
  }
}

function requiredRouteParam(
  params: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = params[name];
  if (!value) {
    throw new ForbiddenException(`Route is missing required scope parameter: ${name}`);
  }
  return value;
}
