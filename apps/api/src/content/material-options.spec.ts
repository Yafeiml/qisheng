import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import { ADMIN_ACCESS_REQUIREMENT } from "../access/require-admin-access.decorator";
import type { PrismaService } from "../database/prisma.service";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { ContentController } from "./content.controller";
import { ContentService } from "./content.service";
import type { MaterialIngestionService } from "./material-ingestion.service";
import type { MaterialIngestionQueueService } from "./material-ingestion-queue.service";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };

function fixture(industry: string | null = "医疗健康") {
  const prisma = {
    enterprise: { findFirst: vi.fn().mockResolvedValue({ industry }) },
    material: { findMany: vi.fn().mockResolvedValue([]) },
    sensitiveRule: { findMany: vi.fn().mockResolvedValue([]) },
    geoEntity: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const content = new ContentService(
    prisma as unknown as PrismaService,
    {
      current: vi.fn().mockResolvedValue({ groupSharedMaterialsEnabled: false }),
    } as unknown as TenantCapabilityService,
    {
      requireSaasAdmin: () => ({ userId: "admin", scope: { type: "ENTERPRISE", ...scope } }),
    } as unknown as RequestAccessContext,
    {} as MaterialIngestionQueueService,
  );
  return { prisma, content };
}

describe("enterprise material options", () => {
  it("requires only material.read, so material admins need no campaign permissions", async () => {
    const method = ContentController.prototype.enterpriseMaterialOptions;
    expect(Reflect.getMetadata(ADMIN_ACCESS_REQUIREMENT, method)).toEqual({
      scope: "ENTERPRISE",
      permissions: ["material.read"],
    });
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(
      "console/tenants/:tenantId/enterprises/:enterpriseId/materials/options",
    );
    const f = fixture();
    const controller = new ContentController(f.content, {} as MaterialIngestionService);
    expect(await controller.enterpriseMaterialOptions(scope.tenantId, scope.enterpriseId)).toEqual({
      medical: false,
    });
  });

  it("uses the same generic material editor for every industry, including an empty library", async () => {
    const f = fixture("眼科");
    expect(await f.content.materialOptions(scope)).toEqual({ medical: false });
    expect(f.prisma.material.findMany).not.toHaveBeenCalled();
    expect(f.prisma.enterprise.findFirst).toHaveBeenCalledWith({
      select: { industry: true },
      where: { ...{ id: scope.enterpriseId, tenantId: scope.tenantId }, status: "ACTIVE" },
    });
    expect(await fixture("汽车服务").content.materialOptions(scope)).toEqual({ medical: false });
  });

  it("rejects foreign and missing enterprises before returning their options", async () => {
    const f = fixture();
    await expect(f.content.materialOptions({ ...scope, enterpriseId: "foreign" })).rejects.toThrow(
      "scope",
    );
    expect(f.prisma.enterprise.findFirst).not.toHaveBeenCalled();
    f.prisma.enterprise.findFirst.mockResolvedValue(null as never);
    await expect(f.content.materialOptions(scope)).rejects.toThrow("not found");
  });
});

describe("generic generation context with historical medical material", () => {
  const rows = [
    {
      id: "legacy",
      type: "TEXT",
      enterpriseId: scope.enterpriseId,
      structuredFacts: { doctorTitle: "保留的历史资料" },
    },
    {
      id: "scene",
      type: "IMAGE_REFERENCE",
      enterpriseId: scope.enterpriseId,
      structuredFacts: {
        medicalMaterial: {
          schemaVersion: "medical-material-v1",
          purpose: "REAL_SCENE",
          sceneType: "ENVIRONMENT",
          privacyConfirmed: true,
        },
      },
    },
    {
      id: "archive",
      type: "DOCUMENT",
      enterpriseId: scope.enterpriseId,
      structuredFacts: {
        medicalMaterial: { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" },
      },
    },
    {
      id: "image-evidence",
      type: "IMAGE_REFERENCE",
      enterpriseId: scope.enterpriseId,
      structuredFacts: {
        medicalMaterial: { schemaVersion: "medical-material-v1", purpose: "ANSWER_EVIDENCE" },
      },
    },
    {
      id: "text",
      type: "TEXT",
      enterpriseId: scope.enterpriseId,
      structuredFacts: {
        medicalMaterial: { schemaVersion: "medical-material-v1", purpose: "ANSWER_EVIDENCE" },
      },
    },
    {
      id: "document",
      type: "DOCUMENT",
      enterpriseId: scope.enterpriseId,
      structuredFacts: {
        medicalMaterial: { schemaVersion: "medical-material-v1", purpose: "ANSWER_EVIDENCE" },
      },
    },
  ];

  it("restores historical unclassified materials without reactivating archived records", async () => {
    const f = fixture();
    f.prisma.material.findMany.mockResolvedValue(rows as never);
    const before = structuredClone(rows);
    const context = await f.content.generationContext(
      scope.tenantId,
      scope.enterpriseId,
      new Date(),
      rows.map(({ id }) => id).reverse(),
      [],
    );
    expect(context.materials.map(({ id }) => id)).toEqual([
      "document",
      "text",
      "image-evidence",
      "scene",
      "legacy",
    ]);
    expect(context.geoEntities).toEqual([]);
    expect(rows).toEqual(before);
  });

  it("preserves existing nonmedical generation context behavior", async () => {
    const f = fixture("汽车服务");
    f.prisma.material.findMany.mockResolvedValue(rows as never);
    const context = await f.content.generationContext(
      scope.tenantId,
      scope.enterpriseId,
      new Date(),
    );
    expect(context.materials.map(({ id }) => id)).toEqual(
      rows.filter(({ id }) => id !== "archive").map(({ id }) => id),
    );
  });
});
