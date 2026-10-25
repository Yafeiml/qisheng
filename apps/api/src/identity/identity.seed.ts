import type { PrismaClient } from "@xhs-agentic/database";
import { normalizeChineseMobilePhone } from "../employee/phone";

export async function seedDevelopmentPlatformAdmin(
  prisma: PrismaClient,
): Promise<{ userId: string } | null> {
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_AUTH !== "true") {
    return null;
  }
  const configuredPhone = process.env.DEV_PLATFORM_ADMIN_PHONE;
  if (!configuredPhone) {
    throw new Error("DEV_PLATFORM_ADMIN_PHONE is required when development auth is enabled");
  }
  const phone = normalizeChineseMobilePhone(configuredPhone);
  const role = await prisma.role.findUnique({ where: { code: "PLATFORM_ADMIN" } });
  if (!role) {
    throw new Error("PLATFORM_ADMIN must be seeded before the development administrator");
  }
  const user = await prisma.adminUser.upsert({
    create: { name: "开发平台管理员", phone, phoneVerifiedAt: new Date() },
    update: { status: "ACTIVE" },
    where: { phone },
  });
  await prisma.roleBinding.upsert({
    create: {
      roleId: role.id,
      scopeId: "platform",
      scopeType: "PLATFORM",
      userId: user.id,
    },
    update: {},
    where: {
      userId_roleId_scopeType_scopeId: {
        roleId: role.id,
        scopeId: "platform",
        scopeType: "PLATFORM",
        userId: user.id,
      },
    },
  });
  return { userId: user.id };
}
