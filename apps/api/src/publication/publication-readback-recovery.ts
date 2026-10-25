import type { PrismaService } from "../database/prisma.service";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";

export async function recoverDisabledReadbackLeases(
  prisma: PrismaService,
  settings: PlatformSettingsReader,
  scope?: Readonly<{ tenantId: string; enterpriseId: string }>,
) {
  if ((await settings.resolve("publication.readback_enabled")).value === true) return;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910101::bigint)`;
    if (
      (await settings.resolveMany(["publication.readback_enabled"], tx)).get(
        "publication.readback_enabled",
      )?.value === true
    )
      return;
    const now = new Date();
    const expired = await tx.publicationCollectionJob.findMany({
      select: { id: true, submissionId: true, leaseToken: true, leaseExpiresAt: true },
      orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
      take: 100,
      where: {
        kind: "READBACK",
        status: "LEASED",
        leaseExpiresAt: { lte: now },
        ...(scope
          ? { submission: { tenantId: scope.tenantId, task: { enterpriseId: scope.enterpriseId } } }
          : {}),
      },
    });
    for (const job of expired) {
      const changed = await tx.publicationCollectionJob.updateMany({
        where: {
          id: job.id,
          kind: "READBACK",
          status: "LEASED",
          leaseToken: job.leaseToken,
          leaseExpiresAt: job.leaseExpiresAt,
        },
        data: { status: "NEEDS_REVIEW", errorCode: "LEASE_OUTCOME_UNKNOWN", completedAt: now },
      });
      if (changed.count !== 1) continue;
      await tx.publishSubmission.updateMany({
        where: { id: job.submissionId, status: "VERIFYING" },
        data: {
          status: "MANUAL_REVIEW",
          failureReason: "自动回读已停用且原工作单租约已过期，提交事实已保留，等待人工复核",
          verificationFinishedAt: now,
        },
      });
    }
  });
}
