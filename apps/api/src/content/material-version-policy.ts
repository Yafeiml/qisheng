import { ConflictException } from "@nestjs/common";
import type { Prisma } from "@xhs-agentic/database";

/** Archived replacements must not strand a still-active version. Never reuse a version number. */
export async function nextMaterialVersion(
  transaction: Prisma.TransactionClient,
  source: { id: string; seriesId: string; version: number; status: string },
): Promise<number> {
  const [latest, newerActive] = await Promise.all([
    transaction.material.findFirst({
      where: { seriesId: source.seriesId },
      orderBy: { version: "desc" },
      select: { id: true, version: true },
    }),
    transaction.material.findFirst({
      where: { seriesId: source.seriesId, status: "ACTIVE", version: { gt: source.version } },
      select: { id: true },
    }),
  ]);
  if (!latest || newerActive || (source.status !== "ACTIVE" && latest.id !== source.id)) {
    throw new ConflictException("请编辑最新启用版本；已有新版本正在处理时，请先处理或停用该版本");
  }
  return latest.version + 1;
}
