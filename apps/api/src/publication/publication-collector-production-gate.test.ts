import { expect, it } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import type { PlatformPublicationVerificationService } from "../platform-settings/platform-publication-verification.service";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { PublicationCollectorService } from "./publication-collector.service";

it("pauses production browser collection before reading or claiming stored jobs", async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const service = new PublicationCollectorService(
      {} as PrismaService,
      {} as RequestAccessContext,
      {} as PlatformPublicationVerificationService,
      {} as TenantCapabilityService,
      {} as PlatformSettingsReader,
    );
    await expect(service.status()).resolves.toEqual({
      paused: true,
      reason: "PUBLICATION_BROWSER_PRODUCTION_NOT_READY",
    });
    await expect(service.claim()).resolves.toEqual({
      job: null,
      paused: true,
      reason: "PUBLICATION_BROWSER_PRODUCTION_NOT_READY",
    });
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});
