import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@xhs-agentic/database";
import { MemoryObjectStorage } from "@xhs-agentic/object-storage";
import { describe, expect, it } from "vitest";
import { WorkerStorageQuota } from "./storage-quota";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

describe("worker storage capability boundary", { concurrent: false }, () => {
  it("enforces the configured tenant storage capability", async () => {
    assertDevelopmentDatabase();
    const prisma = new PrismaClient();
    const storage = new MemoryObjectStorage();
    const quota = new WorkerStorageQuota(prisma, storage);
    const marker = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    let tenantId = "";

    try {
      const fixture = await prisma.$transaction(async (transaction) => {
        const tenant = await transaction.tenant.create({
          data: { customerType: "GROUP", name: `worker-storage-${marker}` },
        });
        await transaction.tenantCapabilityPolicy.create({
          data: { storageLimitBytes: 1_024n, tenantId: tenant.id },
        });
        return { tenantId: tenant.id };
      });
      tenantId = fixture.tenantId;

      await expect(
        quota.reserve({
          byteSize: 32,
          expiresAt: new Date(Date.now() + 60_000),
          reservationKey: `worker-storage:${marker}`,
          resourceId: marker,
          resourceType: "GENERATED_IMAGE",
          storageKey: `worker-storage/${marker}.png`,
          tenantId,
        }),
      ).resolves.toMatchObject({ byteSize: 32n, tenantId });
      await expect(prisma.storageReservation.count({ where: { tenantId } })).resolves.toBe(1);
    } finally {
      if (tenantId) {
        await prisma.storageUsageLedger.deleteMany({ where: { tenantId } });
        await prisma.storageReservation.deleteMany({ where: { tenantId } });
        await prisma.tenantStorageAccount.deleteMany({ where: { tenantId } });
        await prisma.tenantCapabilityPolicy.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
      await prisma.$disconnect();
    }
  });
});

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!/\/dev_[^/?]+(?:\?|$)/u.test(databaseUrl)) {
    throw new Error("Worker storage integration test requires a dedicated dev_* database");
  }
}
