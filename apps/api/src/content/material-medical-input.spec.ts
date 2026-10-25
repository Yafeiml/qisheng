import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import type { StorageQuotaService } from "../resource-policy/storage-quota.service";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { CreateMaterialDto, CreateMaterialUploadIntentDto } from "./content.dto";
import { ContentService } from "./content.service";
import { MaterialIngestionService } from "./material-ingestion.service";
import type { MaterialIngestionQueueService } from "./material-ingestion-queue.service";
import { medicalMaterialFacts } from "./material-medical-input";
import type { MaterialStorageService } from "./material-storage.service";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
const evidence = {
  schemaVersion: "medical-material-v1" as const,
  purpose: "ANSWER_EVIDENCE" as const,
  question: "到店检查需要预留多久？",
  sourceNote: "企业已确认的服务流程记录",
};
const scene = {
  schemaVersion: "medical-material-v1" as const,
  purpose: "REAL_SCENE" as const,
  sceneType: "ENVIRONMENT" as const,
  privacyConfirmed: true,
};

function fixture(source?: Record<string, unknown>) {
  const material = {
    create: vi.fn(async ({ data }) => ({
      id: "new-material",
      seriesId: "series",
      status: "ACTIVE",
      version: 1,
      ...data,
    })),
    findFirst: vi.fn(async ({ where }) => (where.version ? null : (source ?? null))),
  };
  const artifact = {
    create: vi.fn(async ({ data }) => ({ id: "artifact", ...data })),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue(
      source
        ? [
            {
              id: "old-artifact",
              materialId: source.id,
              material: { version: 1 },
              objectKey: "private/old-photo",
              checksum: "a".repeat(64),
              kind: "IMAGE_SOURCE",
              status: "STORED",
              mimeType: "image/png",
              originalFileName: "environment.png",
              metadata: { description: "原实拍图", usage: "REFERENCE", medicalMaterial: scene },
            },
          ]
        : [],
    ),
  };
  const prisma = {
    material,
    materialArtifact: artifact,
    materialIngestionJob: {
      create: vi.fn().mockResolvedValue({ id: "job", queueVersion: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    enterprise: { findFirst: vi.fn().mockResolvedValue({ id: scope.enterpriseId }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: async (operation: (transaction: unknown) => unknown) => operation(prisma),
  };
  const context = {
    requireSaasAdmin: () => ({ userId: "admin", scope: { type: "ENTERPRISE", ...scope } }),
  } as unknown as RequestAccessContext;
  const capabilities = {} as TenantCapabilityService;
  const queue = {
    enqueue: vi.fn().mockResolvedValue(undefined),
  } as unknown as MaterialIngestionQueueService;
  const storageQuota = {
    releaseExpired: vi.fn().mockResolvedValue(undefined),
    reserveInTransaction: vi.fn().mockResolvedValue({ id: "reservation" }),
  } as unknown as StorageQuotaService;
  const storage = {
    objectKey: () => "private/photo",
    signedUpload: vi.fn().mockResolvedValue("https://storage.example/upload"),
  } as unknown as MaterialStorageService;
  return {
    material,
    artifact,
    content: new ContentService(prisma as unknown as PrismaService, capabilities, context, queue),
    ingestion: new MaterialIngestionService(
      prisma as unknown as PrismaService,
      context,
      capabilities,
      storageQuota,
      queue,
      storage,
    ),
  };
}

describe("medical material intake", () => {
  it("accepts concise evidence and photo input without doctor titles, biographies or device fields", async () => {
    expect(
      await validate(
        plainToInstance(CreateMaterialDto, {
          type: "TEXT",
          content: "通常预留半天，具体以预约安排为准。",
          medicalMaterial: evidence,
          authorizationConfirmed: true,
        }),
      ),
    ).toEqual([]);
    expect(
      await validate(
        plainToInstance(CreateMaterialUploadIntentDto, {
          type: "IMAGE_REFERENCE",
          fileName: "environment.png",
          mimeType: "image/png",
          byteSize: 100,
          checksum: "a".repeat(64),
          medicalMaterial: scene,
          authorizationConfirmed: true,
        }),
      ),
    ).toEqual([]);
    const f = fixture();
    await f.content.createMaterial(scope, {
      type: "TEXT",
      content: "通常预留半天。",
      medicalMaterial: evidence,
      structuredFacts: { serviceHours: "按预约安排" },
      authorizationConfirmed: true,
    });
    expect(f.material.create.mock.calls[0]?.[0].data.structuredFacts).toEqual({
      serviceHours: "按预约安排",
      medicalMaterial: evidence,
    });
  });

  it("stores the same classification on uploaded material and artifact", async () => {
    const f = fixture();
    await f.ingestion.createUploadIntent(scope, {
      type: "IMAGE_REFERENCE",
      fileName: "environment.png",
      mimeType: "image/png",
      byteSize: 100,
      checksum: "a".repeat(64),
      medicalMaterial: scene,
      authorizationConfirmed: true,
    });
    expect(f.material.create.mock.calls[0]?.[0].data.structuredFacts).toEqual({
      medicalMaterial: scene,
    });
    expect(f.artifact.create.mock.calls[0]?.[0].data.metadata).toMatchObject({
      medicalMaterial: scene,
    });
  });

  it("always stores real scenes as reference images even when an upload requests LOGO usage", async () => {
    const f = fixture();
    await f.ingestion.createUploadIntent(scope, {
      type: "IMAGE_REFERENCE",
      fileName: "environment.png",
      mimeType: "image/png",
      byteSize: 100,
      checksum: "a".repeat(64),
      usage: "LOGO",
      medicalMaterial: scene,
      authorizationConfirmed: true,
    });
    expect(f.artifact.create.mock.calls[0]?.[0].data.metadata).toMatchObject({
      medicalMaterial: scene,
      usage: "REFERENCE",
    });
  });

  it.each([
    undefined,
    { schemaVersion: "medical-material-v1" as const, purpose: "ARCHIVE" as const },
  ])("preserves LOGO usage for unclassified and archived uploads (%s)", async (medicalMaterial) => {
    const f = fixture();
    await f.ingestion.createUploadIntent(scope, {
      type: "IMAGE_REFERENCE",
      fileName: "logo.png",
      mimeType: "image/png",
      byteSize: 100,
      checksum: "a".repeat(64),
      usage: "LOGO",
      medicalMaterial,
      authorizationConfirmed: true,
    });
    expect(f.artifact.create.mock.calls[0]?.[0].data.metadata).toMatchObject({ usage: "LOGO" });
  });

  it.each([false, true])(
    "normalizes old LOGO clones as real scenes while leaving historical files intact (restore=%s)",
    async (restore) => {
      const source = {
        id: "source",
        seriesId: "series",
        version: 1,
        status: "ACTIVE",
        type: "IMAGE_REFERENCE",
        scopeKey: "enterprise",
        content: "",
        tags: [],
        authorizationStatus: "AUTHORIZED",
        structuredFacts: { medicalMaterial: scene },
      };
      const original = {
        id: "old-artifact",
        materialId: restore ? "historical-source" : source.id,
        material: { version: restore ? 0 : 1 },
        objectKey: "private/old-photo",
        checksum: "a".repeat(64),
        kind: "IMAGE_SOURCE",
        status: "STORED",
        mimeType: "image/png",
        originalFileName: "environment.png",
        metadata: { description: "历史实拍图", usage: "LOGO" },
      };
      const f = fixture(source);
      f.artifact.findMany.mockResolvedValue([original] as never);
      await f.ingestion.createRevision(scope, source.id, {
        files: [],
        medicalMaterial: scene,
        authorizationConfirmed: true,
        ...(restore
          ? { restoreArtifactIds: [original.id] }
          : {
              attachmentDescriptions: [
                { artifactId: original.id, description: "当前实拍说明", usage: "LOGO" as const },
              ],
            }),
      });
      expect(f.artifact.create.mock.calls[0]?.[0].data.metadata).toMatchObject({
        medicalMaterial: scene,
        usage: "REFERENCE",
      });
      expect(original.metadata.usage).toBe("LOGO");
    },
  );

  it.each([
    { medicalMaterial: scene, expectedUsage: "REFERENCE" },
    {
      medicalMaterial: {
        schemaVersion: "medical-material-v1" as const,
        purpose: "ARCHIVE" as const,
      },
      expectedUsage: "LOGO",
    },
    { medicalMaterial: undefined, expectedUsage: "LOGO" },
  ])(
    "only normalizes real-scene clones when supplementing a published version ($expectedUsage)",
    async ({ medicalMaterial, expectedUsage }) => {
      const original = {
        id: "old-artifact",
        materialId: "source",
        objectKey: "private/old-photo",
        checksum: "a".repeat(64),
        kind: "IMAGE_SOURCE",
        status: "STORED",
        mimeType: "image/png",
        originalFileName: "environment.png",
        metadata: { description: "历史原图", usage: "LOGO" },
      };
      const f = fixture({
        id: "source",
        seriesId: "series",
        version: 1,
        status: "ACTIVE",
        type: "IMAGE_REFERENCE",
        scopeKey: "enterprise",
        content: "",
        tags: [],
        authorizationStatus: "AUTHORIZED",
        ingestionStatus: "READY",
        usabilityStatus: "USABLE",
        artifacts: [original],
        ingestionJobs: [],
        structuredFacts: medicalMaterial ? { medicalMaterial } : undefined,
      });
      await f.ingestion.supplement(scope, "source", { supplement: "补充已核实的环境归属信息" });
      expect(f.artifact.create.mock.calls[0]?.[0].data.metadata).toMatchObject({
        usage: expectedUsage,
      });
      expect(original.metadata.usage).toBe("LOGO");
    },
  );

  it("keeps link evidence classification with its source snapshot", async () => {
    const f = fixture();
    await f.ingestion.createLink(scope, {
      title: "预约流程来源",
      sourceUrl: "https://example.com/process",
      medicalMaterial: evidence,
      authorizationConfirmed: true,
    });
    expect(f.material.create.mock.calls[0]?.[0].data.structuredFacts).toEqual({
      medicalMaterial: evidence,
    });
    expect(f.artifact.create.mock.calls[0]?.[0].data.metadata).toMatchObject({
      medicalMaterial: evidence,
    });
  });

  it("rejects invalid or conflicting explicit metadata, including structuredFacts-only attempts", () => {
    for (const medicalMaterial of [
      null,
      {},
      { ...scene, privacyConfirmed: false },
      { ...scene, sceneType: undefined },
    ]) {
      expect(() =>
        medicalMaterialFacts(
          { structuredFacts: { medicalMaterial }, authorizationConfirmed: true },
          "IMAGE_REFERENCE",
        ),
      ).toThrow("无效");
    }
    expect(() =>
      medicalMaterialFacts(
        {
          medicalMaterial: scene,
          structuredFacts: { medicalMaterial: { ...scene, sceneType: "ROUTE" } },
          authorizationConfirmed: true,
        },
        "IMAGE_REFERENCE",
      ),
    ).toThrow("不一致");
    expect(() =>
      medicalMaterialFacts(
        { medicalMaterial: scene, authorizationConfirmed: false },
        "IMAGE_REFERENCE",
      ),
    ).toThrow("授权");
    expect(() =>
      medicalMaterialFacts({ medicalMaterial: scene, authorizationConfirmed: true }, "TEXT"),
    ).toThrow("上传图片");
    expect(() =>
      medicalMaterialFacts(
        { medicalMaterial: evidence, authorizationConfirmed: true },
        "IMAGE_REFERENCE",
      ),
    ).toThrow("可选配图");
  });

  it("retains legacy data without silently classifying it, and preserves classification across text versions", async () => {
    expect(
      medicalMaterialFacts({ authorizationConfirmed: true }, "TEXT", { doctorTitle: "历史头衔" }),
    ).toEqual({ doctorTitle: "历史头衔" });
    const f = fixture({
      id: "source",
      seriesId: "series",
      version: 1,
      status: "ACTIVE",
      structuredFacts: { doctorTitle: "历史资料", medicalMaterial: evidence },
    });
    await f.content.publishMaterialVersion(scope, "source", {
      type: "TEXT",
      content: "更新后的预约安排。",
      changeNote: "更新流程记录",
      authorizationConfirmed: true,
    });
    expect(f.material.create.mock.calls[0]?.[0].data.structuredFacts).toEqual({
      doctorTitle: "历史资料",
      medicalMaterial: evidence,
    });
  });

  it("reclassifies retained attachments in a new version without deleting historical metadata", async () => {
    const previousFacts = { retainedField: "历史说明", medicalMaterial: scene };
    const f = fixture({
      id: "source",
      seriesId: "series",
      version: 1,
      status: "ACTIVE",
      type: "IMAGE_REFERENCE",
      scopeKey: "enterprise",
      content: "",
      tags: [],
      structuredFacts: previousFacts,
      authorizationStatus: "AUTHORIZED",
    });
    const archive = { schemaVersion: "medical-material-v1" as const, purpose: "ARCHIVE" as const };
    await f.ingestion.createRevision(scope, "source", {
      files: [],
      medicalMaterial: archive,
      authorizationConfirmed: true,
    });
    expect(f.material.create.mock.calls[0]?.[0].data.structuredFacts).toEqual({
      retainedField: "历史说明",
      medicalMaterial: archive,
    });
    expect(f.artifact.create.mock.calls[0]?.[0].data.metadata).toMatchObject({
      medicalMaterial: archive,
    });
    expect(previousFacts.medicalMaterial).toEqual(scene);
  });

  it("does not silently accept changed or invalid medical classification when resuming an upload", async () => {
    const f = fixture({
      id: "source",
      status: "ACTIVE",
      type: "IMAGE_REFERENCE",
      structuredFacts: { medicalMaterial: scene },
    });
    f.artifact.findMany.mockResolvedValue([]);
    await expect(
      f.ingestion.resumeRevision(scope, "source", {
        files: [],
        medicalMaterial: { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" },
        authorizationConfirmed: true,
      }),
    ).rejects.toThrow("不能修改素材用途");
    await expect(
      f.ingestion.resumeRevision(scope, "source", {
        files: [],
        medicalMaterial: { ...scene, privacyConfirmed: false },
        authorizationConfirmed: true,
      }),
    ).rejects.toThrow("无效");
    expect(
      await f.ingestion.resumeRevision(scope, "source", {
        files: [],
        medicalMaterial: scene,
        authorizationConfirmed: true,
      }),
    ).toEqual({ materialId: "source", intents: [] });
  });
});
