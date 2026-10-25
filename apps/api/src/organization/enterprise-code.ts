import { randomBytes } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import type { PrismaService } from "../database/prisma.service";

export function generateEnterpriseCode(): string {
  return `ENT_${randomBytes(16).toString("hex").toUpperCase()}`;
}

/** Check the whole directory; the database unique index also resolves concurrent requests. */
export async function withGeneratedEnterpriseCode<T>(
  prisma: PrismaService,
  create: (code: string) => Promise<T>,
  candidate: () => string = generateEnterpriseCode,
): Promise<T> {
  for (let index = 0; index < 5; index++) {
    const code = candidate();
    if (await prisma.enterprise.findFirst({ where: { code }, select: { id: true } })) continue;
    try {
      return await create(code);
    } catch (error) {
      if (!isEnterpriseCodeConflict(error)) throw error;
    }
  }
  throw new ConflictException("企业代码暂时无法生成，请重试");
}

function uniqueTarget(error: unknown): unknown {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    ? error.meta?.target
    : undefined;
}

function matchesUniqueTarget(error: unknown, field: string, index: string): boolean {
  const target = uniqueTarget(error);
  return Array.isArray(target)
    ? target.includes(field)
    : typeof target === "string" && target === index;
}

export function isEnterpriseCodeConflict(error: unknown): boolean {
  return (
    matchesUniqueTarget(error, "code", "enterprises_code_key") ||
    matchesUniqueTarget(error, "code", "enterprises_tenant_id_code_key")
  );
}
