import type { Prisma, PrismaClient } from "@xhs-agentic/database";
import { defaultRoleCatalog, permissionCatalog } from "./permission-catalog";

export type AuthorizationSeedResult = Readonly<{
  permissions: number;
  roles: number;
}>;

export async function seedAuthorizationCatalog(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<AuthorizationSeedResult> {
  const seed = async (transaction: Prisma.TransactionClient): Promise<AuthorizationSeedResult> => {
    const permissionIds = new Map<string, string>();
    for (const definition of permissionCatalog) {
      const permission = await transaction.permission.upsert({
        create: definition,
        update: {
          description: definition.description,
          name: definition.name,
        },
        where: { code: definition.code },
      });
      permissionIds.set(permission.code, permission.id);
    }

    for (const definition of defaultRoleCatalog) {
      const role = await transaction.role.upsert({
        create: {
          code: definition.code,
          description: definition.description,
          isSystem: true,
          name: definition.name,
          scopeType: definition.scopeType,
        },
        update: {
          description: definition.description,
          isSystem: true,
          name: definition.name,
          scopeType: definition.scopeType,
          status: "ACTIVE",
        },
        where: { code: definition.code },
      });

      await transaction.rolePermission.deleteMany({ where: { roleId: role.id } });
      await transaction.rolePermission.createMany({
        data: definition.permissions.map((permissionCode) => {
          const permissionId = permissionIds.get(permissionCode);
          if (!permissionId) {
            throw new Error(`Permission is missing from the catalog: ${permissionCode}`);
          }
          return { permissionId, roleId: role.id };
        }),
      });
    }

    return {
      permissions: permissionCatalog.length,
      roles: defaultRoleCatalog.length,
    };
  };
  return "$transaction" in prisma ? prisma.$transaction(seed) : seed(prisma);
}
