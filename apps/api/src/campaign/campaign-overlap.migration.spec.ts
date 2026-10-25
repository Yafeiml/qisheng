import { randomUUID } from "node:crypto";
import { PrismaClient } from "@xhs-agentic/database";
import { expect, it } from "vitest";

it("allows overlapping approved campaign windows in the real migrated database", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.pathname.startsWith("/dev_")
  )
    throw new Error("Campaign migration verification requires a local dev_ database");
  const prisma = new PrismaClient();
  const rollback = new Error("rollback campaign verification fixtures");
  try {
    await expect(
      prisma.$transaction(async (transaction) => {
        const trigger = await transaction.$queryRaw<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid = 'campaigns'::regclass AND tgname = 'campaigns_no_overlapping_delivery_windows' AND NOT tgisinternal`;
        expect(trigger[0]?.count).toBe(0);
        const tenant = await transaction.tenant.create({
          data: { name: "overlap migration verification", customerType: "SINGLE_ENTERPRISE" },
        });
        const enterprise = await transaction.enterprise.create({
          data: {
            tenantId: tenant.id,
            name: "overlap verification",
            code: `overlap-${randomUUID()}`,
          },
        });
        const visibleAt = new Date(Date.now() + 60000);
        const expiresAt = new Date(visibleAt.getTime() + 86400000);
        for (const title of ["first", "second"]) {
          const campaign = await transaction.campaign.create({
            data: {
              tenantId: tenant.id,
              enterpriseId: enterprise.id,
              title,
              prompt: "test",
              createdBy: "migration-verification",
              visibleAt,
              expiresAt,
            },
          });
          await transaction.campaign.update({
            where: { id: campaign.id },
            data: {
              status: "APPROVED",
              approvedBy: "migration-verification",
              approvedAt: new Date(),
            },
          });
        }
        expect(
          await transaction.campaign.count({
            where: { enterpriseId: enterprise.id, status: "APPROVED" },
          }),
        ).toBe(2);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    await prisma.$disconnect();
  }
});
