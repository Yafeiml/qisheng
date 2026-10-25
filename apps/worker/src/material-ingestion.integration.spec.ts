import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@xhs-agentic/database";
import { MemoryObjectStorage, materialArtifactObjectKey } from "@xhs-agentic/object-storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MaterialIngestionRuntime,
  scheduleMissingMaterialEmbeddings,
} from "./material-ingestion-worker";

const envPath = resolve(__dirname, "../../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

describe("material ingestion runtime", { concurrent: false }, () => {
  const prisma = new PrismaClient();
  const storage = new MemoryObjectStorage();
  const tenantIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialEmbedding.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialChunk.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialIngestionJob.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialArtifact.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.material.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.enterprise.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
  });

  it("verifies, parses, chunks and indexes a stored TXT artifact idempotently", async () => {
    const marker = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({
      data: { customerType: "SINGLE_ENTERPRISE", name: `ingestion-${marker}` },
    });
    tenantIds.push(tenant.id);
    const enterprise = await prisma.enterprise.create({
      data: { code: `ING_${marker}`, name: "解析测试企业", tenantId: tenant.id },
    });
    const materialId = randomUUID();
    const artifactId = randomUUID();
    const jobId = randomUUID();
    const content = "全飞秒 Pro 设备资料。\n\n规范术前评估非常重要，手术效果存在个体差异。".repeat(
      40,
    );
    const bytes = new TextEncoder().encode(content);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const objectKey = materialArtifactObjectKey({
      artifactId,
      fileName: "knowledge.txt",
      materialId,
      tenantId: tenant.id,
    });
    await storage.put({ bytes, checksum, key: objectKey, mimeType: "text/plain" });
    await prisma.material.create({
      data: {
        authorizationStatus: "AUTHORIZED",
        content: "",
        createdBy: "ingestion-test",
        enterpriseId: enterprise.id,
        id: materialId,
        scopeKey: enterprise.id,
        tags: ["全飞秒Pro", "设备"],
        tenantId: tenant.id,
        title: "TXT 设备资料",
        type: "DOCUMENT",
      },
    });
    await prisma.materialArtifact.create({
      data: {
        byteSize: bytes.byteLength,
        checksum,
        enterpriseId: enterprise.id,
        id: artifactId,
        kind: "UPLOAD",
        materialId,
        mimeType: "text/plain",
        objectKey,
        originalFileName: "knowledge.txt",
        scopeKey: enterprise.id,
        status: "STORED",
        storedAt: new Date(),
        tenantId: tenant.id,
      },
    });
    await prisma.materialIngestionJob.create({
      data: {
        artifactId,
        enterpriseId: enterprise.id,
        id: jobId,
        materialId,
        parserVersion: "material-parser-v1",
        scopeKey: enterprise.id,
        tenantId: tenant.id,
      },
    });
    const runtime = new MaterialIngestionRuntime(prisma, storage);
    const data = { ingestionJobId: jobId, materialId, queueVersion: 1, tenantId: tenant.id };
    const result = await runtime.process(data, "test-worker");

    expect(result.chunks).toBeGreaterThan(1);
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: materialId } }),
    ).resolves.toMatchObject({
      ingestionStatus: "READY",
      parserVersion: "material-parser-v1",
    });
    const chunks = await prisma.materialChunk.findMany({ where: { materialId } });
    const embeddings = await prisma.materialEmbedding.findMany({ where: { materialId } });
    expect(chunks).toHaveLength(result.chunks);
    expect(embeddings).toHaveLength(result.chunks);
    expect(embeddings.every(({ dimension, vector }) => dimension === vector.length)).toBe(true);
    await expect(runtime.process(data, "test-worker-second")).resolves.toEqual({ chunks: 0 });
    await expect(prisma.materialChunk.count({ where: { materialId } })).resolves.toBe(
      result.chunks,
    );
  });

  it("ingests TEXT asynchronously and switches immutable versions only after V2 is ready", async () => {
    const marker = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({
      data: { customerType: "SINGLE_ENTERPRISE", name: `text-ingestion-${marker}` },
    });
    tenantIds.push(tenant.id);
    const enterprise = await prisma.enterprise.create({
      data: { code: `TXT_${marker}`, name: "文本解析测试企业", tenantId: tenant.id },
    });
    const runtime = new MaterialIngestionRuntime(prisma, storage);
    const first = await createPendingTextMaterial(prisma, {
      content: "第一版全飞秒资料：强调设备能力和规范术前评估。",
      enterpriseId: enterprise.id,
      tenantId: tenant.id,
      title: "全飞秒资料 V1",
    });

    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: first.materialId } }),
    ).resolves.toMatchObject({ ingestionStatus: "PENDING", status: "ACTIVE" });
    await runtime.process(first.data, "text-worker-v1");
    await expect(
      prisma.materialEmbedding.findFirstOrThrow({ where: { materialId: first.materialId } }),
    ).resolves.toMatchObject({ profileVersion: "deterministic-char-ngram-v1" });

    const second = await createPendingTextMaterial(prisma, {
      content: "第二版全飞秒资料：补充个体差异和设备使用边界。",
      enterpriseId: enterprise.id,
      seriesId: first.seriesId,
      supersedesId: first.materialId,
      tenantId: tenant.id,
      title: "全飞秒资料 V2",
      version: 2,
    });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: first.materialId } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE" });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: second.materialId } }),
    ).resolves.toMatchObject({ ingestionStatus: "PENDING", status: "ACTIVE" });

    await runtime.process(second.data, "text-worker-v2");

    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: first.materialId } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "DISABLED" });
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: second.materialId } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE", version: 2 });

    const third = await createPendingTextMaterial(prisma, {
      content: "第三版全飞秒资料：等待解析。",
      enterpriseId: enterprise.id,
      seriesId: first.seriesId,
      supersedesId: second.materialId,
      tenantId: tenant.id,
      title: "全飞秒资料 V3",
      version: 3,
    });
    const fourth = await createPendingTextMaterial(prisma, {
      content: "第四版全飞秒资料：应成为唯一可检索版本。",
      enterpriseId: enterprise.id,
      seriesId: first.seriesId,
      supersedesId: third.materialId,
      tenantId: tenant.id,
      title: "全飞秒资料 V4",
      version: 4,
    });
    await runtime.process(fourth.data, "text-worker-v4-first");
    await runtime.process(third.data, "text-worker-v3-late");

    const versions = await prisma.material.findMany({
      orderBy: { version: "asc" },
      select: { ingestionStatus: true, status: true, version: true },
      where: { seriesId: first.seriesId },
    });
    expect(versions).toEqual([
      { ingestionStatus: "READY", status: "DISABLED", version: 1 },
      { ingestionStatus: "READY", status: "DISABLED", version: 2 },
      { ingestionStatus: "READY", status: "DISABLED", version: 3 },
      { ingestionStatus: "READY", status: "ACTIVE", version: 4 },
    ]);
  });

  it("automatically reindexes the current profile without rebuilding chunks or reading artifacts", async () => {
    const marker = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({
      data: { customerType: "SINGLE_ENTERPRISE", name: `reindex-${marker}` },
    });
    tenantIds.push(tenant.id);
    const enterprise = await prisma.enterprise.create({
      data: { code: `REI_${marker}`, name: "重建索引测试企业", tenantId: tenant.id },
    });
    const content = "历史文档已经解析完成，现需在平台切换模型后补齐新的向量画像。";
    const checksum = createHash("sha256").update(content).digest("hex");
    const material = await prisma.material.create({
      data: {
        authorizationStatus: "AUTHORIZED",
        content,
        contentChecksum: checksum,
        createdBy: "reindex-test",
        enterpriseId: enterprise.id,
        ingestionStatus: "READY",
        parserVersion: "material-parser-v1",
        readyAt: new Date(),
        scopeKey: enterprise.id,
        tags: ["历史资料"],
        tenantId: tenant.id,
        title: "历史文档",
        type: "DOCUMENT",
      },
    });
    const artifact = await prisma.materialArtifact.create({
      data: {
        byteSize: 999,
        checksum: "f".repeat(64),
        enterpriseId: enterprise.id,
        kind: "UPLOAD",
        materialId: material.id,
        mimeType: "text/plain",
        objectKey: `objects-not-present/${randomUUID()}.txt`,
        originalFileName: "history.txt",
        scopeKey: enterprise.id,
        status: "VERIFIED",
        tenantId: tenant.id,
        verifiedAt: new Date(),
      },
    });
    const chunk = await prisma.materialChunk.create({
      data: {
        characterCount: content.length,
        enterpriseId: enterprise.id,
        materialId: material.id,
        ordinal: 0,
        scopeKey: enterprise.id,
        tenantId: tenant.id,
        text: content,
        textChecksum: checksum,
        tokenCount: Math.ceil(content.length / 2),
      },
    });
    const legacyVector = Array.from({ length: 64 }, (_, index) => (index === 0 ? 1 : 0));
    await prisma.materialEmbedding.create({
      data: {
        chunkId: chunk.id,
        dimension: legacyVector.length,
        enterpriseId: enterprise.id,
        materialId: material.id,
        profileVersion: "legacy-embedding-profile-v1",
        scopeKey: enterprise.id,
        tenantId: tenant.id,
        vector: legacyVector,
      },
    });

    await scheduleMissingMaterialEmbeddings(prisma, tenant.id);
    const job = await prisma.materialIngestionJob.findFirstOrThrow({
      where: { materialId: material.id, purpose: "REINDEX", status: "PENDING" },
    });
    await prisma.materialIngestionJob.update({
      data: { artifactId: artifact.id },
      where: { id: job.id },
    });
    const runtime = new MaterialIngestionRuntime(prisma, storage);
    const beforeChunkIds = (
      await prisma.materialChunk.findMany({ where: { materialId: material.id } })
    ).map(({ id }) => id);

    await runtime.process(
      {
        ingestionJobId: job.id,
        materialId: material.id,
        queueVersion: job.queueVersion,
        tenantId: tenant.id,
      },
      "reindex-worker",
    );

    const afterChunkIds = (
      await prisma.materialChunk.findMany({ where: { materialId: material.id } })
    ).map(({ id }) => id);
    expect(afterChunkIds).toEqual(beforeChunkIds);
    await expect(
      prisma.materialEmbedding.findMany({
        orderBy: { profileVersion: "asc" },
        select: { profileVersion: true },
        where: { materialId: material.id },
      }),
    ).resolves.toEqual([
      { profileVersion: "deterministic-char-ngram-v1" },
      { profileVersion: "legacy-embedding-profile-v1" },
    ]);
    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: material.id } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE" });
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: "material.embedding.reindexed", resourceId: material.id },
      }),
    ).resolves.toMatchObject({ actorType: "SYSTEM", tenantId: tenant.id });
    await scheduleMissingMaterialEmbeddings(prisma, tenant.id);
    await expect(
      prisma.materialIngestionJob.count({ where: { materialId: material.id, purpose: "REINDEX" } }),
    ).resolves.toBe(1);
  });

  it("keeps a READY material usable when reindexing fails", async () => {
    const marker = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({
      data: { customerType: "SINGLE_ENTERPRISE", name: `reindex-failure-${marker}` },
    });
    tenantIds.push(tenant.id);
    const enterprise = await prisma.enterprise.create({
      data: { code: `REF_${marker}`, name: "重建失败测试企业", tenantId: tenant.id },
    });
    const material = await prisma.material.create({
      data: {
        authorizationStatus: "AUTHORIZED",
        content: "该素材保持 READY，但测试数据故意缺少 Chunk。",
        createdBy: "reindex-failure-test",
        enterpriseId: enterprise.id,
        ingestionStatus: "READY",
        parserVersion: "material-parser-v1",
        readyAt: new Date(),
        scopeKey: enterprise.id,
        tenantId: tenant.id,
        title: "缺少 Chunk 的历史素材",
        type: "TEXT",
      },
    });
    const job = await prisma.materialIngestionJob.create({
      data: {
        enterpriseId: enterprise.id,
        materialId: material.id,
        parserVersion: "embedding-reindex:deterministic-char-ngram-v1",
        purpose: "REINDEX",
        scopeKey: enterprise.id,
        tenantId: tenant.id,
      },
    });
    const runtime = new MaterialIngestionRuntime(prisma, storage);

    await expect(
      runtime.process(
        {
          ingestionJobId: job.id,
          materialId: material.id,
          queueVersion: job.queueVersion,
          tenantId: tenant.id,
        },
        "reindex-failure-worker",
      ),
    ).rejects.toMatchObject({ code: "MATERIAL_CHUNKS_MISSING" });

    await expect(
      prisma.material.findUniqueOrThrow({ where: { id: material.id } }),
    ).resolves.toMatchObject({ ingestionStatus: "READY", status: "ACTIVE" });
    await expect(
      prisma.materialIngestionJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ errorCode: "MATERIAL_CHUNKS_MISSING", status: "QUARANTINED" });
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: "material.embedding.reindex.quarantined", resourceId: material.id },
      }),
    ).resolves.toMatchObject({ tenantId: tenant.id });
  });
});

async function createPendingTextMaterial(
  prisma: PrismaClient,
  input: {
    content: string;
    enterpriseId: string;
    seriesId?: string;
    supersedesId?: string;
    tenantId: string;
    title: string;
    version?: number;
  },
) {
  const material = await prisma.material.create({
    data: {
      authorizationStatus: "AUTHORIZED",
      content: input.content,
      createdBy: "text-ingestion-test",
      enterpriseId: input.enterpriseId,
      ingestionStatus: "PENDING",
      scopeKey: input.enterpriseId,
      seriesId: input.seriesId,
      supersedesId: input.supersedesId,
      tags: ["文本资料"],
      tenantId: input.tenantId,
      title: input.title,
      type: "TEXT",
      version: input.version,
    },
  });
  const job = await prisma.materialIngestionJob.create({
    data: {
      enterpriseId: input.enterpriseId,
      materialId: material.id,
      parserVersion: "material-parser-v1",
      scopeKey: input.enterpriseId,
      tenantId: input.tenantId,
    },
  });
  return {
    data: {
      ingestionJobId: job.id,
      materialId: material.id,
      queueVersion: job.queueVersion,
      tenantId: input.tenantId,
    },
    materialId: material.id,
    seriesId: material.seriesId,
  };
}
