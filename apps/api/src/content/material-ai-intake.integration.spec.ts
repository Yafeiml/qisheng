import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { ProviderInvocationError } from "@xhs-agentic/ai-gateway";
import type { Enterprise, MaterialArtifact, Tenant } from "@xhs-agentic/database";
import { MemoryObjectStorage, materialArtifactObjectKey } from "@xhs-agentic/object-storage";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MaterialIngestionRuntime } from "../../../worker/src/material-ingestion-worker";
import {
  MATERIAL_AI_VERSION,
  type MaterialAnalysis,
  type MaterialUnderstanding,
} from "../../../worker/src/material-understanding";
import type { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type { StorageQuotaService } from "../resource-policy/storage-quota.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { CreateMaterialDto, CreateMaterialUploadIntentDto } from "./content.dto";
import { ContentService } from "./content.service";
import { MaterialIngestionService } from "./material-ingestion.service";
import type { MaterialIngestionQueueService } from "./material-ingestion-queue.service";
import { MaterialRetrievalService } from "./material-retrieval.service";
import { MaterialStorageService } from "./material-storage.service";

const analysis: MaterialAnalysis = {
  title: "林院长介绍",
  summary: "林院长的专家介绍资料。",
  keywords: ["林院长", "专家介绍"],
  entities: [],
  suggestedUses: ["专家介绍"],
  missingInformation: [],
  personFocused: false,
  visualDescription: "",
  recognizedText: "",
};

describe("AI material intake to generation", { concurrent: false }, () => {
  const prisma = new PrismaService();
  const storage = new MemoryObjectStorage();
  const capabilities = new TenantCapabilityService(prisma);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const queue = { enqueue } as unknown as MaterialIngestionQueueService;
  let tenant: Tenant;
  let enterprise: Enterprise;
  let foreignEnterprise: Enterprise;
  let content: ContentService;
  let ingestion: MaterialIngestionService;
  let retrieval: MaterialRetrievalService;
  let context: RequestAccessContext;
  const scope = () => ({ tenantId: tenant.id, enterpriseId: enterprise.id });

  beforeAll(async () => {
    tenant = await prisma.tenant.create({
      data: { name: `ai-intake-${randomUUID()}`, customerType: "SINGLE_ENTERPRISE" },
    });
    enterprise = await prisma.enterprise.create({
      data: { code: "MAIN", name: "资料测试企业", tenantId: tenant.id },
    });
    foreignEnterprise = await prisma.enterprise.create({
      data: { code: "OTHER", name: "其他企业", tenantId: tenant.id },
    });
    context = {
      requireSaasAdmin: () => ({
        userId: "intake-test",
        scope: { type: "ENTERPRISE", ...scope() },
      }),
    } as unknown as RequestAccessContext;
    content = new ContentService(prisma, capabilities, context, queue);
    ingestion = new MaterialIngestionService(
      prisma,
      context,
      capabilities,
      {} as StorageQuotaService,
      queue,
      {} as MaterialStorageService,
    );
    retrieval = new MaterialRetrievalService(prisma, capabilities);
  });
  afterAll(async () => {
    if (tenant) {
      const where = { tenantId: tenant.id };
      await prisma.auditLog.deleteMany({ where });
      await prisma.materialEmbedding.deleteMany({ where });
      await prisma.materialChunk.deleteMany({ where });
      await prisma.materialIngestionJob.deleteMany({ where });
      await prisma.materialArtifact.deleteMany({ where });
      await prisma.material.deleteMany({ where });
      await prisma.tenantCapabilityPolicy.deleteMany({ where });
      await prisma.enterprise.deleteMany({ where });
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
    await prisma.$disconnect();
  });

  async function processMaterial(materialId: string, understanding: MaterialUnderstanding) {
    const job = await prisma.materialIngestionJob.findFirstOrThrow({
      where: { materialId },
      orderBy: { queueVersion: "desc" },
    });
    const runtime = new MaterialIngestionRuntime(prisma, storage, understanding);
    return runtime.process(
      { ingestionJobId: job.id, materialId, tenantId: tenant.id, queueVersion: job.queueVersion },
      "ai-intake-test",
    );
  }

  it("accepts text and file metadata without a title or tags", async () => {
    expect(
      await validate(
        plainToInstance(CreateMaterialDto, {
          type: "TEXT",
          content: "林院长专家介绍。",
          authorizationConfirmed: true,
        }),
      ),
    ).toEqual([]);
    expect(
      await validate(
        plainToInstance(CreateMaterialUploadIntentDto, {
          type: "IMAGE_REFERENCE",
          fileName: "x.png",
          mimeType: "image/png",
          byteSize: 123,
          checksum: "a".repeat(64),
          authorizationConfirmed: true,
        }),
      ),
    ).toEqual([]);
  });

  it("keeps independent image evidence usable when another attachment needs clarification", async () => {
    const material = await prisma.material.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        createdBy: "intake-test",
        title: "场景图片",
        type: "IMAGE_REFERENCE",
        content: "",
        supplement: "本企业的大厅和门头实景",
        authorizationStatus: "AUTHORIZED",
        usabilityStatus: "PENDING",
      },
    });
    const artifacts: MaterialArtifact[] = [];
    for (const [index, name] of ["大厅.png", "门头.png"].entries()) {
      const bytes = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 20 + index * 50, g: 50, b: 100, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
      const id = randomUUID();
      const key = materialArtifactObjectKey({
        tenantId: tenant.id,
        materialId: material.id,
        artifactId: id,
        fileName: name,
      });
      const checksum = createHash("sha256").update(bytes).digest("hex");
      await storage.put({ key, bytes, checksum, mimeType: "image/png" });
      artifacts.push(
        await prisma.materialArtifact.create({
          data: {
            ...scope(),
            scopeKey: enterprise.id,
            id,
            materialId: material.id,
            kind: "IMAGE_SOURCE",
            status: "STORED",
            objectKey: key,
            checksum,
            byteSize: bytes.length,
            mimeType: "image/png",
            originalFileName: name,
            metadata: { description: `这是${name}`, bundleOrdinal: index },
          },
        }),
      );
    }
    await prisma.materialIngestionJob.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        materialId: material.id,
        artifactId: artifacts[0]?.id,
        parserVersion: "material-ai-bundle-v1",
      },
    });
    const calls: string[] = [];
    await processMaterial(material.id, {
      analyze: async (input) => {
        calls.push(input.fileName ?? "");
        expect(input.bundleFileNames).toEqual(["大厅.png", "门头.png"]);
        expect(input.attachmentDescription).toBe(`这是${input.fileName}`);
        return {
          ...analysis,
          title: input.fileName ?? "场景",
          keywords: [input.fileName === "大厅.png" ? "大厅" : "门头"],
          visualDescription: input.fileName ?? "",
          missingInformation: input.fileName === "门头.png" ? ["请确认门店归属"] : [],
        };
      },
    });
    expect(calls).toHaveLength(2);
    const saved = await prisma.material.findUniqueOrThrow({
      where: { id: material.id },
      include: { artifacts: true, chunks: true },
    });
    expect(saved.usabilityStatus).toBe("USABLE");
    expect(saved.chunks.length).toBeGreaterThan(0);
    expect(
      saved.chunks.every(
        (chunk) => (chunk.metadata as { artifactId: string }).artifactId === artifacts[0]?.id,
      ),
    ).toBe(true);
    expect(
      saved.artifacts.find((artifact) => artifact.id === artifacts[1]?.id)?.metadata,
    ).toMatchObject({ usabilityStatus: "NEEDS_INPUT" });
    const selected = await retrieval.selectImageAssets(scope(), "介绍企业大厅环境");
    expect(selected.some((asset) => asset.artifactId === artifacts[0]?.id)).toBe(true);
    await expect(
      retrieval.selectImageAssets(scope(), "门头", [artifacts[1]?.id ?? ""]),
    ).rejects.toThrow("不可用");
    await expect(
      retrieval.selectImageAssets(
        { tenantId: tenant.id, enterpriseId: foreignEnterprise.id },
        "大厅",
        [artifacts[0]?.id ?? ""],
      ),
    ).rejects.toThrow("不可用");
    const revisions = new MaterialIngestionService(
      prisma,
      context,
      capabilities,
      { releaseExpired: async () => 0 } as unknown as StorageQuotaService,
      queue,
      {} as MaterialStorageService,
    );
    await expect(
      revisions.createRevision(scope(), material.id, {
        authorizationConfirmed: true,
        files: [],
        removeArtifactIds: ["foreign-artifact"],
      }),
    ).rejects.toThrow("当前版本");
    const kept = artifacts[0];
    const removed = artifacts[1];
    if (!kept || !removed) throw new Error("Missing image fixture");
    const revised = await revisions.createRevision(scope(), material.id, {
      authorizationConfirmed: true,
      files: [],
      removeArtifactIds: [removed.id],
      attachmentDescriptions: [
        { artifactId: kept.id, description: "上海门店大厅", usage: "REFERENCE" },
      ],
    });
    const retained = await prisma.materialArtifact.findMany({
      where: { materialId: revised.materialId },
    });
    expect(retained).toHaveLength(1);
    expect(retained[0]?.objectKey).toBe(kept.objectKey);
    expect(retained[0]?.metadata).toMatchObject({ description: "上海门店大厅" });
    await revisions.finalizeRevision(scope(), revised.materialId);
    await processMaterial(revised.materialId, {
      analyze: async () => ({
        ...analysis,
        title: "上海门店大厅",
        keywords: ["大厅"],
        visualDescription: "门店大厅实景",
      }),
    });
    expect((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).status).toBe(
      "DISABLED",
    );
    expect(await prisma.materialArtifact.count({ where: { materialId: material.id } })).toBe(2);
    expect((await retrieval.selectImageAssets(scope(), "企业大厅"))[0]?.materialId).toBe(
      revised.materialId,
    );
  });

  it("recalls separate person, procedure and image materials and blocks unclear portraits until supplemented", async () => {
    const person = await content.createMaterial(scope(), {
      type: "TEXT",
      content: "林院长的专家介绍：擅长术前评估。",
      authorizationConfirmed: true,
    });
    const project = await content.createMaterial(scope(), {
      type: "TEXT",
      content: "全飞秒手术需要规范术前评估，效果存在个体差异。",
      authorizationConfirmed: true,
    });
    await processMaterial(person.id, { analyze: async () => analysis });
    await processMaterial(project.id, {
      analyze: async () => ({
        ...analysis,
        title: "全飞秒项目资料",
        keywords: ["全飞秒", "术前评估"],
      }),
    });
    const image = await prisma.material.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        createdBy: "intake-test",
        type: "IMAGE_REFERENCE",
        title: "IMG_1.png",
        content: "",
        sourceText: "",
        authorizationStatus: "AUTHORIZED",
        usabilityStatus: "PENDING",
      },
    });
    const artifactId = randomUUID();
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=",
      "base64",
    );
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const objectKey = materialArtifactObjectKey({
      tenantId: tenant.id,
      materialId: image.id,
      artifactId,
      fileName: "IMG_1.png",
    });
    await storage.put({ bytes, key: objectKey, mimeType: "image/png", checksum });
    await prisma.materialArtifact.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        id: artifactId,
        materialId: image.id,
        kind: "IMAGE_SOURCE",
        status: "STORED",
        mimeType: "image/png",
        byteSize: bytes.byteLength,
        objectKey,
        checksum,
        originalFileName: "IMG_1.png",
      },
    });
    await prisma.materialIngestionJob.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        materialId: image.id,
        artifactId,
        parserVersion: MATERIAL_AI_VERSION,
      },
    });
    const seenInputs = vi.fn(async () => ({
      ...analysis,
      personFocused: true,
      visualDescription: "人物照片",
      missingInformation: ["请补充人物身份"],
    }));
    await processMaterial(image.id, { analyze: seenInputs });
    expect(seenInputs.mock.calls).toHaveLength(1);
    expect(await prisma.material.findUniqueOrThrow({ where: { id: image.id } })).toMatchObject({
      ingestionStatus: "READY",
      usabilityStatus: "NEEDS_INPUT",
    });
    expect(await prisma.materialChunk.count({ where: { materialId: image.id } })).toBe(0);
    const prompt = "本期内容推荐林院长的全飞秒手术";
    for (let index = 0; index < 12; index++) {
      const unrelated = await content.createMaterial(scope(), {
        type: "TEXT",
        authorizationConfirmed: true,
        content: `办公用品管理资料 ${index}：纸张、笔和桌椅的保管方法。`,
      });
      await processMaterial(unrelated.id, {
        analyze: async () => ({
          ...analysis,
          title: `办公用品 ${index}`,
          summary: "办公用品保管说明",
          keywords: ["办公用品", "纸张", "桌椅"],
        }),
      });
    }
    const before = await retrieval.retrieve(scope(), prompt);
    expect(before.hits.map((hit) => hit.materialId)).toEqual(
      expect.arrayContaining([person.id, project.id]),
    );
    expect(before.hits.some((hit) => hit.materialId === image.id)).toBe(false);
    const manualBefore = await content.generationContext(tenant.id, enterprise.id, new Date(), [
      image.id,
    ]);
    expect(manualBefore.materials).toEqual([]);

    await expect(
      ingestion.supplement({ ...scope(), enterpriseId: foreignEnterprise.id }, image.id, {
        supplement: "林院长照片",
      }),
    ).rejects.toThrow();
    await ingestion.supplement(scope(), image.id, {
      supplement: "照片中是本院林院长，用于专家介绍。",
    });
    const clarified = vi.fn(async () => ({
      ...analysis,
      personFocused: true,
      title: "林院长介绍照片",
      entities: [
        {
          name: "林院长",
          aliases: [],
          kind: "PERSON" as const,
          source: "SUPPLEMENT" as const,
          evidence: "照片中是本院林院长",
        },
      ],
      visualDescription: "林院长的人物照片",
    }));
    await processMaterial(image.id, { analyze: clarified });
    expect(clarified.mock.calls).toHaveLength(1);
    expect(await prisma.materialArtifact.count({ where: { materialId: image.id } })).toBe(1);
    const after = await retrieval.retrieve(scope(), prompt);
    expect(after.hits.map((hit) => hit.materialId)).toEqual(
      expect.arrayContaining([person.id, project.id, image.id]),
    );
    expect(after.hits.find((hit) => hit.materialId === image.id)).toMatchObject({
      materialType: "IMAGE_REFERENCE",
      tagScore: expect.any(Number),
    });
    expect(after.hits.find((hit) => hit.materialId === image.id)?.snippet).toContain("林院长");

    const revised = await ingestion.supplement(scope(), image.id, {
      supplement: "更正：照片中是李主任，用于专家介绍。",
    });
    expect(revised.materialId).not.toBe(image.id);
    expect(await prisma.material.findUniqueOrThrow({ where: { id: image.id } })).toMatchObject({
      status: "ACTIVE",
      usabilityStatus: "USABLE",
    });
    const originalChunk = await prisma.materialChunk.findFirstOrThrow({
      where: { materialId: image.id },
    });
    await processMaterial(revised.materialId, {
      analyze: async () => ({
        ...analysis,
        title: "李主任介绍照片",
        keywords: ["李主任", "专家介绍"],
        visualDescription: "人物照片",
      }),
    });
    expect(await prisma.material.findUniqueOrThrow({ where: { id: image.id } })).toMatchObject({
      status: "DISABLED",
    });
    expect(
      await prisma.material.findUniqueOrThrow({ where: { id: revised.materialId } }),
    ).toMatchObject({
      tags: ["李主任", "专家介绍"],
      supplement: "更正：照片中是李主任，用于专家介绍。",
    });
    expect(
      await prisma.materialChunk.findUniqueOrThrow({ where: { id: originalChunk.id } }),
    ).toMatchObject({ text: originalChunk.text });
  });

  it("keeps provider failures separate from missing information", async () => {
    const material = await content.createMaterial(scope(), {
      type: "TEXT",
      content: "林院长专家资料。",
      authorizationConfirmed: true,
    });
    await expect(
      processMaterial(material.id, {
        analyze: async () => {
          throw new Error("MATERIAL_ANALYSIS_MODEL_UNAVAILABLE");
        },
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_ANALYSIS_MODEL_UNAVAILABLE" });
    expect(await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).toMatchObject({
      ingestionStatus: "FAILED",
      usabilityStatus: "PENDING",
    });
  });

  it("records a safe authentication failure and reuses the original text after configuration recovery", async () => {
    const sourceText = "林院长的全飞秒资料，术前评估需由专业医生完成。";
    const material = await content.createMaterial(scope(), {
      type: "TEXT",
      content: sourceText,
      authorizationConfirmed: true,
    });
    await expect(
      processMaterial(material.id, {
        analyze: async () => {
          throw new ProviderInvocationError(
            "sk-private-key uploaded private content",
            "invalid_api_key",
            false,
            { httpStatus: 401 },
          );
        },
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_ANALYSIS_AUTH_FAILED", retryable: false });
    const failed = await prisma.material.findUniqueOrThrow({
      where: { id: material.id },
      include: { ingestionJobs: true },
    });
    expect(failed).toMatchObject({
      ingestionStatus: "QUARANTINED",
      usabilityStatus: "PENDING",
      ingestionErrorCode: "MATERIAL_ANALYSIS_AUTH_FAILED",
      sourceText,
    });
    expect(failed.ingestionErrorMessage).toContain("认证失败");
    expect(failed.ingestionErrorMessage).not.toMatch(/sk-private|uploaded/u);
    expect(failed.ingestionJobs[0]).toMatchObject({
      status: "QUARANTINED",
      errorCode: failed.ingestionErrorCode,
      errorMessage: failed.ingestionErrorMessage,
    });
    expect(await prisma.materialChunk.count({ where: { materialId: material.id } })).toBe(0);

    const restarted = await ingestion.retry(scope(), material.id, {
      reason: "管理员已更新模型配置",
    });
    expect(restarted).toMatchObject({ status: "PENDING", queueVersion: 2 });
    await expect(ingestion.retry(scope(), material.id, { reason: "重复点击" })).rejects.toThrow();
    await processMaterial(material.id, { analyze: async () => analysis });
    expect(await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).toMatchObject({
      ingestionStatus: "READY",
      usabilityStatus: "USABLE",
      ingestionErrorCode: null,
      ingestionErrorMessage: null,
      sourceText,
    });
  });

  it.each([
    [403, "GW_MODEL_NOT_ALLOWED", "MATERIAL_ANALYSIS_MODEL_NOT_ALLOWED", "QUARANTINED"],
    [403, "GW_QUOTA_EXCEEDED", "MATERIAL_ANALYSIS_QUOTA_EXCEEDED", "QUARANTINED"],
    [429, "insufficient_quota", "MATERIAL_ANALYSIS_QUOTA_EXCEEDED", "QUARANTINED"],
    [429, "rate_limit_exceeded", "MATERIAL_ANALYSIS_RATE_LIMITED", "FAILED"],
    [504, "PROVIDER_TIMEOUT", "MATERIAL_ANALYSIS_TIMEOUT", "FAILED"],
  ] as const)(
    "records HTTP %s / %s with its correct automatic retry state",
    async (status, code, expectedCode, expectedStatus) => {
      const material = await content.createMaterial(scope(), {
        type: "TEXT",
        content: "原始资料不能因为服务错误丢失。",
        authorizationConfirmed: true,
      });
      await expect(
        processMaterial(material.id, {
          analyze: async () => {
            throw new ProviderInvocationError("untrusted sk-secret source content", code, true, {
              httpStatus: status,
            });
          },
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      const failed = await prisma.material.findUniqueOrThrow({
        where: { id: material.id },
        include: { ingestionJobs: true },
      });
      expect(failed).toMatchObject({
        ingestionStatus: expectedStatus,
        ingestionErrorCode: expectedCode,
        usabilityStatus: "PENDING",
      });
      expect(failed.ingestionErrorMessage).not.toMatch(/sk-secret|source content/u);
      expect(failed.ingestionJobs[0]).toMatchObject({
        status: expectedStatus,
        errorCode: expectedCode,
      });
    },
  );

  it.each([
    ["MATERIAL_ANALYSIS_INVALID_RESPONSE", "QUARANTINED"],
    ["EMBEDDING_CREDENTIAL_UNAVAILABLE", "QUARANTINED"],
    ["RUNTIME_POLICY_MISSING", "QUARANTINED"],
    ["STORAGE_ACCESS_DENIED", "QUARANTINED"],
  ] as const)(
    "permits a manual retry of %s after the service is restored",
    async (code, status) => {
      const material = await content.createMaterial(scope(), {
        type: "TEXT",
        content: "恢复配置后可继续处理的原始资料。",
        authorizationConfirmed: true,
      });
      await prisma.material.update({
        data: { ingestionErrorCode: code, ingestionStatus: status },
        where: { id: material.id },
      });
      await prisma.materialIngestionJob.updateMany({
        data: { errorCode: code, status },
        where: { materialId: material.id },
      });
      expect(
        await ingestion.retry(scope(), material.id, { reason: "服务配置已恢复" }),
      ).toMatchObject({
        status: "PENDING",
        queueVersion: 2,
      });
    },
  );

  it.each([
    [
      "DOCUMENT",
      "application/pdf",
      Buffer.from("%PDF-this-is-not-a-valid-PDF"),
      "DOCUMENT_PARSE_FAILED",
    ],
    ["DOCUMENT", "text/plain", Buffer.from([0xff, 0xfe, 0xff]), "TEXT_ENCODING_UNSUPPORTED"],
    [
      "IMAGE_REFERENCE",
      "image/png",
      Buffer.from("this-is-not-a-valid-image"),
      "IMAGE_PARSE_FAILED",
    ],
  ] as const)(
    "retains the original %s file and guides content replacement on %s parse failure",
    async (type, mimeType, bytes, code) => {
      const material = await prisma.material.create({
        data: {
          ...scope(),
          scopeKey: enterprise.id,
          createdBy: "intake-test",
          title: "待解析的原文件",
          type,
          content: "",
          authorizationStatus: "AUTHORIZED",
          usabilityStatus: "PENDING",
        },
      });
      const artifactId = randomUUID();
      const objectKey = materialArtifactObjectKey({
        tenantId: tenant.id,
        materialId: material.id,
        artifactId,
        fileName: "original-file",
      });
      const checksum = createHash("sha256").update(bytes).digest("hex");
      await storage.put({ bytes, checksum, key: objectKey, mimeType });
      await prisma.materialArtifact.create({
        data: {
          ...scope(),
          scopeKey: enterprise.id,
          id: artifactId,
          materialId: material.id,
          kind: "UPLOAD",
          status: "STORED",
          objectKey,
          checksum,
          byteSize: bytes.byteLength,
          mimeType,
        },
      });
      await prisma.materialIngestionJob.create({
        data: {
          ...scope(),
          scopeKey: enterprise.id,
          materialId: material.id,
          artifactId,
          parserVersion: MATERIAL_AI_VERSION,
        },
      });
      const analyze = vi.fn().mockResolvedValue(analysis);
      await expect(processMaterial(material.id, { analyze })).rejects.toMatchObject({
        code,
        retryable: false,
      });
      expect(analyze).not.toHaveBeenCalled();
      const failed = await prisma.material.findUniqueOrThrow({ where: { id: material.id } });
      expect(failed).toMatchObject({ ingestionStatus: "QUARANTINED", ingestionErrorCode: code });
      expect(failed.ingestionErrorMessage).toMatch(/[\u4e00-\u9fff]/u);
      await expect(storage.get(objectKey)).resolves.toEqual(new Uint8Array(bytes));
      await expect(
        ingestion.retry(scope(), material.id, { reason: "不应重复解析坏文件" }),
      ).rejects.toThrow("文件校验失败请更新内容");
    },
  );

  it("edits the active material past an archived replacement without reusing version numbers", async () => {
    const original = await content.createMaterial(scope(), {
      type: "TEXT",
      content: "郑州门店的完整介绍资料。",
      authorizationConfirmed: true,
    });
    await processMaterial(original.id, {
      analyze: async () => ({ ...analysis, title: "门店资料", keywords: ["郑州门店"] }),
    });
    const archived = await prisma.material.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        createdBy: "intake-test",
        type: "TEXT",
        title: "已停用的更新",
        content: "旧的更新",
        seriesId: original.seriesId,
        version: 2,
        supersedesId: original.id,
        status: "DISABLED",
        ingestionStatus: "READY",
        usabilityStatus: "NEEDS_INPUT",
      },
    });
    const revised = await ingestion.supplement(scope(), original.id, {
      supplement: "补充门店的地址与用途",
    });
    expect(
      await prisma.material.findUniqueOrThrow({ where: { id: revised.materialId } }),
    ).toMatchObject({ version: 3, supersedesId: original.id });
    expect(await prisma.material.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({
      status: "DISABLED",
      version: 2,
    });
    await expect(
      ingestion.supplement(scope(), original.id, { supplement: "不能越过正在处理的新版本" }),
    ).rejects.toThrow("最新启用版本");
    await content.disableMaterial(scope(), revised.materialId, { reason: "放弃本次更新" });
    const next = await content.publishMaterialVersion(scope(), original.id, {
      type: "TEXT",
      content: "更新后的郑州门店介绍资料。",
      authorizationConfirmed: true,
      changeNote: "更正内容",
    });
    expect(next).toMatchObject({ version: 4, supersedesId: original.id });
  });

  it("lets a pending clarification recheck its original data without fabricated supplements", async () => {
    const original = await content.createMaterial(scope(), {
      type: "TEXT",
      content: "示例医院属于示例眼科集团。",
      authorizationConfirmed: true,
    });
    await processMaterial(original.id, {
      analyze: async () => ({ ...analysis, missingInformation: ["旧规则误判，需要确认集团信息"] }),
    });
    await ingestion.retry(scope(), original.id, { reason: "按当前规则重新检查原资料" });
    expect(await prisma.material.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      ingestionStatus: "PENDING",
      supplement: null,
    });
    await expect(ingestion.retry(scope(), original.id, { reason: "重复点击" })).rejects.toThrow();
    await processMaterial(original.id, {
      analyze: async () => ({ ...analysis, title: "示例医院资料" }),
    });
    expect(await prisma.material.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      ingestionStatus: "READY",
      usabilityStatus: "USABLE",
      supplement: null,
    });
  });

  it("retains earlier files and analyzes two new attachments in one replacement version", async () => {
    const storageService = new MaterialStorageService(
      {
        current: async () => ({
          signedUrlTtlSeconds: 900,
          storage: {
            ensureBucket: async () => undefined,
            head: storage.head.bind(storage),
            signedPutUrl: storage.signedPutUrl.bind(storage),
          },
        }),
      } as never,
      {} as never,
    );
    const quota = {
      releaseExpired: vi.fn().mockResolvedValue(0),
      reserveInTransaction: vi.fn(async () => ({ id: randomUUID() })),
      reserve: vi.fn(async () => ({ id: randomUUID() })),
      commitInTransaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as StorageQuotaService;
    const revisions = new MaterialIngestionService(
      prisma,
      context,
      capabilities,
      quota,
      queue,
      storageService,
    );
    const inputBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=",
      "base64",
    );
    const source = await prisma.material.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        createdBy: "intake-test",
        type: "IMAGE_REFERENCE",
        title: "原来的资料",
        content: "",
        sourceText: "",
        supplement: "原来的说明",
        authorizationStatus: "AUTHORIZED",
        usabilityStatus: "PENDING",
      },
    });
    const originalId = randomUUID();
    const originalKey = materialArtifactObjectKey({
      tenantId: tenant.id,
      materialId: source.id,
      artifactId: originalId,
      fileName: "原图.png",
    });
    const originalChecksum = createHash("sha256").update(inputBytes).digest("hex");
    await storage.put({
      bytes: inputBytes,
      key: originalKey,
      mimeType: "image/png",
      checksum: originalChecksum,
    });
    await prisma.materialArtifact.create({
      data: {
        ...scope(),
        id: originalId,
        scopeKey: enterprise.id,
        materialId: source.id,
        kind: "IMAGE_SOURCE",
        status: "STORED",
        mimeType: "image/png",
        byteSize: inputBytes.byteLength,
        objectKey: originalKey,
        checksum: originalChecksum,
        originalFileName: "原图.png",
      },
    });
    await prisma.materialIngestionJob.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        materialId: source.id,
        artifactId: originalId,
        parserVersion: MATERIAL_AI_VERSION,
      },
    });
    await processMaterial(source.id, {
      analyze: async () => ({ ...analysis, keywords: ["原图"], visualDescription: "原始照片" }),
    });
    const imageBytes = (red: number) =>
      sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: red, g: 90, b: 120, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
    const legacyBytes = await imageBytes(80);
    const legacyChecksum = createHash("sha256").update(legacyBytes).digest("hex");
    const legacy = await revisions.createUploadIntent(scope(), {
      authorizationConfirmed: true,
      byteSize: legacyBytes.byteLength,
      changeNote: "更换照片",
      checksum: legacyChecksum,
      fileName: "更换后的照片.png",
      mimeType: "image/png",
      supersedesId: source.id,
      type: "IMAGE_REFERENCE",
    });
    await storage.put({
      key: decodeURIComponent(new URL(legacy.uploadUrl).pathname.slice(1)),
      bytes: legacyBytes,
      checksum: legacyChecksum,
      mimeType: "image/png",
    });
    await revisions.completeUpload(scope(), legacy.materialId, legacy.artifactId, {
      uploadCompleted: true,
    });
    await processMaterial(legacy.materialId, {
      analyze: async () => ({
        ...analysis,
        keywords: ["更换后的照片"],
        visualDescription: "更新后的照片画面",
      }),
    });
    expect((await prisma.material.findUniqueOrThrow({ where: { id: source.id } })).status).toBe(
      "DISABLED",
    );
    const currentOnly = await revisions.createRevision(scope(), legacy.materialId, {
      authorizationConfirmed: true,
      files: [],
      supplement: "只更新当前照片的说明",
    });
    expect(
      await prisma.materialArtifact.count({ where: { materialId: currentOnly.materialId } }),
    ).toBe(1);
    await revisions.finalizeRevision(scope(), currentOnly.materialId);
    await processMaterial(currentOnly.materialId, {
      analyze: async () => ({ ...analysis, visualDescription: "更换后的照片画面" }),
    });
    await expect(
      revisions.createRevision(scope(), currentOnly.materialId, {
        authorizationConfirmed: true,
        files: [],
        restoreArtifactIds: ["foreign-artifact"],
        supplement: "无效历史附件",
      }),
    ).rejects.toThrow("历史附件");
    const additional = [await imageBytes(130), await imageBytes(180)];
    const files = additional.map((bytes, index) => ({
      byteSize: bytes.byteLength,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      fileName: `新照片${index + 1}.png`,
      mimeType: "image/png",
    }));
    const revision = await revisions.createRevision(scope(), currentOnly.materialId, {
      authorizationConfirmed: true,
      files,
      restoreArtifactIds: [originalId],
      supplement: "已更新所有照片的说明",
    });
    expect(revision.intents).toHaveLength(2);
    const resumed = await revisions.resumeRevision(scope(), revision.materialId, {
      authorizationConfirmed: true,
      files,
    });
    expect(resumed.intents.map((intent) => intent.artifactId)).toEqual(
      revision.intents.map((intent) => intent.artifactId),
    );
    expect(
      await prisma.materialArtifact.count({ where: { materialId: revision.materialId } }),
    ).toBe(4);
    await expect(revisions.finalizeRevision(scope(), revision.materialId)).rejects.toThrow(
      "请先完成所有新附件",
    );
    expect(
      (await prisma.material.findUniqueOrThrow({ where: { id: currentOnly.materialId } })).status,
    ).toBe("ACTIVE");
    for (let index = 0; index < revision.intents.length; index++) {
      const intent = revision.intents[index];
      const file = files[index];
      const bytes = additional[index];
      if (!intent || !file || !bytes) throw new Error("Revision fixture is incomplete");
      await storage.put({
        key: decodeURIComponent(new URL(intent.uploadUrl).pathname.slice(1)),
        bytes,
        checksum: file.checksum,
        mimeType: file.mimeType,
      });
      expect(
        (
          await revisions.completeUpload(scope(), revision.materialId, intent.artifactId, {
            uploadCompleted: true,
          })
        ).job,
      ).toBeNull();
    }
    const queued = await revisions.finalizeRevision(scope(), revision.materialId);
    expect(queued.job.status).toBe("PENDING");
    const seenNames: string[] = [];
    await processMaterial(revision.materialId, {
      analyze: async ({ fileName }) => {
        seenNames.push(fileName ?? "");
        return {
          ...analysis,
          title: "合并后的资料",
          summary: `来源：${fileName}`,
          keywords: [fileName ?? ""],
          visualDescription: `照片：${fileName}`,
        };
      },
    });
    expect(seenNames).toEqual(["更换后的照片.png", "原图.png", "新照片1.png", "新照片2.png"]);
    expect(
      await prisma.material.findUniqueOrThrow({ where: { id: currentOnly.materialId } }),
    ).toMatchObject({
      status: "DISABLED",
    });
    expect(
      await prisma.material.findUniqueOrThrow({ where: { id: revision.materialId } }),
    ).toMatchObject({
      status: "ACTIVE",
      supplement: "已更新所有照片的说明",
      tags: ["更换后的照片.png", "原图.png", "新照片1.png", "新照片2.png"],
    });
    const next = await revisions.supplement(scope(), revision.materialId, {
      supplement: "更正三张照片的统一说明",
    });
    expect(await prisma.materialArtifact.count({ where: { materialId: next.materialId } })).toBe(4);

    const document = await prisma.material.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        createdBy: "intake-test",
        type: "DOCUMENT",
        title: "机构介绍",
        content: "",
        authorizationStatus: "AUTHORIZED",
        usabilityStatus: "PENDING",
      },
    });
    const documentId = randomUUID();
    const oldText = Buffer.from("原有机构资质说明", "utf8");
    const documentKey = materialArtifactObjectKey({
      tenantId: tenant.id,
      materialId: document.id,
      artifactId: documentId,
      fileName: "机构.txt",
    });
    const documentChecksum = createHash("sha256").update(oldText).digest("hex");
    await storage.put({
      bytes: oldText,
      key: documentKey,
      mimeType: "text/plain",
      checksum: documentChecksum,
    });
    await prisma.materialArtifact.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        id: documentId,
        materialId: document.id,
        kind: "UPLOAD",
        status: "STORED",
        mimeType: "text/plain",
        byteSize: oldText.byteLength,
        objectKey: documentKey,
        checksum: documentChecksum,
        originalFileName: "机构.txt",
      },
    });
    await prisma.materialIngestionJob.create({
      data: {
        ...scope(),
        scopeKey: enterprise.id,
        materialId: document.id,
        artifactId: documentId,
        parserVersion: MATERIAL_AI_VERSION,
      },
    });
    await processMaterial(document.id, { analyze: async () => analysis });
    const newText = Buffer.from("新增服务项目说明", "utf8");
    const documentRevision = await revisions.createRevision(scope(), document.id, {
      authorizationConfirmed: true,
      files: [
        {
          byteSize: newText.byteLength,
          checksum: createHash("sha256").update(newText).digest("hex"),
          fileName: "项目.md",
          mimeType: "text/markdown",
        },
      ],
      supplement: "同时使用机构和项目资料",
    });
    const documentIntent = documentRevision.intents[0];
    if (!documentIntent) throw new Error("Document revision upload intent is missing");
    await storage.put({
      key: decodeURIComponent(new URL(documentIntent.uploadUrl).pathname.slice(1)),
      bytes: newText,
      checksum: createHash("sha256").update(newText).digest("hex"),
      mimeType: "text/markdown",
    });
    await revisions.completeUpload(
      scope(),
      documentRevision.materialId,
      documentIntent.artifactId,
      { uploadCompleted: true },
    );
    await revisions.finalizeRevision(scope(), documentRevision.materialId);
    const documentAnalyze = vi.fn(async (_input: { text: string }) => analysis);
    await processMaterial(documentRevision.materialId, { analyze: documentAnalyze });
    expect(documentAnalyze).toHaveBeenCalledTimes(1);
    expect(documentAnalyze.mock.calls[0]?.[0].text).toContain("原有机构资质说明");
    expect(documentAnalyze.mock.calls[0]?.[0].text).toContain("新增服务项目说明");
    expect((await prisma.material.findUniqueOrThrow({ where: { id: document.id } })).status).toBe(
      "DISABLED",
    );
  });
});
