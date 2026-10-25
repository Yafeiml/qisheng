import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@xhs-agentic/database";
import { normalizeChineseMobilePhone } from "../employee/phone";
import { activeAdminRoleBindingWhere } from "./admin-scope-policy";
import { hashPassword, normalizeUsername } from "./password";

export async function setExistingAdministratorPassword(
  prisma: PrismaClient,
  input: { phone: string; username: string; password: string },
) {
  const phone = normalizeChineseMobilePhone(input.phone);
  const username = normalizeUsername(input.username);
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (transaction) => {
      const user = await transaction.adminUser.findFirst({
        where: {
          phone,
          status: "ACTIVE",
          roleBindings: { some: activeAdminRoleBindingWhere },
        },
      });
      if (!user)
        throw new NotFoundException("未找到该手机号对应的有效管理员；此命令不会新增账号或授予权限");
      await transaction.adminUser.update({
        where: { id: user.id },
        data: { username, passwordHash },
      });
      await transaction.adminSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "PASSWORD_RECOVERED_BY_OPERATOR" },
      });
      await transaction.auditLog.create({
        data: {
          action: "admin-account.password.operator-set",
          actorType: "SYSTEM",
          actorUserId: user.id,
          resourceType: "AdminUser",
          resourceId: user.id,
          reason: "本机受信任操作员交互设置账号密码",
          stateBefore: { username: user.username },
          stateAfter: { username },
        },
      });
      return { userId: user.id, username };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new ConflictException("该账号名已被使用，未修改原账号");
    throw error;
  }
}
