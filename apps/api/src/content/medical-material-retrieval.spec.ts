import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../database/prisma.service";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { MaterialRetrievalService } from "./material-retrieval.service";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
const evidence = { schemaVersion: "medical-material-v1", purpose: "ANSWER_EVIDENCE" };
const scene = {
  schemaVersion: "medical-material-v1",
  purpose: "REAL_SCENE",
  sceneType: "ENVIRONMENT",
  privacyConfirmed: true,
};

function fixture() {
  const prisma = {
    enterprise: { findFirst: vi.fn().mockResolvedValue({ name: "眼科企业", industry: "眼科" }) },
    runtimePolicy: {
      findUnique: vi.fn().mockResolvedValue({
        retrievalTopK: 5,
        retrievalMaxContextCharacters: 8000,
        retrievalStrategyVersion: "fixture",
      }),
    },
    geoEntity: { findMany: vi.fn().mockResolvedValue([]) },
    material: { findMany: vi.fn().mockResolvedValue([]) },
    materialChunk: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const capabilities = {
    current: vi.fn().mockResolvedValue({ groupSharedMaterialsEnabled: true }),
  };
  const service = new MaterialRetrievalService(
    prisma as unknown as PrismaService,
    capabilities as unknown as TenantCapabilityService,
  );
  return { prisma, service };
}

describe("medical fact and photo retrieval", () => {
  it("supports basic local material retrieval in production without an external embedding provider", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { prisma, service } = fixture();
      const result = await service.retrieve(scope, "到访前准备什么");
      expect(result.embeddingUsage).toMatchObject({
        providerId: "local",
        modelId: "deterministic-char-ngram-v1",
        estimatedCost: 0,
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("retrieves answer evidence while excluding photos, archive and unclassified history", async () => {
    const { prisma, service } = fixture();
    const sources = [
      { id: "answer", type: "TEXT", structuredFacts: { medicalMaterial: evidence } },
      { id: "photo", type: "IMAGE_REFERENCE", structuredFacts: { medicalMaterial: evidence } },
      {
        id: "archive",
        type: "TEXT",
        structuredFacts: { medicalMaterial: { ...evidence, purpose: "ARCHIVE" } },
      },
      { id: "history", type: "TEXT", structuredFacts: {} },
    ];
    prisma.$queryRaw.mockResolvedValue(
      sources.map((m) => ({ chunkId: m.id, lexicalScore: 1, vectorScore: 0.9 })),
    );
    prisma.materialChunk.findMany.mockResolvedValue(
      sources.map((m) => ({
        id: m.id,
        materialId: m.id,
        text: "到访前核对时间与需要携带的资料",
        textChecksum: m.id,
        ordinal: 1,
        enterpriseId: scope.enterpriseId,
        scopeKey: scope.enterpriseId,
        material: { ...m, title: m.id, version: 1, seriesId: m.id, analysis: {}, tags: [] },
      })),
    );
    const result = await service.retrieve(
      scope,
      "到访前准备什么",
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.hits.map((h) => h.materialId)).toEqual(["answer"]);
    expect(result.focusOptions).toEqual([]);
    expect(result.focusEntityIds).toEqual([]);
  });

  it("allows explicitly selected verified scene photos without demanding a named doctor", async () => {
    const { prisma, service } = fixture();
    prisma.material.findMany.mockResolvedValue([
      {
        id: "scene",
        title: "大厅",
        enterpriseId: scope.enterpriseId,
        structuredFacts: { medicalMaterial: scene },
        artifacts: [
          {
            id: "scene-image",
            objectKey: "private/scene",
            checksum: "hash",
            mimeType: "image/png",
            metadata: { usage: "REFERENCE", usabilityStatus: "USABLE", medicalMaterial: scene },
          },
        ],
      },
    ]);
    const images = await service.selectImageAssets(
      scope,
      "到访前准备什么",
      ["scene-image"],
      null,
      true,
    );
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      artifactId: "scene-image",
      privacyConfirmed: true,
      authorizationConfirmed: true,
    });
    expect(await service.selectImageAssets(scope, "问题卡", [], null, true)).toEqual([]);
  });

  it("filters both candidate searches before their limit and uses only the selected question", async () => {
    const { prisma, service } = fixture();
    const result = await service.retrieve(
      scope,
      "术后注意什么",
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.query).toBe("术后注意什么");
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of prisma.$queryRaw.mock.calls) {
      const sql = query.text as string;
      const beforeLimit = sql.slice(0, sql.indexOf("LIMIT"));
      expect(beforeLimit).toContain("material.type IN ('TEXT', 'DOCUMENT', 'LINK')");
      expect(beforeLimit).toContain("'purpose' = 'ANSWER_EVIDENCE'");
      expect(beforeLimit).toContain("'schemaVersion' = 'medical-material-v1'");
      expect(sql).not.toContain("unnest(material.tags)");
    }
  });

  it("does not treat unrelated private evidence as an answer to the selected question", async () => {
    const { prisma, service } = fixture();
    prisma.$queryRaw.mockResolvedValue([
      { chunkId: "route", lexicalScore: 0.01, vectorScore: 0.5 },
    ]);
    prisma.materialChunk.findMany.mockResolvedValue([
      {
        id: "route",
        materialId: "route",
        text: "地铁到院路线",
        textChecksum: "route",
        ordinal: 1,
        enterpriseId: scope.enterpriseId,
        scopeKey: scope.enterpriseId,
        material: {
          type: "TEXT",
          structuredFacts: { medicalMaterial: evidence },
          title: "来院路线",
          version: 1,
          seriesId: "route",
          analysis: {},
          tags: ["眼科企业"],
        },
      },
    ]);
    expect(
      (await service.retrieve(scope, "术后注意什么", undefined, undefined, undefined, true)).hits,
    ).toEqual([]);
  });

  it("restores generic retrieval, brand query and focus choices for a medical enterprise", async () => {
    const { prisma, service } = fixture();
    prisma.geoEntity.findMany.mockResolvedValue([
      {
        id: "brand",
        key: "brand",
        name: "眼科企业",
        aliases: [],
        type: "BRAND",
        enterpriseId: scope.enterpriseId,
        topics: [],
      },
    ] as never);
    prisma.$queryRaw.mockResolvedValue([
      { chunkId: "history", lexicalScore: 1, vectorScore: 0.9 },
      { chunkId: "archive", lexicalScore: 1, vectorScore: 0.9 },
    ]);
    prisma.materialChunk.findMany.mockResolvedValue(
      ["history", "archive"].map((id) => ({
        id,
        materialId: id,
        text: "品牌资料",
        textChecksum: id,
        ordinal: 1,
        enterpriseId: scope.enterpriseId,
        scopeKey: scope.enterpriseId,
        material: {
          type: "TEXT",
          structuredFacts:
            id === "archive" ? { medicalMaterial: { ...evidence, purpose: "ARCHIVE" } } : {},
          title: id,
          version: 1,
          seriesId: id,
          analysis: {},
          tags: [],
        },
      })) as never,
    );
    const result = await service.retrieve(scope, "介绍品牌", undefined, undefined, ["brand"]);
    expect(result.query).toContain("眼科企业");
    expect(result.focusEntityIds).toEqual(["brand"]);
    expect(result.hits.map((hit) => hit.materialId)).toEqual(["history"]);
    for (const [query] of prisma.$queryRaw.mock.calls) {
      expect(query.text).not.toContain("'purpose' = 'ANSWER_EVIDENCE'");
      expect(query.text.slice(0, query.text.indexOf("LIMIT"))).toContain("<> 'ARCHIVE'");
    }
  });

  it("preserves general industry retrieval without requiring medical classification", async () => {
    const { prisma, service } = fixture();
    prisma.enterprise.findFirst.mockResolvedValue({ name: "咖啡企业", industry: "餐饮" });
    prisma.$queryRaw.mockResolvedValue([{ chunkId: "menu", lexicalScore: 0, vectorScore: 0 }]);
    prisma.materialChunk.findMany.mockResolvedValue([
      {
        id: "menu",
        materialId: "menu",
        text: "咖啡菜单",
        textChecksum: "menu",
        ordinal: 1,
        enterpriseId: scope.enterpriseId,
        scopeKey: scope.enterpriseId,
        material: {
          type: "TEXT",
          structuredFacts: {},
          title: "菜单",
          version: 1,
          seriesId: "menu",
          analysis: {},
          tags: [],
        },
      },
    ]);
    expect((await service.retrieve(scope, "菜单")).hits.map((hit) => hit.materialId)).toEqual([
      "menu",
    ]);
    for (const [query] of prisma.$queryRaw.mock.calls) {
      expect(query.text).not.toContain("'purpose' = 'ANSWER_EVIDENCE'");
    }
  });

  it("refuses legacy or unconfirmed photos as new medical references", async () => {
    for (const annotation of [undefined, { ...scene, privacyConfirmed: false }]) {
      const { prisma, service } = fixture();
      prisma.material.findMany.mockResolvedValue([
        {
          id: "scene",
          title: "旧照片",
          enterpriseId: scope.enterpriseId,
          structuredFacts: { medicalMaterial: scene },
          artifacts: [
            {
              id: "scene-image",
              objectKey: "private/scene",
              checksum: "hash",
              mimeType: "image/png",
              metadata: {
                usage: "REFERENCE",
                usabilityStatus: "USABLE",
                medicalMaterial: annotation,
              },
            },
          ],
        },
      ]);
      await expect(
        service.selectImageAssets(scope, "准备什么", ["scene-image"], null),
      ).rejects.toThrow("已不可用");
    }
  });
});
