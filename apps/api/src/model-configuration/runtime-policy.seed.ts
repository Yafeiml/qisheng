import type { Prisma, PrismaClient } from "@xhs-agentic/database";
import { PLATFORM_RUNTIME_POLICY_ID } from "./runtime-policy.constants";

export async function seedRuntimePolicy(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<void> {
  await prisma.runtimePolicy.upsert({
    create: { id: PLATFORM_RUNTIME_POLICY_ID, updatedBy: "system:seed" },
    update: {},
    where: { id: PLATFORM_RUNTIME_POLICY_ID },
  });
}
