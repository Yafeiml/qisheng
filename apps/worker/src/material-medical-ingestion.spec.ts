import { createHash } from "node:crypto";
import type { MedicalMaterial } from "@xhs-agentic/ai-gateway";
import type { PrismaClient } from "@xhs-agentic/database";
import { MemoryObjectStorage } from "@xhs-agentic/object-storage";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  MaterialIngestionRuntime,
  scheduleMissingMaterialEmbeddings,
} from "./material-ingestion-worker";
import {
  MATERIAL_AI_VERSION,
  type MaterialAnalysis,
  type UnderstandingInput,
} from "./material-understanding";

const answer: MedicalMaterial = {
  schemaVersion: "medical-material-v1",
  purpose: "ANSWER_EVIDENCE",
  question: "初诊带什么？",
  sourceNote: "已核对的企业初诊流程",
};
const analysis: MaterialAnalysis = {
  title: "初诊准备",
  summary: "初诊携带已有检查结果。",
  keywords: ["初诊", "检查结果"],
  entities: [],
  suggestedUses: ["回答初诊准备问题"],
  missingInformation: [],
  personFocused: false,
  visualDescription: "大厅和座椅。",
  recognizedText: "",
};

function fixture(medicalMaterial: MedicalMaterial, type = "TEXT") {
  const material = {
    id: "material",
    tenantId: "tenant",
    enterpriseId: "enterprise",
    scopeKey: "enterprise",
    seriesId: "series",
    version: 1,
    status: "ACTIVE",
    supersedesId: null,
    structuredFacts: { retainedHistoricalFact: "保留", medicalMaterial },
    type,
    title: "原始资料",
    content: "初诊请携带已有检查结果。",
    sourceText: "初诊请携带已有检查结果。",
    supplement: "",
    tags: [],
  };
  const job = {
    id: "job",
    purpose: "INGEST",
    parserVersion: MATERIAL_AI_VERSION,
    material,
    artifact: null as Record<string, unknown> | null,
  };
  const database = {
    materialIngestionJob: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(job),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ purpose: "INGEST", enterpriseId: "enterprise" }),
      update: vi.fn().mockResolvedValue({}),
    },
    material: {
      update: vi.fn().mockResolvedValue({}),
      findUniqueOrThrow: vi.fn().mockResolvedValue(material),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    materialArtifact: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    materialChunk: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    materialEmbedding: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    runtimePolicy: {
      findUnique: vi.fn().mockResolvedValue({
        materialChunkSizeCharacters: 800,
        materialChunkOverlapCharacters: 100,
        embeddingModelId: null,
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...database,
    $transaction: vi.fn(async (operation: (transaction: typeof database) => Promise<unknown>) =>
      operation(database),
    ),
  };
  const storage = new MemoryObjectStorage();
  const analyze = vi
    .fn<(input: UnderstandingInput) => Promise<MaterialAnalysis>>()
    .mockResolvedValue(analysis);
  const runtime = new MaterialIngestionRuntime(prisma as unknown as PrismaClient, storage, {
    analyze,
  });
  const data = {
    ingestionJobId: "job",
    materialId: "material",
    queueVersion: 1,
    tenantId: "tenant",
  };
  return { prisma, storage, analyze, runtime, data, job, material };
}

describe("medical material ingestion", () => {
  it("indexes materials locally in production when no external embedding model is configured", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { runtime, data, prisma } = fixture(answer);
      await expect(runtime.process(data, "worker")).resolves.toEqual({ chunks: 1 });
      expect(prisma.materialEmbedding.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
        modelDefinitionId: null,
        profileVersion: "deterministic-char-ngram-v1",
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("passes the selected question and source to analysis and preserves classification in chunks", async () => {
    const { runtime, data, analyze, prisma, material } = fixture(answer);
    await expect(runtime.process(data, "worker")).resolves.toEqual({ chunks: 1 });
    expect(analyze.mock.calls[0]?.[0]).toMatchObject({ medicalMaterial: answer });
    expect(prisma.materialChunk.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
      structuredFacts: material.structuredFacts,
    });
  });

  it("analyzes optional real photos without a description and preserves per-image purpose metadata", async () => {
    const scene: MedicalMaterial = {
      schemaVersion: "medical-material-v1",
      purpose: "REAL_SCENE",
      sceneType: "ENVIRONMENT",
      privacyConfirmed: true,
    };
    const photo = { ...scene, sceneType: "ROUTE" as const };
    const { runtime, data, analyze, prisma, storage } = fixture(scene, "IMAGE_REFERENCE");
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await storage.put({ key: "photo", bytes, checksum, mimeType: "image/png" });
    prisma.materialArtifact.findMany.mockResolvedValueOnce([
      {
        id: "artifact",
        objectKey: "photo",
        byteSize: bytes.length,
        checksum,
        mimeType: "image/png",
        originalFileName: "IMG.png",
        createdAt: new Date(),
        metadata: { usage: "REFERENCE", description: "", medicalMaterial: photo, preserved: true },
      },
    ]);
    await runtime.process(data, "worker");
    expect(analyze.mock.calls[0]?.[0]).toMatchObject({
      medicalMaterial: photo,
      attachmentDescription: "",
    });
    expect(prisma.materialArtifact.update.mock.calls[0]?.[0].data.metadata).toMatchObject({
      medicalMaterial: photo,
      description: "",
      preserved: true,
      usabilityStatus: "USABLE",
    });
  });

  it("verifies and parses an archived file while skipping paid analysis and indexing", async () => {
    const archive: MedicalMaterial = { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" };
    const { runtime, data, analyze, prisma, storage, job, material } = fixture(archive, "DOCUMENT");
    const bytes = Buffer.from("历史医生头衔、履历与设备参数原文。", "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await storage.put({ key: "archive", bytes, checksum, mimeType: "text/plain" });
    job.artifact = {
      id: "artifact",
      objectKey: "archive",
      byteSize: bytes.length,
      checksum,
      mimeType: "text/plain",
      originalFileName: "history.txt",
      storedAt: new Date(),
      metadata: { medicalMaterial: archive, preserved: "历史备注" },
    };
    prisma.runtimePolicy.findUnique.mockResolvedValueOnce({
      materialChunkSizeCharacters: 800,
      materialChunkOverlapCharacters: 100,
      embeddingModelId: "paid-model-unavailable",
    });
    await expect(runtime.process(data, "worker")).resolves.toEqual({ chunks: 0 });
    expect(analyze).not.toHaveBeenCalled();
    expect(prisma.materialChunk.createMany.mock.calls[0]?.[0]).toEqual({ data: [] });
    expect(prisma.materialEmbedding.createMany.mock.calls[0]?.[0]).toEqual({ data: [] });
    expect(prisma.material.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      content: bytes.toString("utf8"),
      ingestionStatus: "READY",
      usabilityStatus: "USABLE",
    });
    expect(material.structuredFacts.retainedHistoricalFact).toBe("保留");
    expect(prisma.materialArtifact.update.mock.calls[0]?.[0].data).toMatchObject({
      status: "VERIFIED",
      checksum,
      metadata: { medicalMaterial: archive, preserved: "历史备注" },
    });
  });

  it("does not schedule archived historical chunks for embedding reindex", async () => {
    const archive = { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" };
    const transaction = vi.fn();
    const prisma = {
      runtimePolicy: { findUnique: vi.fn().mockResolvedValue({ embeddingModelId: null }) },
      materialChunk: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { materialId: "archive", material: { structuredFacts: { medicalMaterial: archive } } },
          ]),
      },
      $transaction: transaction,
    };
    await scheduleMissingMaterialEmbeddings(prisma as unknown as PrismaClient);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("completes an already queued archive reindex without model calls or deleting historical chunks", async () => {
    const archive: MedicalMaterial = { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" };
    const { runtime, data, analyze, prisma, job } = fixture(archive);
    job.purpose = "REINDEX";
    Object.assign(prisma.materialChunk, {
      findMany: vi.fn().mockResolvedValue([{ id: "historical", text: "保留历史检索记录" }]),
    });
    prisma.runtimePolicy.findUnique.mockResolvedValueOnce({
      materialChunkSizeCharacters: 800,
      materialChunkOverlapCharacters: 100,
      embeddingModelId: "paid-model-unavailable",
    });
    await expect(runtime.process(data, "worker")).resolves.toEqual({ chunks: 0 });
    expect(analyze).not.toHaveBeenCalled();
    expect(prisma.materialChunk.deleteMany).not.toHaveBeenCalled();
    expect(prisma.materialEmbedding.createMany.mock.calls[0]?.[0]).toEqual({
      data: [],
      skipDuplicates: true,
    });
  });

  it("retains archived image bundles without requesting model analysis", async () => {
    const archive: MedicalMaterial = { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" };
    const { runtime, data, analyze, prisma, storage } = fixture(archive, "IMAGE_REFERENCE");
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await storage.put({ key: "history-photo", bytes, checksum, mimeType: "image/png" });
    prisma.materialArtifact.findMany.mockResolvedValueOnce([
      {
        id: "artifact",
        objectKey: "history-photo",
        byteSize: bytes.length,
        checksum,
        mimeType: "image/png",
        originalFileName: "history.png",
        createdAt: new Date(),
        metadata: { medicalMaterial: archive, preserved: true },
      },
    ]);
    await expect(runtime.process(data, "worker")).resolves.toEqual({ chunks: 0 });
    expect(analyze).not.toHaveBeenCalled();
    expect(prisma.materialArtifact.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: "VERIFIED",
    });
    expect(prisma.materialArtifact.update).not.toHaveBeenCalled();
  });

  it("still quarantines an archived file whose stored checksum does not match", async () => {
    const archive: MedicalMaterial = { schemaVersion: "medical-material-v1", purpose: "ARCHIVE" };
    const { runtime, data, analyze, prisma, storage, job } = fixture(archive, "DOCUMENT");
    const bytes = Buffer.from("历史原文", "utf8");
    await storage.put({
      key: "archive",
      bytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "text/plain",
    });
    job.artifact = {
      id: "artifact",
      objectKey: "archive",
      byteSize: bytes.length,
      checksum: "0".repeat(64),
      mimeType: "text/plain",
    };
    await expect(runtime.process(data, "worker")).rejects.toMatchObject({
      code: "ARTIFACT_CHECKSUM_MISMATCH",
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(prisma.materialArtifact.update).not.toHaveBeenCalled();
    expect(prisma.material.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      ingestionStatus: "QUARANTINED",
    });
  });
});
