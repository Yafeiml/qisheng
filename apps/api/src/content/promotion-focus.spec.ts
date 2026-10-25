import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";
import { RequestAccessContext } from "../access/request-access-context";
import { CreateCampaignDto } from "../campaign/campaign.dto";
import type { PrismaService } from "../database/prisma.service";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { ContentService } from "./content.service";
import type { MaterialIngestionQueueService } from "./material-ingestion-queue.service";
import { MaterialRetrievalService } from "./material-retrieval.service";
import {
  effectivePromotionFocus,
  recommendPromotionFocus,
  selectPromotionFocus,
} from "./promotion-focus";

const focus = (
  id: string,
  name: string,
  aliases: string[] = [],
  enterpriseId: string | null = "enterprise",
) => ({
  id,
  name,
  aliases,
  enterpriseId,
  key: `DOCTOR:${name}`,
  type: "DOCTOR",
  version: 1,
  seriesId: id,
  topics: [{ question: `${name}相关问题`, intent: "科普认知" }],
});
const person = focus("person", "周示例", ["周教授"]);
const product = focus("product", "ICLV5", ["ICL V5"]);
const scope = { enterpriseId: "enterprise", tenantId: "tenant" };

const imageMaterial = (
  id: string,
  name: string,
  keywords: string[],
  aliases: string[] = [],
  usage = "REFERENCE",
  enterpriseId: string | null = "enterprise",
) => ({
  id,
  title: `${name}照片`,
  tags: keywords,
  supplement: "",
  analysis: {},
  enterpriseId,
  artifacts: [
    {
      id: `${id}-image`,
      objectKey: `private/${id}`,
      checksum: `${id}-hash`,
      mimeType: "image/png",
      originalFileName: `${name}.png`,
      metadata: {
        usage,
        usabilityStatus: "USABLE",
        description: `${name}授权原图`,
        analysis: {
          personFocused: usage === "REFERENCE",
          keywords,
          entities:
            usage === "LOGO" ? [] : [{ name, aliases, kind: "PERSON", source: "SUPPLEMENT" }],
        },
      },
    },
  ],
});

function fixture(shared = false) {
  const prisma = {
    runtimePolicy: {
      findUnique: vi.fn().mockResolvedValue({
        retrievalTopK: 5,
        retrievalMaxContextCharacters: 8000,
        retrievalStrategyVersion: "test",
      }),
    },
    enterprise: { findFirst: vi.fn().mockResolvedValue({ name: "测试企业" }) },
    geoEntity: { findMany: vi.fn().mockResolvedValue([person, product]) },
    material: { findMany: vi.fn().mockResolvedValue([]) },
    sensitiveRule: { findMany: vi.fn().mockResolvedValue([]) },
    materialChunk: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const capabilities = {
    current: vi.fn().mockResolvedValue({ groupSharedMaterialsEnabled: shared }),
  };
  const context = new RequestAccessContext();
  context.initialize({
    audience: "SAAS_ADMIN",
    userId: "admin",
    scope: { type: "ENTERPRISE", ...scope },
    permissions: ["geo.read", "material.read"],
  });
  return {
    prisma,
    capabilities,
    retrieval: new MaterialRetrievalService(
      prisma as unknown as PrismaService,
      capabilities as unknown as TenantCapabilityService,
    ),
    content: new ContentService(
      prisma as unknown as PrismaService,
      capabilities as unknown as TenantCapabilityService,
      context,
      {} as MaterialIngestionQueueService,
    ),
  };
}

describe("optional promotion focus", () => {
  it("matches names and aliases, not generic questions; honors explicit none and manual choices", () => {
    expect(selectPromotionFocus([person, product], "为周教授撰写科普介绍")).toEqual([person]);
    expect(selectPromotionFocus([person, product], "ICL V5特点")).toEqual([product]);
    expect(selectPromotionFocus([person, product], "一般科普认知")).toEqual([]);
    expect(selectPromotionFocus([person, product], "周教授", [])).toEqual([]);
    expect(selectPromotionFocus([person, product], "介绍人物", [product.id])).toEqual([product]);
    expect(selectPromotionFocus([focus("ai", "AI")], "chair product")).toEqual([]);
  });

  it("rejects unknown, stale, cross-scope or duplicate selections and enforces limit", () => {
    expect(() => selectPromotionFocus([person], "", ["foreign"])).toThrow("重新选择");
    expect(() => selectPromotionFocus([person], "", [person.id, person.id])).toThrow("重复");
    expect(() =>
      selectPromotionFocus(
        [],
        "",
        Array.from({ length: 21 }, (_, i) => `${i}`),
      ),
    ).toThrow("20");
  });

  it("enterprise override wins regardless of row order", () => {
    const shared = focus("shared", person.name, [], null);
    expect(effectivePromotionFocus([shared, person], "enterprise")).toEqual([person]);
    expect(effectivePromotionFocus([person, shared], "enterprise")).toEqual([person]);
  });

  it("only recommends grounded named objects, deduplicates aliases and excludes filename guesses", () => {
    const entity = (name: string, source = "CONTENT") => ({
      name,
      aliases: [],
      source,
      kind: "PERSON",
      evidence: "资料中的人物介绍",
    });
    const rows = [
      {
        id: "material",
        title: "人物资料",
        enterpriseId: "enterprise",
        analysis: {
          entities: [
            entity("周教授"),
            entity("李老师"),
            entity("猜测名字", "FILENAME"),
            { ...entity("无证据"), evidence: "" },
          ],
        },
      },
    ];
    const result = recommendPromotionFocus([...rows, ...rows], [person]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "李老师", materialId: "material", type: "DOCTOR" });
  });

  it("medical sources do not turn people or products into doctor and device recommendations", () => {
    const source = {
      id: "medical-material",
      title: "历史医生和设备资料",
      enterpriseId: "enterprise",
      medical: true,
      analysis: {
        entities: [
          { name: "李老师", kind: "PERSON", source: "CONTENT", evidence: "资料人物" },
          { name: "某设备", kind: "PRODUCT", source: "CONTENT", evidence: "资料设备" },
          { name: "某品牌", kind: "BRAND", source: "CONTENT", evidence: "品牌归属" },
        ],
      },
    };
    expect(recommendPromotionFocus([source], []).map(({ type }) => type)).toEqual(["BRAND"]);
    expect(
      recommendPromotionFocus([{ ...source, medical: false }], []).map(({ type }) => type),
    ).toEqual(["DOCTOR", "DEVICE", "BRAND"]);
    expect(selectPromotionFocus([person], "", [person.id])).toEqual([person]);
  });

  it("restores optional focus recommendations from authorized medical enterprise history", async () => {
    const f = fixture();
    f.prisma.enterprise.findFirst.mockResolvedValue({
      name: "眼科",
      industry: "医疗健康",
    } as never);
    f.prisma.material.findMany.mockResolvedValue([
      {
        id: "legacy",
        title: "旧资料",
        type: "TEXT",
        enterpriseId: null,
        analysis: {
          entities: [{ name: "李老师", kind: "PERSON", source: "CONTENT", evidence: "旧介绍" }],
        },
      },
    ] as never);
    expect(await f.content.focusRecommendations(scope)).toMatchObject([
      { name: "李老师", materialId: "legacy" },
    ]);
  });

  it("retrieval expands only selected focus; closed group capability excludes group scope", async () => {
    const f = fixture();
    const result = await f.retrieval.retrieve(scope, "介绍周教授");
    expect(result.focusEntityIds).toEqual([person.id]);
    expect(result.query).toContain("周示例");
    expect(result.query).not.toContain("ICLV5");
    expect(f.prisma.geoEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ enterpriseId: "enterprise" }], status: "ACTIVE", tenantId: "tenant" },
      }),
    );
    const none = await f.retrieval.retrieve(scope, "介绍周教授", new Date(), undefined, []);
    expect(none.focusEntityIds).toEqual([]);
    expect(none.query).not.toContain("周示例");
    await expect(
      f.retrieval.retrieve(scope, "介绍", new Date(), undefined, ["foreign"]),
    ).rejects.toThrow("重新选择");
  });

  it("uses confirmed person aliases for image ranking and rejects a different doctor despite shared procedure keywords", async () => {
    const f = fixture(true);
    f.prisma.geoEntity.findMany.mockResolvedValue([focus("gao", "林示例", ["林院长"]), person]);
    const gao = imageMaterial("gao", "林示例", ["专家介绍"], [], "REFERENCE", null);
    const liu = imageMaterial("liu", "周示例", ["全飞秒", "推广", "技术"]);
    f.prisma.material.findMany.mockResolvedValue([liu, gao] as never);
    const prompt = "对林院长进行全飞秒技术的推广";
    const preview = await f.retrieval.retrieve(scope, prompt);
    expect(
      preview.images?.filter((image) => image.score > 0).map((image) => image.artifactId),
    ).toEqual(["gao-image"]);
    expect(
      (await f.retrieval.selectImageAssets(scope, prompt)).map((asset) => asset.artifactId),
    ).toEqual(["gao-image"]);
    await expect(f.retrieval.selectImageAssets(scope, prompt, ["liu-image"])).rejects.toThrow(
      "人物参考图与本次主题不匹配",
    );
    expect(await f.retrieval.selectImageAssets(scope, prompt, [])).toEqual([]);
  });

  it("matches aliases from per-image analysis without configured focus and does not guess identity from a filename", async () => {
    const f = fixture();
    f.prisma.geoEntity.findMany.mockResolvedValue([]);
    const gao = imageMaterial("gao", "林示例", ["全飞秒"], ["林院长"]);
    const unknown = imageMaterial("unknown", "林示例", ["全飞秒"]);
    const artifact = unknown.artifacts[0];
    const entity = artifact?.metadata.analysis.entities[0];
    if (!artifact || !entity) throw new Error("Missing image fixture");
    entity.source = "FILENAME";
    artifact.metadata.description = "人物身份未确认的白衣照片";
    f.prisma.material.findMany.mockResolvedValue([unknown, gao] as never);
    expect((await f.retrieval.selectImageAssets(scope, "林院长全飞秒"))[0]?.artifactId).toBe(
      "gao-image",
    );
    await expect(
      f.retrieval.selectImageAssets(scope, "林院长全飞秒", ["unknown-image"]),
    ).rejects.toThrow("不匹配");
  });

  it("keeps unrelated image chunks out of retrieval evidence", async () => {
    const f = fixture();
    f.prisma.geoEntity.findMany.mockResolvedValue([focus("gao", "林示例", ["林院长"])]);
    const gao = imageMaterial("gao", "林示例", ["全飞秒"]);
    const liu = imageMaterial("liu", "周示例", ["全飞秒"]);
    f.prisma.material.findMany.mockResolvedValue([liu, gao] as never);
    f.prisma.$queryRaw.mockResolvedValue([
      { chunkId: "liu-chunk", lexicalScore: 1 },
      { chunkId: "gao-chunk", lexicalScore: 0.9 },
    ]);
    f.prisma.materialChunk.findMany.mockResolvedValue(
      [liu, gao].map((material) => ({
        id: `${material.id}-chunk`,
        materialId: material.id,
        enterpriseId: "enterprise",
        scopeKey: "enterprise",
        ordinal: 0,
        text: `${material.title} ${"人物介绍".repeat(40)}`,
        textChecksum: material.id,
        metadata: { artifactId: `${material.id}-image` },
        material: { ...material, type: "IMAGE_REFERENCE", version: 1, seriesId: material.id },
      })) as never,
    );
    const preview = await f.retrieval.retrieve(scope, "林院长全飞秒技术推广");
    expect(preview.hits.map((hit) => hit.materialId)).toEqual(["gao"]);
    expect(preview.hits[0]?.materialType).toBe("IMAGE_REFERENCE");
  });

  it("resolves a legacy person record from confirmed name and job title without GEO or saved aliases", async () => {
    const f = fixture(true);
    f.prisma.geoEntity.findMany.mockResolvedValue([]);
    const gao = imageMaterial("gao", "林示例", ["全飞秒"], [], "REFERENCE", null);
    const artifact = gao.artifacts[0];
    if (!artifact) throw new Error("Missing image fixture");
    gao.analysis = artifact.metadata.analysis;
    artifact.metadata = null as never;
    gao.supplement =
      "图中是示例眼科副主任医师林示例\\n职务：示例测试眼科医院院长\\n经历：蔡司全飞秒手术专家";
    const liu = imageMaterial("liu", "周示例", ["全飞秒"]);
    f.prisma.material.findMany.mockResolvedValue([liu, gao] as never);
    const preview = await f.retrieval.retrieve(scope, "对林院长进行全飞秒技术的推广");
    expect(
      preview.images?.filter((image) => image.score > 0).map((image) => image.artifactId),
    ).toEqual(["gao-image"]);
    expect(
      (await f.retrieval.selectImageAssets(scope, "对林院长进行全飞秒技术的推广"))[0]?.artifactId,
    ).toBe("gao-image");
    await expect(
      f.retrieval.selectImageAssets(scope, "对林院长进行全飞秒技术的推广", ["liu-image"]),
    ).rejects.toThrow("不匹配");
  });

  it("does not guess a job title or choose between two doctors sharing the same short title", async () => {
    const f = fixture();
    f.prisma.geoEntity.findMany.mockResolvedValue([]);
    const first = imageMaterial("first", "林示例", ["全飞秒"]);
    f.prisma.material.findMany.mockResolvedValue([first] as never);
    expect(await f.retrieval.selectImageAssets(scope, "林院长全飞秒")).toEqual([]);
    first.supplement = "林示例\n职务：业务院长";
    const second = imageMaterial("second", "林测试", ["全飞秒"]);
    second.supplement = "林测试\n职务：院长";
    f.prisma.material.findMany.mockResolvedValue([first, second] as never);
    expect(await f.retrieval.selectImageAssets(scope, "林院长全飞秒")).toEqual([]);
    const preview = await f.retrieval.retrieve(scope, "林院长全飞秒");
    expect(preview.imageSelectionRequired).toBe(true);
    expect(
      preview.images?.filter((image) => image.score > 0).map((image) => image.artifactId),
    ).toEqual(["first-image", "second-image"]);
    expect(
      (await f.retrieval.selectImageAssets(scope, "林院长全飞秒", ["second-image"]))[0]?.artifactId,
    ).toBe("second-image");
    expect((await f.retrieval.selectImageAssets(scope, "林示例全飞秒"))[0]?.artifactId).toBe(
      "first-image",
    );
  });

  it.each([false, true])(
    "shows same-surname candidates for manual selection with recorded alias = %s",
    async (recordedAlias) => {
      const f = fixture();
      const doctors = [
        focus("li-ming", "李明", recordedAlias ? ["李主任"] : []),
        focus("li-qiang", "李强", recordedAlias ? ["李主任"] : []),
      ];
      f.prisma.geoEntity.findMany.mockResolvedValue([...doctors, focus("wang", "王强", ["主任"])]);
      const images = Array.from({ length: 7 }, (_, index) =>
        imageMaterial(
          `li-${index}`,
          index % 2 === 0 ? "李明" : "李强",
          ["全飞"],
          recordedAlias ? ["李主任"] : [],
        ),
      );
      const unrelated = imageMaterial("wang", "王强", ["全飞"]);
      const unrelatedPerson = unrelated.artifacts[0]?.metadata.analysis.entities[0];
      if (!unrelatedPerson) throw new Error("Missing image fixture");
      unrelatedPerson.aliases = ["主任"];
      f.prisma.material.findMany.mockResolvedValue([...images, unrelated] as never);
      const prompt = "推广李主任的全飞手术";
      const preview = await f.retrieval.retrieve(scope, prompt);
      expect(preview.imageSelectionRequired).toBe(true);
      expect(preview.focusEntityIds).toEqual([]);
      expect(preview.query).not.toContain("李明");
      expect(preview.query).not.toContain("李强");
      expect(preview.query).not.toContain("王强");
      expect(
        preview.images
          ?.filter((image) => image.score > 0)
          .slice(0, 5)
          .map((image) => image.artifactId),
      ).toEqual(["li-0-image", "li-1-image", "li-2-image", "li-3-image", "li-4-image"]);
      expect(await f.retrieval.selectImageAssets(scope, prompt)).toEqual([]);
      expect(await f.retrieval.selectImageAssets(scope, prompt, [])).toEqual([]);
      expect(
        (await f.retrieval.selectImageAssets(scope, prompt, ["li-1-image"]))[0]?.artifactId,
      ).toBe("li-1-image");
      await expect(f.retrieval.selectImageAssets(scope, prompt, ["wang-image"])).rejects.toThrow(
        "不匹配",
      );
      const explicit = await f.retrieval.retrieve(scope, "推广李主任（李明）的全飞手术");
      expect(explicit.imageSelectionRequired).toBe(false);
      expect(explicit.focusEntityIds).toEqual(["li-ming"]);
      expect(
        explicit.images?.filter((image) => image.score > 0).map((image) => image.artifactId),
      ).toEqual(["li-0-image", "li-2-image", "li-4-image", "li-6-image"]);
      expect(
        (await f.retrieval.selectImageAssets(scope, "推广李明主任的全飞手术"))[0]?.artifactId,
      ).toBe("li-0-image");
    },
  );

  it("does not automatically cite ambiguous image or personal text facts, while keeping general technical material", async () => {
    const f = fixture();
    f.prisma.geoEntity.findMany.mockResolvedValue([
      focus("li-ming", "李明", ["李主任"]),
      focus("li-qiang", "李强", ["李主任"]),
    ]);
    const li = imageMaterial("li", "李明", ["全飞"], ["李主任"]);
    f.prisma.material.findMany.mockResolvedValue([li] as never);
    const chunks = [
      {
        id: "photo",
        materialId: "li",
        type: "IMAGE_REFERENCE",
        analysis: li.artifacts[0]?.metadata.analysis,
        metadata: { artifactId: "li-image" },
      },
      {
        id: "person",
        materialId: "li-intro",
        type: "TEXT",
        analysis: li.artifacts[0]?.metadata.analysis,
        metadata: {},
      },
      {
        id: "technology",
        materialId: "tech",
        type: "TEXT",
        analysis: { entities: [] },
        metadata: {},
      },
    ];
    f.prisma.$queryRaw.mockResolvedValue(
      chunks.map((chunk) => ({ chunkId: chunk.id, lexicalScore: 1 })),
    );
    f.prisma.materialChunk.findMany.mockResolvedValue(
      chunks.map((chunk) => ({
        ...chunk,
        enterpriseId: "enterprise",
        scopeKey: "enterprise",
        ordinal: 0,
        text: "全飞手术设备简介".repeat(20),
        textChecksum: chunk.id,
        material: {
          title: chunk.id,
          type: chunk.type,
          tags: ["全飞"],
          analysis: chunk.analysis,
          version: 1,
          seriesId: chunk.materialId,
        },
      })) as never,
    );
    expect(
      (await f.retrieval.retrieve(scope, "推广李主任的全飞手术")).hits.map((hit) => hit.materialId),
    ).toEqual(["tech"]);
  });

  it("freezes enterprise logo variants for automatic contrast choice while preserving explicit lab choices and shared fallback", async () => {
    const f = fixture(true);
    const logos = [
      imageMaterial("shared", "集团", [], [], "LOGO", null),
      imageMaterial("light", "浅色", [], [], "LOGO"),
      imageMaterial("dark", "深色", [], [], "LOGO"),
    ];
    f.prisma.material.findMany.mockResolvedValue(logos as never);
    expect(
      (await f.retrieval.selectImageAssets(scope, "一般科普", [])).map((asset) => asset.artifactId),
    ).toEqual(["light-image", "dark-image"]);
    expect(
      (await f.retrieval.selectImageAssets(scope, "一般科普", [], "light-image")).map(
        (asset) => asset.artifactId,
      ),
    ).toEqual(["light-image"]);
    expect(await f.retrieval.selectImageAssets(scope, "一般科普", [], null)).toEqual([]);
    await expect(f.retrieval.selectImageAssets(scope, "一般科普", [], "foreign")).rejects.toThrow(
      "不可用",
    );
    f.prisma.material.findMany.mockResolvedValue([logos[0]] as never);
    expect(
      (await f.retrieval.selectImageAssets(scope, "一般科普", [])).map((asset) => asset.artifactId),
    ).toEqual(["shared-image"]);
  });

  it("retrieval and generation context use exactly the same selected identities, including none", async () => {
    const f = fixture(true);
    const result = await f.retrieval.retrieve(scope, "周教授相关活动");
    const context = await f.content.generationContext(
      scope.tenantId,
      scope.enterpriseId,
      new Date(),
      [],
      result.focusEntityIds,
    );
    expect(context.geoEntities.map((row) => row.id)).toEqual(result.focusEntityIds);
    expect(
      (await f.content.generationContext(scope.tenantId, scope.enterpriseId, new Date(), [], []))
        .geoEntities,
    ).toEqual([]);
    expect(f.prisma.geoEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ enterpriseId: "enterprise" }, { enterpriseId: null }],
        }),
      }),
    );
  });

  it("recommendations query only active authorized valid usable scoped materials", async () => {
    const f = fixture();
    await f.content.focusRecommendations(scope);
    expect(f.prisma.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ enterpriseId: "enterprise" }],
          tenantId: "tenant",
          authorizationStatus: "AUTHORIZED",
          status: "ACTIVE",
          ingestionStatus: "READY",
          usabilityStatus: "USABLE",
          AND: expect.any(Array),
        }),
      }),
    );
    await expect(
      f.content.focusRecommendations({ ...scope, enterpriseId: "foreign" }),
    ).rejects.toThrow("scope");
  });

  it("DTO accepts omitted/empty focus and rejects null", async () => {
    for (const selection of [undefined, []]) {
      const errors = await validate(
        plainToInstance(CreateCampaignDto, {
          title: "测试活动",
          prompt: "测试活动介绍",
          focusEntityIds: selection,
        }),
      );
      expect(errors).toEqual([]);
    }
    expect(
      (
        await validate(
          plainToInstance(CreateCampaignDto, {
            title: "测试活动",
            prompt: "测试活动介绍",
            focusEntityIds: null,
          }),
        )
      ).some((error) => error.property === "focusEntityIds"),
    ).toBe(true);
  });
});
