import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { CampaignStatus, Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { ContentService } from "../content/content.service";
import { PrismaService } from "../database/prisma.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";

type EnterpriseScope = Readonly<{ enterpriseId: string; tenantId: string }>;
type EffectiveGeoEntity = Awaited<ReturnType<ContentService["effectiveGeoEntities"]>>[number];
type CampaignRow = Readonly<{
  blueprint: Readonly<{ sourceContext: Prisma.JsonValue }> | null;
  createdAt: Date;
  employeeContents: readonly Readonly<{ body: string; hashtags: string[]; title: string }>[];
  id: string;
  status: CampaignStatus;
  title: string;
  visibleAt: Date;
}>;

type FrozenTopic = Readonly<{ question: string; seriesId: string }>;
type FrozenEntity = Readonly<{
  aliases: readonly string[];
  name: string;
  seriesId: string;
  topics: readonly FrozenTopic[];
}>;

type ResourceDelivery = Readonly<{
  eligible: number;
  hits: number;
}>;

type CampaignMeasurement = Readonly<{
  entityDelivery: ReadonlyMap<string, ResourceDelivery>;
  publicView: ReturnType<typeof campaignCoverageView>;
  targetEntities: readonly FrozenEntity[];
  topicDelivery: ReadonlyMap<string, ResourceDelivery>;
}>;

@Injectable()
export class GeoAnalyticsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(TenantCapabilityService)
    private readonly capabilities: TenantCapabilityService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  async getEnterpriseSummary(scope: EnterpriseScope, rawDays?: string) {
    this.requireEnterpriseScope(scope);
    const geoLevel = await this.capabilities.requireGeoEnabled(scope.tenantId);
    const analysis = await this.buildEnterpriseAnalysis(scope, normalizeDays(rawDays));
    return summaryView(analysis, geoLevel);
  }

  async getEnterpriseCampaigns(scope: EnterpriseScope, rawDays?: string) {
    this.requireEnterpriseScope(scope);
    await this.capabilities.requireGeoEnabled(scope.tenantId);
    const analysis = await this.buildEnterpriseAnalysis(scope, normalizeDays(rawDays));
    return analysis.measurements.map(({ publicView }) => publicView);
  }

  async getEnterpriseTrends(scope: EnterpriseScope, rawDays?: string) {
    this.requireEnterpriseScope(scope);
    await this.capabilities.requireGeoEnabled(scope.tenantId);
    const analysis = await this.buildEnterpriseAnalysis(scope, normalizeDays(rawDays));
    return [...analysis.measurements]
      .reverse()
      .map(({ publicView }) => ({ ...publicView, date: publicView.createdAt.slice(0, 10) }));
  }

  async getEnterpriseGaps(scope: EnterpriseScope, rawDays?: string) {
    this.requireEnterpriseScope(scope);
    await this.capabilities.requireGeoEnabled(scope.tenantId);
    const analysis = await this.buildEnterpriseAnalysis(scope, normalizeDays(rawDays));
    return gapViews(analysis.assets, analysis.measurements);
  }

  async getTenantComparison(tenantId: string, rawDays?: string) {
    this.requireTenantScope(tenantId);
    const geoLevel = await this.capabilities.requireGeoEnabled(tenantId);
    const lookbackDays = normalizeDays(rawDays);
    const enterprises = await this.prisma.enterprise.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true },
      where: { status: "ACTIVE", tenantId },
    });
    const analyses = await Promise.all(
      enterprises.map(({ id }) =>
        this.buildEnterpriseAnalysis({ enterpriseId: id, tenantId }, lookbackDays),
      ),
    );
    return {
      enterprises: analyses.map((analysis) => {
        const summary = summaryView(analysis, geoLevel);
        return {
          activeEntityCount: summary.assets.activeEntityCount,
          activeTopicCount: summary.assets.activeTopicCount,
          completenessRate: summary.assets.completenessRate,
          employeeContentCount: summary.delivery.employeeContentCount,
          enterpriseId: summary.enterpriseId,
          enterpriseName: summary.enterpriseName,
          entityDeliveryRate: summary.delivery.entityHitRate,
          targetEntityCoverageRate: summary.target.targetEntityCoverageRate,
          targetTopicCoverageRate: summary.target.targetTopicCoverageRate,
          topicDeliveryRate: summary.delivery.topicHitRate,
        };
      }),
      generatedAt: new Date().toISOString(),
      geoLevel,
      lookbackDays,
      tenantId,
    };
  }

  private async buildEnterpriseAnalysis(scope: EnterpriseScope, lookbackDays: number) {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const [enterprise, assets, campaigns] = await Promise.all([
      this.prisma.enterprise.findFirstOrThrow({
        select: { id: true, name: true },
        where: { id: scope.enterpriseId, status: "ACTIVE", tenantId: scope.tenantId },
      }),
      this.content.effectiveGeoEntities(scope.tenantId, scope.enterpriseId),
      this.loadCampaigns(scope, since),
    ]);
    const measurements = campaigns.map((campaign) => measureCampaign(campaign, assets));
    return { assets, enterprise, lookbackDays, measurements, scope };
  }

  private loadCampaigns(scope: EnterpriseScope, since: Date) {
    return this.prisma.campaign.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        blueprint: { select: { sourceContext: true } },
        createdAt: true,
        employeeContents: { select: { body: true, hashtags: true, title: true } },
        id: true,
        status: true,
        title: true,
        visibleAt: true,
      },
      take: 500,
      where: {
        ...scope,
        blueprint: { isNot: null },
        createdAt: { gte: since },
        status: { not: "CANCELLED" },
      },
    });
  }

  private requireEnterpriseScope(scope: EnterpriseScope): void {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== scope.tenantId ||
      principal.scope.enterpriseId !== scope.enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match the requested enterprise");
    }
  }

  private requireTenantScope(tenantId: string): void {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "TENANT" || principal.scope.tenantId !== tenantId) {
      throw new ForbiddenException("Active request scope does not match the requested tenant");
    }
  }
}

function summaryView(
  analysis: Readonly<{
    assets: readonly EffectiveGeoEntity[];
    enterprise: Readonly<{ id: string; name: string }>;
    lookbackDays: number;
    measurements: readonly CampaignMeasurement[];
  }>,
  geoLevel: string,
) {
  const entitySeries = new Set(analysis.assets.map(({ seriesId }) => seriesId));
  const topicSeries = new Set(
    analysis.assets.flatMap(({ topics }) => topics.map(({ seriesId }) => seriesId)),
  );
  const targetedEntities = unionSets(
    analysis.measurements.map(
      ({ targetEntities }) => new Set(targetEntities.map(({ seriesId }) => seriesId)),
    ),
  );
  const targetedTopics = unionSets(
    analysis.measurements.map(
      ({ targetEntities }) =>
        new Set(targetEntities.flatMap(({ topics }) => topics.map(({ seriesId }) => seriesId))),
    ),
  );
  const delivery = sumDelivery(analysis.measurements);
  const currentTargetedEntityCount = intersectionSize(targetedEntities, entitySeries);
  const currentTargetedTopicCount = intersectionSize(targetedTopics, topicSeries);
  return {
    assets: assetCoverageView(analysis.assets),
    delivery: deliveryView(delivery),
    enterpriseId: analysis.enterprise.id,
    enterpriseName: analysis.enterprise.name,
    generatedAt: new Date().toISOString(),
    geoLevel,
    lookbackDays: analysis.lookbackDays,
    target: {
      campaignCount: analysis.measurements.length,
      currentTargetedEntityCount,
      currentTargetedTopicCount,
      targetEntityCoverageRate: ratio(currentTargetedEntityCount, entitySeries.size),
      targetTopicCoverageRate: ratio(currentTargetedTopicCount, topicSeries.size),
      targetedEntityCount: targetedEntities.size,
      targetedTopicCount: targetedTopics.size,
    },
  };
}

function assetCoverageView(assets: readonly EffectiveGeoEntity[]) {
  const activeEntityCount = assets.length;
  const activeTopicCount = assets.reduce((total, entity) => total + entity.topics.length, 0);
  const aliases = assets.filter(({ aliases: values }) => values.length > 0).length;
  const facts = assets.filter(({ facts: value }) => jsonObjectHasValues(value)).length;
  const withTopics = assets.filter(({ topics }) => topics.length > 0).length;
  const completeEntityCount = assets.filter(
    (entity) =>
      entity.aliases.length > 0 && jsonObjectHasValues(entity.facts) && entity.topics.length > 0,
  ).length;
  const completenessPoints = assets.reduce(
    (total, entity) =>
      total +
      1 +
      Number(entity.aliases.length > 0) +
      Number(jsonObjectHasValues(entity.facts)) +
      Number(entity.topics.length > 0),
    0,
  );
  return {
    activeEntityCount,
    activeTopicCount,
    aliasCoverageRate: ratio(aliases, activeEntityCount),
    completeEntityCount,
    completenessRate: ratio(completenessPoints, activeEntityCount * 4),
    entitiesWithoutTopics: activeEntityCount - withTopics,
    factsCoverageRate: ratio(facts, activeEntityCount),
    topicCoverageRate: ratio(withTopics, activeEntityCount),
  };
}

function measureCampaign(
  campaign: CampaignRow,
  assets: readonly EffectiveGeoEntity[],
): CampaignMeasurement {
  const targetEntities = frozenEntities(campaign.blueprint?.sourceContext);
  const currentEntitySeries = new Set(assets.map(({ seriesId }) => seriesId));
  const currentTopicSeries = new Set(
    assets.flatMap(({ topics }) => topics.map(({ seriesId }) => seriesId)),
  );
  const targetEntitySeries = new Set(targetEntities.map(({ seriesId }) => seriesId));
  const targetTopics = targetEntities.flatMap(({ topics }) => topics);
  const targetTopicSeries = new Set(targetTopics.map(({ seriesId }) => seriesId));
  const contents = campaign.employeeContents.map(({ body, hashtags, title }) =>
    normalizeComparable([title, body, ...hashtags].join(" ")),
  );
  const entityDelivery = new Map<string, ResourceDelivery>();
  const topicDelivery = new Map<string, ResourceDelivery>();

  for (const entity of targetEntities) {
    const terms = [entity.name, ...entity.aliases]
      .map(normalizeComparable)
      .filter((term) => term.length >= 2);
    const hits = contents.filter((content) => terms.some((term) => content.includes(term))).length;
    entityDelivery.set(entity.seriesId, { eligible: contents.length, hits });
    for (const topic of entity.topics) {
      const phrases = topicKeyPhrases(topic.question, terms);
      const topicHits = contents.filter((content) =>
        phrases.some((phrase) => content.includes(phrase)),
      ).length;
      topicDelivery.set(topic.seriesId, { eligible: contents.length, hits: topicHits });
    }
  }

  const delivery = {
    employeeContentCount: contents.length,
    entityEligibleCount: sumMap(entityDelivery, "eligible"),
    entityHitCount: sumMap(entityDelivery, "hits"),
    topicEligibleCount: sumMap(topicDelivery, "eligible"),
    topicHitCount: sumMap(topicDelivery, "hits"),
  };
  const currentTargetedEntityCount = intersectionSize(targetEntitySeries, currentEntitySeries);
  const currentTargetedTopicCount = intersectionSize(targetTopicSeries, currentTopicSeries);
  return {
    entityDelivery,
    publicView: campaignCoverageView(
      campaign,
      delivery,
      targetEntitySeries.size,
      targetTopicSeries.size,
      currentTargetedEntityCount,
      currentTargetedTopicCount,
      currentEntitySeries.size,
      currentTopicSeries.size,
    ),
    targetEntities,
    topicDelivery,
  };
}

function campaignCoverageView(
  campaign: CampaignRow,
  delivery: Readonly<{
    employeeContentCount: number;
    entityEligibleCount: number;
    entityHitCount: number;
    topicEligibleCount: number;
    topicHitCount: number;
  }>,
  targetedEntityCount: number,
  targetedTopicCount: number,
  currentTargetedEntityCount: number,
  currentTargetedTopicCount: number,
  currentEntityCount: number,
  currentTopicCount: number,
) {
  return {
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    createdAt: campaign.createdAt.toISOString(),
    delivery: deliveryView(delivery),
    status: campaign.status,
    target: {
      campaignCount: 1,
      currentTargetedEntityCount,
      currentTargetedTopicCount,
      targetEntityCoverageRate: ratio(currentTargetedEntityCount, currentEntityCount),
      targetTopicCoverageRate: ratio(currentTargetedTopicCount, currentTopicCount),
      targetedEntityCount,
      targetedTopicCount,
    },
    visibleAt: campaign.visibleAt.toISOString(),
  };
}

function gapViews(
  assets: readonly EffectiveGeoEntity[],
  measurements: readonly CampaignMeasurement[],
) {
  const gaps: Array<{
    coverageRate: number;
    deliveredContentCount: number;
    eligibleContentCount: number;
    gapType: "NOT_DELIVERED" | "NOT_TARGETED" | "PARTIALLY_DELIVERED";
    parentEntityName: string | null;
    resourceType: "ENTITY" | "TOPIC";
    seriesId: string;
    targetedCampaignCount: number;
    title: string;
  }> = [];
  for (const entity of assets) {
    const entityStats = resourceStats(
      measurements,
      entity.seriesId,
      "entityDelivery",
      (measurement) =>
        measurement.targetEntities.some(({ seriesId }) => seriesId === entity.seriesId),
    );
    const entityGapType = gapType(entityStats);
    if (entityGapType) {
      gaps.push({
        ...entityStats,
        coverageRate: ratio(entityStats.deliveredContentCount, entityStats.eligibleContentCount),
        gapType: entityGapType,
        parentEntityName: null,
        resourceType: "ENTITY",
        seriesId: entity.seriesId,
        title: entity.name,
      });
    }
    for (const topic of entity.topics) {
      const topicStats = resourceStats(
        measurements,
        topic.seriesId,
        "topicDelivery",
        (measurement) =>
          measurement.targetEntities.some(({ topics }) =>
            topics.some(({ seriesId }) => seriesId === topic.seriesId),
          ),
      );
      const topicGapType = gapType(topicStats);
      if (topicGapType) {
        gaps.push({
          ...topicStats,
          coverageRate: ratio(topicStats.deliveredContentCount, topicStats.eligibleContentCount),
          gapType: topicGapType,
          parentEntityName: entity.name,
          resourceType: "TOPIC",
          seriesId: topic.seriesId,
          title: topic.question,
        });
      }
    }
  }
  const priority = { NOT_DELIVERED: 0, NOT_TARGETED: 1, PARTIALLY_DELIVERED: 2 } as const;
  return gaps.sort(
    (left, right) =>
      priority[left.gapType] - priority[right.gapType] ||
      left.resourceType.localeCompare(right.resourceType) ||
      left.title.localeCompare(right.title, "zh-CN"),
  );
}

function resourceStats(
  measurements: readonly CampaignMeasurement[],
  seriesId: string,
  deliveryKey: "entityDelivery" | "topicDelivery",
  targeted: (measurement: CampaignMeasurement) => boolean,
) {
  let targetedCampaignCount = 0;
  let eligibleContentCount = 0;
  let deliveredContentCount = 0;
  for (const measurement of measurements) {
    if (!targeted(measurement)) continue;
    targetedCampaignCount += 1;
    const delivery = measurement[deliveryKey].get(seriesId);
    eligibleContentCount += delivery?.eligible ?? 0;
    deliveredContentCount += delivery?.hits ?? 0;
  }
  return { deliveredContentCount, eligibleContentCount, targetedCampaignCount };
}

function gapType(
  stats: Readonly<{
    deliveredContentCount: number;
    eligibleContentCount: number;
    targetedCampaignCount: number;
  }>,
): "NOT_DELIVERED" | "NOT_TARGETED" | "PARTIALLY_DELIVERED" | null {
  if (stats.targetedCampaignCount === 0) return "NOT_TARGETED";
  if (stats.deliveredContentCount === 0) return "NOT_DELIVERED";
  if (stats.deliveredContentCount < stats.eligibleContentCount) return "PARTIALLY_DELIVERED";
  return null;
}

function frozenEntities(value: Prisma.JsonValue | undefined): FrozenEntity[] {
  const source = jsonRecord(value);
  const snapshot = jsonRecord(source.assetSnapshot);
  const primaryRows = jsonArray(snapshot.geoEntities);
  const supplementalRows = jsonArray(source.geoEntities);
  const supplemental = new Map<string, Record<string, unknown>>();
  for (const row of supplementalRows) {
    const record = jsonRecord(row);
    for (const key of [
      stringValue(record.seriesId),
      stringValue(record.id),
      stringValue(record.name),
    ]) {
      if (key) supplemental.set(key, record);
    }
  }
  const entities = new Map<string, FrozenEntity>();
  for (const [index, row] of (primaryRows.length > 0 ? primaryRows : supplementalRows).entries()) {
    const record = jsonRecord(row);
    const extra =
      supplemental.get(stringValue(record.seriesId)) ??
      supplemental.get(stringValue(record.id)) ??
      supplemental.get(stringValue(record.name)) ??
      {};
    const name = stringValue(record.name) || stringValue(extra.name) || `未命名实体 ${index + 1}`;
    const seriesId =
      stringValue(record.seriesId) ||
      stringValue(extra.seriesId) ||
      stringValue(record.id) ||
      `entity:${normalizeComparable(name)}`;
    const aliases = stringArray(record.aliases).length
      ? stringArray(record.aliases)
      : stringArray(extra.aliases);
    const rawTopics = jsonArray(record.topics).length
      ? jsonArray(record.topics)
      : jsonArray(extra.topics);
    const topics = uniqueTopics(
      rawTopics.map((topic, topicIndex) => {
        if (typeof topic === "string") {
          return {
            question: topic,
            seriesId: `topic:${seriesId}:${normalizeComparable(topic) || topicIndex}`,
          };
        }
        const topicRecord = jsonRecord(topic);
        const question = stringValue(topicRecord.question) || `未命名主题 ${topicIndex + 1}`;
        return {
          question,
          seriesId:
            stringValue(topicRecord.seriesId) ||
            stringValue(topicRecord.id) ||
            `topic:${seriesId}:${normalizeComparable(question) || topicIndex}`,
        };
      }),
    );
    const existing = entities.get(seriesId);
    entities.set(seriesId, {
      aliases: [...new Set([...(existing?.aliases ?? []), ...aliases])],
      name: existing?.name ?? name,
      seriesId,
      topics: uniqueTopics([...(existing?.topics ?? []), ...topics]),
    });
  }
  return [...entities.values()];
}

function topicKeyPhrases(question: string, entityTerms: readonly string[]): string[] {
  const normalizedQuestion = question.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const chunks = normalizedQuestion
    .replace(/(为什么|是什么|有什么|有哪些|如何|是否|有何|怎么|哪种|可以|需要|相关|多少)/gu, "|")
    .replace(/[的与和及、，。！？；：,.!?;:\s]+/gu, "|")
    .split("|")
    .map(normalizeComparable)
    .filter((phrase) => phrase.length >= 2 && !entityTerms.includes(phrase));
  const full = normalizeComparable(normalizedQuestion);
  if (chunks.length === 0 && full.length >= 2 && !entityTerms.includes(full)) chunks.push(full);
  return [...new Set(chunks)];
}

function uniqueTopics(topics: readonly FrozenTopic[]): FrozenTopic[] {
  const values = new Map<string, FrozenTopic>();
  for (const topic of topics) values.set(topic.seriesId, topic);
  return [...values.values()];
}

function sumDelivery(measurements: readonly CampaignMeasurement[]) {
  return measurements.reduce(
    (total, { publicView }) => ({
      employeeContentCount: total.employeeContentCount + publicView.delivery.employeeContentCount,
      entityEligibleCount: total.entityEligibleCount + publicView.delivery.entityEligibleCount,
      entityHitCount: total.entityHitCount + publicView.delivery.entityHitCount,
      topicEligibleCount: total.topicEligibleCount + publicView.delivery.topicEligibleCount,
      topicHitCount: total.topicHitCount + publicView.delivery.topicHitCount,
    }),
    {
      employeeContentCount: 0,
      entityEligibleCount: 0,
      entityHitCount: 0,
      topicEligibleCount: 0,
      topicHitCount: 0,
    },
  );
}

function deliveryView(
  delivery: Readonly<{
    employeeContentCount: number;
    entityEligibleCount: number;
    entityHitCount: number;
    topicEligibleCount: number;
    topicHitCount: number;
  }>,
) {
  return {
    ...delivery,
    entityHitRate: ratio(delivery.entityHitCount, delivery.entityEligibleCount),
    topicHitRate: ratio(delivery.topicHitCount, delivery.topicEligibleCount),
  };
}

function sumMap(values: ReadonlyMap<string, ResourceDelivery>, field: keyof ResourceDelivery) {
  return [...values.values()].reduce((total, value) => total + value[field], 0);
}

function unionSets(sets: readonly ReadonlySet<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  return [...left].filter((value) => right.has(value)).length;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function jsonObjectHasValues(value: Prisma.JsonValue | null): boolean {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length,
  );
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeComparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeDays(value: string | undefined): number {
  if (!value) return 90;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 7 || parsed > 365) return 90;
  return parsed;
}
