import { Prisma, type RuntimePolicy } from "@xhs-agentic/database";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import type { ModelConfigurationService } from "../model-configuration/model-configuration.service";
import type { ModelQualificationService } from "../model-configuration/model-qualification.service";
import type { RuntimePolicyService } from "../model-configuration/runtime-policy.service";
import type { PlatformContentSafetyService } from "../platform-settings/platform-content-safety.service";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import {
  type GenerationPreflightResult,
  GenerationPreflightService,
} from "./generation-preflight.service";
import type { GenerationQueueService } from "./generation-queue.service";
import type { ImageDeliveryService } from "./image-delivery.service";

describe("GenerationPreflightService.assertStillCurrent", () => {
  it("rejects a preflight when runtime policy changed before the campaign transaction", async () => {
    const checkedPolicy = policy(new Date("2026-08-29T08:00:00.000Z"));
    const currentPolicy = policy(new Date("2026-08-29T08:01:00.000Z"));
    const assertCurrent = vi.fn();
    const service = createService({ assertCurrent, currentPolicy });

    await expect(
      service.assertStillCurrent(transaction(), preflightResult(checkedPolicy)),
    ).rejects.toThrow("Runtime policy changed after generation preflight");
    expect(assertCurrent).not.toHaveBeenCalled();
  });

  it("passes the transaction-fresh policy into route qualification validation", async () => {
    const checkedPolicy = policy(new Date("2026-08-29T08:00:00.000Z"));
    const currentPolicy = { ...checkedPolicy };
    const assertCurrent = vi.fn().mockResolvedValue(undefined);
    const service = createService({ assertCurrent, currentPolicy });
    const databaseTransaction = transaction();

    await service.assertStillCurrent(databaseTransaction, preflightResult(checkedPolicy));

    expect(assertCurrent).toHaveBeenCalledWith(
      {
        configurationFingerprint: "fingerprint-a",
        deliveryMode: "PRODUCTION",
        qualificationId: "qualification-a",
        routeId: "route-a",
      },
      currentPolicy,
      databaseTransaction,
    );
  });
});

function createService(input: {
  assertCurrent: ReturnType<typeof vi.fn>;
  currentPolicy: RuntimePolicy;
}) {
  return new GenerationPreflightService(
    {} as PrismaService,
    {} as RequestAccessContext,
    {} as TenantCapabilityService,
    {} as ModelConfigurationService,
    { assertCurrent: input.assertCurrent } as unknown as ModelQualificationService,
    {
      current: vi.fn().mockResolvedValue(input.currentPolicy),
    } as unknown as RuntimePolicyService,
    {} as GenerationQueueService,
    {} as ImageDeliveryService,
    {} as PlatformContentSafetyService,
  );
}

function preflightResult(policyValue: RuntimePolicy) {
  return {
    assessment: {
      configurationFingerprint: "fingerprint-a",
      qualification: { id: "qualification-a" },
    },
    deliveryMode: "PRODUCTION",
    frozenRoute: { routeId: "route-a" },
    policy: policyValue,
  } as unknown as GenerationPreflightResult & {
    assessment: NonNullable<GenerationPreflightResult["assessment"]>;
    frozenRoute: NonNullable<GenerationPreflightResult["frozenRoute"]>;
  };
}

function policy(updatedAt: Date): RuntimePolicy {
  return {
    costCurrency: "CNY",
    costWarningThreshold: new Prisma.Decimal(100),
    createdAt: new Date("2026-08-29T07:00:00.000Z"),
    embeddingModelId: null,
    materialAnalysisModelId: null,
    id: "platform-runtime-policy",
    materialChunkOverlapCharacters: 160,
    materialChunkSizeCharacters: 1_200,
    maxActiveGenerationJobs: 1_000,
    maxProviderConcurrentInvocations: 10,
    maxQueueBacklog: 10_000,
    minimumGenerationWorkers: 1,
    providerHealthMaxAgeSeconds: 900,
    retrievalMaxContextCharacters: 12_000,
    retrievalStrategyVersion: "hybrid-v1",
    retrievalTopK: 8,
    routeQualificationMaxAgeSeconds: 86_400,
    updatedAt,
    updatedBy: "platform-admin",
  };
}

function transaction(): Prisma.TransactionClient {
  return {} as Prisma.TransactionClient;
}
