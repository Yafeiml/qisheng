import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { RoleBinding } from "@xhs-agentic/database";
import { PrismaService } from "../database/prisma.service";
import {
  type AccessScope,
  canAdministerScope,
  enterpriseWhere,
  persistedAccessScope,
  roleBindingWhere,
  tenantWhere,
} from "./access-scope";

export type CreateRoleBindingInput = Readonly<{
  userId: string;
  roleId: string;
  targetScope: AccessScope;
  createdBy?: string;
}>;

@Injectable()
export class AuthorizationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listRoleBindings(scope: AccessScope, userId?: string): Promise<RoleBinding[]> {
    return this.prisma.roleBinding.findMany({
      orderBy: { createdAt: "asc" },
      where: {
        AND: [roleBindingWhere(scope), userId ? { userId } : {}],
      },
    });
  }

  async createRoleBinding(
    actorScope: AccessScope,
    input: CreateRoleBindingInput,
  ): Promise<RoleBinding> {
    if (!canAdministerScope(actorScope, input.targetScope)) {
      throw new ForbiddenException("Cannot grant a role outside the active scope");
    }

    await this.assertTargetScopeExists(actorScope, input.targetScope);

    const role = await this.prisma.role.findFirst({
      select: { id: true },
      where: {
        id: input.roleId,
        scopeType: input.targetScope.type,
        status: "ACTIVE",
      },
    });
    if (!role) {
      throw new NotFoundException("Active role was not found for the target scope");
    }

    return this.prisma.roleBinding.create({
      data: {
        ...persistedAccessScope(input.targetScope),
        createdBy: input.createdBy,
        roleId: role.id,
        userId: input.userId,
      },
    });
  }

  private async assertTargetScopeExists(
    actorScope: AccessScope,
    targetScope: AccessScope,
  ): Promise<void> {
    if (targetScope.type === "PLATFORM") {
      return;
    }

    if (targetScope.type === "TENANT") {
      const tenant = await this.prisma.tenant.findFirst({
        select: { id: true },
        where: { AND: [tenantWhere(actorScope), { id: targetScope.tenantId }] },
      });
      if (!tenant) {
        throw new NotFoundException("Tenant was not found in the active scope");
      }
      return;
    }

    const enterprise = await this.prisma.enterprise.findFirst({
      select: { id: true },
      where: {
        AND: [
          enterpriseWhere(actorScope),
          { id: targetScope.enterpriseId, tenantId: targetScope.tenantId },
        ],
      },
    });
    if (!enterprise) {
      throw new NotFoundException("Enterprise was not found in the active scope");
    }
  }
}
