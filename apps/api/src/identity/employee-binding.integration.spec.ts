import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { type Prisma, PrismaClient } from "@xhs-agentic/database";
import { afterAll, describe, expect, it } from "vitest";
import { EmployeeBindingService } from "./employee-binding.service";

const prisma = new PrismaClient();
const rollback = new Error("EMPLOYEE_BINDING_TEST_ROLLBACK");
const previousVerification = new Date("2026-01-01T00:00:00.000Z");
afterAll(() => prisma.$disconnect());

async function isolated(
  state: "verified" | "new" | "unverified" | "disabled",
  run: (
    transaction: Prisma.TransactionClient,
    service: EmployeeBindingService,
    phone: string,
  ) => Promise<void>,
) {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
    !databaseUrl.pathname.startsWith("/dev_")
  )
    throw new Error("Employee binding tests require a local dev_ database");
  try {
    await prisma.$transaction(async (transaction) => {
      const marker = randomUUID();
      const phone = `199${(BigInt(`0x${randomBytes(6).toString("hex")}`) % 100_000_000n)
        .toString()
        .padStart(8, "0")}`;
      const tenant = await transaction.tenant.create({
        data: { name: marker, customerType: "SINGLE_ENTERPRISE" },
      });
      const enterprise = await transaction.enterprise.create({
        data: { tenantId: tenant.id, name: marker, code: marker },
      });
      const user =
        state === "new"
          ? null
          : await transaction.globalUser.create({
              data: {
                phone,
                phoneVerifiedAt: state === "unverified" ? null : previousVerification,
                lastLoginAt: previousVerification,
                status: state === "disabled" ? "DISABLED" : "ACTIVE",
              },
            });
      await transaction.enterpriseMembership.create({
        data: {
          tenantId: tenant.id,
          enterpriseId: enterprise.id,
          globalUserId: user?.id,
          name: marker,
          phone,
          seatStatus: "ENABLED",
          seatEnabledAt: previousVerification,
          status: user ? "ACTIVE" : "PENDING_BIND",
          boundAt: user ? previousVerification : null,
        },
      });
      const service = new EmployeeBindingService(
        {
          $transaction: (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
            operation(transaction),
        } as never,
        { issueEmployeeAccessToken: () => "isolated-employee-token" } as never,
      );
      await run(transaction, service, phone);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe("employee phone verification identity", () => {
  it("keeps queued SMS recipient snapshots valid across normal repeated logins", async () => {
    await isolated("verified", async (transaction, service, phone) => {
      const recipientSnapshot = { phone, phoneVerifiedAt: previousVerification };
      const loginStartedAt = new Date();
      const first = await service.bindVerifiedPhone({ phone });
      const second = await service.bindVerifiedPhone({ phone });
      expect(second.userId).toBe(first.userId);
      const user = await transaction.globalUser.findUniqueOrThrow({ where: { phone } });
      expect(user.phone).toBe(recipientSnapshot.phone);
      expect(user.phoneVerifiedAt?.getTime()).toBe(recipientSnapshot.phoneVerifiedAt.getTime());
      expect(user.lastLoginAt?.getTime()).toBeGreaterThanOrEqual(loginStartedAt.getTime());
      expect(user.status).toBe("ACTIVE");
    });
  });

  it.each(["new", "unverified", "disabled"] as const)(
    "records fresh verification when the employee identity is %s",
    async (state) => {
      await isolated(state, async (transaction, service, phone) => {
        const verificationStartedAt = new Date();
        await service.bindVerifiedPhone({ phone });
        const user = await transaction.globalUser.findUniqueOrThrow({ where: { phone } });
        expect(user.phoneVerifiedAt?.getTime()).toBeGreaterThanOrEqual(
          verificationStartedAt.getTime(),
        );
        expect(user.lastLoginAt).toEqual(user.phoneVerifiedAt);
        expect(user.status).toBe("ACTIVE");
      });
    },
  );
});
