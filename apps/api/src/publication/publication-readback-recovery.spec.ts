import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../database/prisma.service";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { recoverDisabledReadbackLeases } from "./publication-readback-recovery";

function fixture() {
  const job = {
    id: "job",
    submissionId: "submission",
    leaseToken: "unique-lease",
    leaseExpiresAt: new Date(Date.now() - 1000),
  };
  const prisma = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    publicationCollectionJob: {
      findMany: vi.fn().mockResolvedValue([job]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    publishSubmission: { updateMany: vi.fn() },
  };
  prisma.$transaction.mockImplementation((callback) => callback(prisma));
  const settings = {
    resolve: vi.fn().mockResolvedValue({ value: false }),
    resolveMany: vi
      .fn()
      .mockResolvedValue(new Map([["publication.readback_enabled", { value: false }]])),
  };
  const recover = () =>
    recoverDisabledReadbackLeases(
      prisma as unknown as PrismaService,
      settings as unknown as PlatformSettingsReader,
      { tenantId: "tenant", enterpriseId: "enterprise" },
    );
  return { job, prisma, settings, recover };
}

describe("disabled readback lease recovery", () => {
  it("only scans expired leased jobs in the requested enterprise and uses an exact lease CAS", async () => {
    const { recover, prisma, job } = fixture();
    await recover();
    expect(prisma.publicationCollectionJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "READBACK",
          status: "LEASED",
          leaseExpiresAt: { lte: expect.any(Date) },
          submission: { tenantId: "tenant", task: { enterpriseId: "enterprise" } },
        }),
      }),
    );
    expect(prisma.publicationCollectionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: job.id,
          kind: "READBACK",
          status: "LEASED",
          leaseToken: job.leaseToken,
          leaseExpiresAt: job.leaseExpiresAt,
        },
        data: expect.objectContaining({
          status: "NEEDS_REVIEW",
          errorCode: "LEASE_OUTCOME_UNKNOWN",
        }),
      }),
    );
    expect(prisma.publishSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: job.submissionId, status: "VERIFYING" },
        data: expect.objectContaining({ status: "MANUAL_REVIEW" }),
      }),
    );
  });

  it("does nothing if readback is enabled, including re-enabled during lock acquisition", async () => {
    const { recover, settings, prisma } = fixture();
    settings.resolve.mockResolvedValueOnce({ value: true });
    await recover();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    settings.resolveMany.mockResolvedValueOnce(
      new Map([["publication.readback_enabled", { value: true }]]),
    );
    await recover();
    expect(prisma.publicationCollectionJob.findMany).not.toHaveBeenCalled();
  });

  it("does not change a submission if another actor already settled its lease", async () => {
    const { recover, prisma } = fixture();
    prisma.publicationCollectionJob.updateMany.mockResolvedValueOnce({ count: 0 });
    await recover();
    expect(prisma.publishSubmission.updateMany).not.toHaveBeenCalled();
  });
});
