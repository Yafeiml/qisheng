import "reflect-metadata";

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { deterministicEmbedding } from "@xhs-agentic/ai-gateway";
import type { Enterprise, Tenant } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../database/prisma.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { MaterialRetrievalService } from "./material-retrieval.service";

const envPath = resolve(__dirname, "../../../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

describe("SaaS core Sprint 7 retrieval isolation", { concurrent: false }, () => {
  const prisma = new PrismaService();
  let tenant: Tenant;
  let foreignTenant: Tenant;
  let enterprise: Enterprise;
  let foreignEnterprise: Enterprise;
  let retrieval: MaterialRetrievalService;

  beforeAll(async () => {
    await prisma.$connect();
    const marker = randomUUID().slice(0, 8);
    const now = new Date();
    tenant = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `Sprint7-${marker}` },
    });
    foreignTenant = await prisma.tenant.create({
      data: { customerType: "GROUP", name: `Sprint7-foreign-${marker}` },
    });
    enterprise = await prisma.enterprise.create({
      data: {
        brandName: "明澈眼科",
        city: "上海",
        code: `S7_${marker}`,
        industry: "医疗健康",
        name: "Sprint 7 企业",
        tenantId: tenant.id,
      },
    });
    foreignEnterprise = await prisma.enterprise.create({
      data: {
        code: `S7F_${marker}`,
        name: "Sprint 7 外部企业",
        tenantId: foreignTenant.id,
      },
    });
    await Promise.all([
      prisma.tenantCapabilityPolicy.create({ data: { tenantId: tenant.id } }),
      prisma.tenantCapabilityPolicy.create({ data: { tenantId: foreignTenant.id } }),
      createReadyMaterial(prisma, {
        content: "全飞秒 Pro 使用专业设备，并强调规范术前评估、个体差异和真实服务流程。",
        enterpriseId: enterprise.id,
        tags: ["全飞秒Pro", "设备", "术前评估"],
        tenantId: tenant.id,
        title: "企业全飞秒设备资料",
      }),
      createReadyMaterial(prisma, {
        content: "集团公共品牌资料：医疗传播需要专业、克制，并明确效果存在个体差异。",
        enterpriseId: null,
        tags: ["品牌", "合规"],
        tenantId: tenant.id,
        title: "集团公共品牌口径",
      }),
      createReadyMaterial(prisma, {
        content: "全飞秒 Pro 外部租户绝密设备资料，不得被其他租户检索。",
        enterpriseId: foreignEnterprise.id,
        tags: ["全飞秒Pro", "设备"],
        tenantId: foreignTenant.id,
        title: "外部租户资料",
      }),
      createReadyMaterial(prisma, {
        authorizationStatus: "REJECTED",
        content: "全飞秒 Pro 未授权资料。",
        enterpriseId: enterprise.id,
        tags: ["全飞秒Pro"],
        tenantId: tenant.id,
        title: "未授权资料",
      }),
      createReadyMaterial(prisma, {
        content: "全飞秒 Pro 已过期设备资料。",
        enterpriseId: enterprise.id,
        expiresAt: new Date(now.getTime() - 1_000),
        tags: ["全飞秒Pro"],
        tenantId: tenant.id,
        title: "过期资料",
      }),
    ]);
    retrieval = new MaterialRetrievalService(prisma, new TenantCapabilityService(prisma));
  });

  afterAll(async () => {
    const tenantIds = [tenant?.id, foreignTenant?.id].filter((id): id is string => Boolean(id));
    await prisma.materialEmbedding.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialChunk.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialIngestionJob.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.materialArtifact.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.material.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenantCapabilityPolicy.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.enterprise.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
  });

  it("filters before scoring and returns stable private plus shared evidence", async () => {
    const first = await retrieval.retrieve(
      { enterpriseId: enterprise.id, tenantId: tenant.id },
      "生成全飞秒 Pro 宣传文，侧重专业设备、术前评估和个体差异",
    );
    const second = await retrieval.retrieve(
      { enterpriseId: enterprise.id, tenantId: tenant.id },
      "生成全飞秒 Pro 宣传文，侧重专业设备、术前评估和个体差异",
    );

    expect(first.hits.map(({ chunkId }) => chunkId)).toEqual(
      second.hits.map(({ chunkId }) => chunkId),
    );
    expect(first.hits[0]).toMatchObject({
      enterpriseId: enterprise.id,
      materialTitle: "企业全飞秒设备资料",
      rank: 1,
    });
    expect(first.hits.some(({ enterpriseId }) => enterpriseId === null)).toBe(true);
    expect(first.hits.some(({ materialTitle }) => materialTitle === "外部租户资料")).toBe(false);
    expect(first.hits.some(({ materialTitle }) => materialTitle === "未授权资料")).toBe(false);
    expect(first.hits.some(({ materialTitle }) => materialTitle === "过期资料")).toBe(false);
    expect(
      first.hits.every(({ hitReasons, snippet }) => hitReasons.length > 0 && snippet.length > 0),
    ).toBe(true);
  });

  it("scores the full eligible vector set instead of truncating older relevant embeddings", async () => {
    const prompt = "请围绕专业设备和规范评估形成传播建议";
    const query = [
      prompt,
      enterprise.name,
      enterprise.brandName,
      enterprise.industry,
      enterprise.city,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" ");
    const queryVector = deterministicEmbedding(query);
    const target = await createReadyMaterial(prisma, {
      content: "冷杉档案 ZXQ-731，仅用于证明旧向量候选不会被写入时间截断。",
      enterpriseId: enterprise.id,
      indexedAt: new Date(Date.now() - 3_600_000),
      tags: ["冷杉档案"],
      tenantId: tenant.id,
      title: "较早写入但高度相关的向量资料",
      vector: queryVector,
    });
    const oppositeVector = queryVector.map((value) => -value);
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        createReadyMaterial(prisma, {
          content: `库存流水记录 ${index + 1}：雨伞、纸张与普通办公用品。`,
          enterpriseId: enterprise.id,
          indexedAt: new Date(Date.now() + index),
          tags: ["库存流水"],
          tenantId: tenant.id,
          title: `更新写入的无关向量 ${index + 1}`,
          vector: oppositeVector,
        }),
      ),
    );

    const result = await retrieval.retrieve(
      { enterpriseId: enterprise.id, tenantId: tenant.id },
      prompt,
      new Date(),
      10,
    );

    expect(result.hits.some(({ materialId }) => materialId === target.id)).toBe(true);
    expect(result.hits.find(({ materialId }) => materialId === target.id)?.vectorScore).toBe(1);
  });
});

async function createReadyMaterial(
  prisma: PrismaService,
  input: {
    authorizationStatus?: "AUTHORIZED" | "REJECTED";
    content: string;
    enterpriseId: string | null;
    expiresAt?: Date;
    indexedAt?: Date;
    tags: string[];
    tenantId: string;
    title: string;
    vector?: number[];
  },
) {
  const checksum = createHash("sha256").update(input.content).digest("hex");
  const material = await prisma.material.create({
    data: {
      authorizationStatus: input.authorizationStatus ?? "AUTHORIZED",
      content: input.content,
      contentChecksum: checksum,
      createdBy: "sprint7-test",
      enterpriseId: input.enterpriseId,
      expiresAt: input.expiresAt,
      ingestionStatus: "READY",
      parserVersion: "sprint7-test-v1",
      readyAt: new Date(),
      scopeKey: input.enterpriseId ?? "__tenant__",
      tags: input.tags,
      tenantId: input.tenantId,
      title: input.title,
      type: "TEXT",
    },
  });
  const chunk = await prisma.materialChunk.create({
    data: {
      characterCount: input.content.length,
      enterpriseId: input.enterpriseId,
      materialId: material.id,
      ordinal: 0,
      scopeKey: material.scopeKey,
      tenantId: input.tenantId,
      text: input.content,
      textChecksum: checksum,
      tokenCount: Math.ceil(input.content.length / 2),
    },
  });
  const vector = input.vector ?? deterministicEmbedding(input.content);
  await prisma.materialEmbedding.create({
    data: {
      chunkId: chunk.id,
      dimension: vector.length,
      enterpriseId: input.enterpriseId,
      materialId: material.id,
      profileVersion: "deterministic-char-ngram-v1",
      scopeKey: material.scopeKey,
      tenantId: input.tenantId,
      vector,
      indexedAt: input.indexedAt,
    },
  });
  return material;
}
