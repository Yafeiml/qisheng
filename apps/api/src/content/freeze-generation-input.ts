import { ConflictException } from "@nestjs/common";
import {
  assetRecord,
  type FrozenImageAsset,
  type GenerationStyleSnapshot,
  type IndustryGenerationGuidanceSnapshot,
  imageAssetDetails,
  readMedicalMaterial,
} from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";
import type { ContentService } from "./content.service";
import type { MaterialRetrievalResult } from "./material-retrieval.service";

type GenerationContext = Awaited<ReturnType<ContentService["generationContext"]>>;
export function freezeGenerationInput(
  context: GenerationContext,
  retrieval: MaterialRetrievalResult,
  generationStyle: GenerationStyleSnapshot,
  industryGuidance?: IndustryGenerationGuidanceSnapshot | null,
): Record<string, unknown> {
  const evidenceByMaterial = new Map<string, string[]>();
  for (const hit of retrieval.hits) {
    const snippets = evidenceByMaterial.get(hit.materialId) ?? [];
    snippets.push(hit.snippet);
    evidenceByMaterial.set(hit.materialId, snippets);
  }
  const materials = context.materials.map((material) => ({
    content: (evidenceByMaterial.get(material.id) ?? [material.content]).join("\n\n"),
    enterpriseId: material.enterpriseId,
    id: material.id,
    seriesId: material.seriesId,
    title: material.title,
    version: material.version,
  }));
  const geoEntities = context.geoEntities.slice(0, 20).map((entity) => ({
    aliases: entity.aliases,
    enterpriseId: entity.enterpriseId,
    id: entity.id,
    name: entity.name,
    seriesId: entity.seriesId,
    topics: entity.topics.slice(0, 20).map((topic) => ({
      id: topic.id,
      question: topic.question,
      seriesId: topic.seriesId,
      version: topic.version,
    })),
    type: entity.type,
    version: entity.version,
  }));
  const sensitiveRules = context.sensitiveRules.map((rule) => ({
    enterpriseId: rule.enterpriseId,
    id: rule.id,
    replacementSuggestion: rule.replacementSuggestion,
    riskType: rule.riskType,
    seriesId: rule.seriesId,
    severity: rule.severity,
    term: rule.term,
    version: rule.version,
  }));
  return {
    ...(industryGuidance ? { industryGuidance } : {}),
    focusEntityIds: geoEntities.map(({ id }) => id),
    generationStyle,
    geoSummary: geoEntities
      .map(
        (entity) =>
          `${entity.name}（${entity.type}）：${entity.topics.map(({ question }) => question).join("；")}`,
      )
      .join("\n"),
    materials,
    materialSummary: materials
      .map((material) => `${material.title}：${material.content}`)
      .join("\n\n"),
    sensitiveRules,
    sensitiveRuleSummary: sensitiveRules
      .map(
        (rule) =>
          `${rule.severity} ${rule.term}${rule.replacementSuggestion ? ` → ${rule.replacementSuggestion}` : ""}`,
      )
      .join("\n"),
    sourceContext: {
      ...(industryGuidance ? { industryGuidance } : {}),
      assetSnapshot: {
        geoEntities,
        materials: materials.map(({ enterpriseId, id, seriesId, title, version }) => ({
          enterpriseId,
          id,
          seriesId,
          title,
          version,
        })),
        sensitiveRules: sensitiveRules.map(({ enterpriseId, id, seriesId, term, version }) => ({
          enterpriseId,
          id,
          seriesId,
          term,
          version,
        })),
      },
      geoEntities,
      materialIds: materials.map((material) => material.id),
      materialTitles: materials.map((material) => material.title),
      retrievalEvidence: retrieval.hits.map((hit) => ({
        chunkId: hit.chunkId,
        hitReasons: hit.hitReasons,
        materialId: hit.materialId,
        rank: hit.rank,
        score: hit.score,
        snippet: hit.snippet,
      })),
      retrievalStrategyVersion: retrieval.strategyVersion,
      schemaVersion: "content-assets-v3",
      sensitiveRuleIds: sensitiveRules.map((rule) => rule.id),
    },
  };
}

export async function freezeIndustryGenerationGuidance(
  database: Pick<Prisma.TransactionClient, "industry">,
  name: string | null | undefined,
): Promise<IndustryGenerationGuidanceSnapshot | null> {
  if (!name) return null;
  const industry = await database.industry.findUnique({
    where: { name },
    select: { name: true, generationGuidance: true, updatedAt: true },
  });
  return industry ? { ...industry, updatedAt: industry.updatedAt.toISOString() } : null;
}

export async function assertFrozenImageAssetsCurrent(
  database: Pick<Prisma.TransactionClient, "materialArtifact">,
  scope: { tenantId: string; enterpriseId: string },
  assets: readonly FrozenImageAsset[],
  now = new Date(),
) {
  if (!assets.length) return;
  const rows = await database.materialArtifact.findMany({
    where: {
      id: { in: assets.map(({ artifactId }) => artifactId) },
      tenantId: scope.tenantId,
      status: { in: ["STORED", "VERIFIED"] },
      material: {
        tenantId: scope.tenantId,
        type: "IMAGE_REFERENCE",
        OR: [{ enterpriseId: scope.enterpriseId }, { enterpriseId: null }],
        status: "ACTIVE",
        authorizationStatus: "AUTHORIZED",
        ingestionStatus: "READY",
        usabilityStatus: "USABLE",
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
    },
    select: {
      id: true,
      materialId: true,
      objectKey: true,
      checksum: true,
      mimeType: true,
      metadata: true,
      material: { select: { structuredFacts: true } },
    },
  });
  if (
    rows.length !== assets.length ||
    assets.some((asset) => {
      const row = rows.find(({ id }) => id === asset.artifactId);
      const details = imageAssetDetails(row?.metadata);
      const materialPolicy = readMedicalMaterial(
        assetRecord(row?.material.structuredFacts).medicalMaterial,
      );
      const artifactPolicy = readMedicalMaterial(assetRecord(row?.metadata).medicalMaterial);
      return (
        !row ||
        row.materialId !== asset.materialId ||
        row.objectKey !== asset.objectKey ||
        row.checksum !== asset.checksum ||
        row.mimeType !== asset.mimeType ||
        !row.mimeType.startsWith("image/") ||
        asset.usage !== "REFERENCE" ||
        asset.privacyConfirmed !== true ||
        asset.authorizationConfirmed !== true ||
        materialPolicy?.purpose !== "REAL_SCENE" ||
        artifactPolicy?.purpose !== "REAL_SCENE" ||
        details.usage !== "REFERENCE" ||
        details.usabilityStatus !== "USABLE"
      );
    })
  )
    throw new ConflictException("原图授权、隐私、用途、版本或内容在预检后发生变化，请重新选择");
}
