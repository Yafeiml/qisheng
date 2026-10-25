import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import type { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import { PrismaService } from "../database/prisma.service";
import { AdminAccountService } from "./admin-account.service";

const prisma = new PrismaService();
afterAll(() => prisma.$disconnect());

it("rejects a stale email save rather than carrying another address's verification onto it", async () => {
  if (!process.env.DATABASE_URL?.includes("dev_xhs_agentic"))
    throw new Error("Development database required");
  const user = await prisma.adminUser.create({
    data: {
      phone: `test-${randomBytes(8).toString("hex")}`,
      name: "并发测试",
      email: `${randomBytes(8).toString("hex")}@example.test`,
    },
  });
  const concurrentEmail = `new-${user.email}`;
  const authenticator = {
    authenticate: async () => ({ userId: user.id }),
  } as unknown as AdminTokenAuthenticator;
  const staleRead = {
    $transaction: async (callback: (tx: unknown) => unknown) =>
      prisma.$transaction(async (tx) =>
        callback({
          adminUser: {
            findFirst: tx.adminUser.findFirst.bind(tx.adminUser),
            findUnique: async () => {
              // Another request changes and verifies the email after this request's read.
              await prisma.adminUser.update({
                where: { id: user.id },
                data: { email: concurrentEmail, emailVerifiedAt: new Date() },
              });
              return user;
            },
            update: tx.adminUser.update.bind(tx.adminUser),
          },
          auditLog: tx.auditLog,
        }),
      ),
  } as unknown as PrismaService;
  const accounts = new AdminAccountService(authenticator, staleRead);
  try {
    await expect(
      accounts.updateAccount("Bearer test", { name: "新姓名", email: user.email ?? "" }),
    ).rejects.toThrow("个人资料已发生变化");
    expect(await prisma.adminUser.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      email: concurrentEmail,
      emailVerifiedAt: expect.any(Date),
    });
  } finally {
    await prisma.adminUser.delete({ where: { id: user.id } });
  }
});
