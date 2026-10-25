import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@xhs-agentic/database";
import { seedAuthorizationCatalog } from "../apps/api/src/access/authorization.seed";
import { seedDevelopmentPlatformAdmin } from "../apps/api/src/identity/identity.seed";
import { seedDevelopmentModelRoute } from "../apps/api/src/model-configuration/model-configuration.seed";
import { seedRuntimePolicy } from "../apps/api/src/model-configuration/runtime-policy.seed";
import { seedPlatformSettings } from "../apps/api/src/platform-settings/platform-settings.seed";

const rootEnvPath = resolve(__dirname, "../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const prisma = new PrismaClient();

async function main(): Promise<void> {
  try {
    const result = await seedAuthorizationCatalog(prisma);
    await seedDevelopmentPlatformAdmin(prisma);
    await seedDevelopmentModelRoute(prisma);
    await seedRuntimePolicy(prisma);
    const platformSettings = await seedPlatformSettings(prisma);
    process.stdout.write(
      `MVP seed ready: ${result.permissions} permissions, ${result.roles} roles, ${platformSettings} platform settings.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
