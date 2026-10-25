import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { assetRecord, imageAssetDetails } from "@xhs-agentic/ai-gateway";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import type {
  BulkCreateTextMaterialsDto,
  CreateGeoEntityDto,
  CreateGeoTopicDto,
  CreateMaterialDto,
  CreateSensitiveRuleDto,
  DisableContentDto,
  ImportSensitiveRulesCsvDto,
  PublishGeoEntityVersionDto,
  PublishGeoTopicVersionDto,
  PublishMaterialVersionDto,
  PublishSensitiveRuleVersionDto,
} from "./content.dto";
import { materialFailureResponse, safeMaterialFailureResponse } from "./material-failure-response";
import { MaterialIngestionQueueService } from "./material-ingestion-queue.service";
import { medicalMaterialFacts } from "./material-medical-input";
import { recommendPromotionFocus, selectPromotionFocus } from "./promotion-focus";

type ContentScope = Readonly<{ tenantId: string; enterpriseId: string | null }>;

@Injectable()
export class ContentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantCapabilityService)
    private readonly capabilities: TenantCapabilityService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(MaterialIngestionQueueService)
    private readonly ingestionQueue: MaterialIngestionQueueService,
  ) {}

  async materialOptions(scope: ContentScope) {
    this.requireScope(scope);
    if (!scope.enterpriseId) throw new ForbiddenException("Enterprise material scope is required");
    const enterprise = await this.prisma.enterprise.findFirst({
      select: { industry: true },
      where: { id: scope.enterpriseId, tenantId: scope.tenantId, status: "ACTIVE" },
    });
    if (!enterprise) throw new NotFoundException("Active enterprise was not found");
    return { medical: false };
  }

  async listMaterials(scope: ContentScope) {
    this.requireScope(scope);
    const includeShared = await this.includeSharedContent(scope);
    const materials = await this.prisma.material.findMany({
      include: {
        _count: { select: { chunks: true } },
        artifacts: {
          orderBy: { createdAt: "desc" },
          select: {
            byteSize: true,
            checksum: true,
            createdAt: true,
            id: true,
            kind: true,
            mimeType: true,
            originalFileName: true,
            sourceUrl: true,
            status: true,
            verifiedAt: true,
            metadata: true,
          },
        },
        ingestionJobs: {
          orderBy: { queueVersion: "desc" },
          select: {
            attemptCount: true,
            maxAttempts: true,
            createdAt: true,
            errorCode: true,
            finishedAt: true,
            id: true,
            queueVersion: true,
            status: true,
          },
          take: 1,
        },
      },
      orderBy: [{ updatedAt: "desc" }, { version: "desc" }],
      where: visibleContentWhere(scope, includeShared),
    });
    return materials.map((material) => ({
      ...safeMaterialFailureResponse(material),
      ingestionJobs: material.ingestionJobs.map((job) => ({
        ...job,
        ...materialFailureResponse(job.errorCode),
      })),
      artifacts: material.artifacts.map(({ metadata, ...artifact }) => ({
        ...artifact,
        ...imageAssetDetails(metadata),
      })),
    }));
  }

  async createMaterial(scope: ContentScope, input: CreateMaterialDto) {
    const principal = this.requireScope(scope);
    if (input.type !== "TEXT") {
      throw new ConflictException(
        "Document, link and image-reference materials must use the restricted ingestion endpoints",
      );
    }
    validateRange(input.validFrom, input.expiresAt, "Material");
    const result = await this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const material = await transaction.material.create({
        data: materialCreateData(scope, input, principal.userId),
      });
      const job = await createIngestionJob(transaction, material);
      await auditContent(transaction, scope, principal.userId, {
        action: "material.create",
        resourceId: material.id,
        resourceType: "Material",
        stateAfter: contentVersionState(material),
      });
      return { job, material };
    });
    await this.enqueueBestEffort(result.job);
    return result.material;
  }

  async publishMaterialVersion(
    scope: ContentScope,
    materialId: string,
    input: PublishMaterialVersionDto,
  ) {
    const principal = this.requireScope(scope);
    if (input.type !== "TEXT") {
      throw new ConflictException(
        "Document, link and image-reference versions must use the restricted ingestion endpoints",
      );
    }
    validateRange(input.validFrom, input.expiresAt, "Material");
    const result = await this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedMaterial(transaction, scope, materialId);
      const nextVersion = await nextMaterialVersion(transaction, source);
      const next = await transaction.material.create({
        data: {
          ...materialCreateData(scope, input, principal.userId, source.structuredFacts),
          changeNote: input.changeNote,
          seriesId: source.seriesId,
          supersedesId: source.id,
          version: nextVersion,
        },
      });
      const job = await createIngestionJob(transaction, next);
      await auditContent(transaction, scope, principal.userId, {
        action: "material.version.publish",
        reason: input.changeNote,
        resourceId: next.id,
        resourceType: "Material",
        stateAfter: contentVersionState(next),
        stateBefore: contentVersionState(source),
      });
      return { job, material: next };
    });
    await this.enqueueBestEffort(result.job);
    return result.material;
  }

  async disableMaterial(scope: ContentScope, materialId: string, input: DisableContentDto) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedMaterial(transaction, scope, materialId);
      if (source.status === "DISABLED") return safeMaterialFailureResponse(source);
      await nextMaterialVersion(transaction, source);
      const disabled = await transaction.material.update({
        data: { status: "DISABLED" },
        where: { id: source.id },
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "material.disable",
        reason: input.reason,
        resourceId: source.id,
        resourceType: "Material",
        stateAfter: contentVersionState(disabled),
        stateBefore: contentVersionState(source),
      });
      return safeMaterialFailureResponse(disabled);
    });
  }

  async bulkCreateTextMaterials(scope: ContentScope, input: BulkCreateTextMaterialsDto) {
    const principal = this.requireScope(scope);
    const seenKeys = new Set<string>();
    const prepared = input.rows.map((row, index) => {
      const rowKey = row.rowKey.trim();
      if (seenKeys.has(rowKey)) {
        return { error: "Duplicate rowKey in request", index, row, rowKey } as const;
      }
      seenKeys.add(rowKey);
      try {
        medicalMaterialFacts(
          { ...row, authorizationConfirmed: input.authorizationConfirmed },
          "TEXT",
        );
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Invalid medical material classification",
          index,
          row,
          rowKey,
        } as const;
      }
      return {
        checksum: sha256(row.content.trim()),
        index,
        row,
        rowKey,
      } as const;
    });
    const checksums = prepared
      .map((row) => ("checksum" in row ? row.checksum : undefined))
      .filter((checksum): checksum is string => Boolean(checksum));
    const existing = await this.prisma.material.findMany({
      select: { contentChecksum: true, id: true, title: true },
      where: {
        contentChecksum: { in: checksums },
        enterpriseId: scope.enterpriseId,
        tenantId: scope.tenantId,
      },
    });
    const existingByChecksum = new Map(
      existing.map((material) => [material.contentChecksum, material]),
    );
    const report = prepared.map((item) => {
      if ("error" in item) {
        return { message: item.error, row: item.index + 1, rowKey: item.rowKey, status: "ERROR" };
      }
      const duplicate = existingByChecksum.get(item.checksum);
      if (duplicate) {
        return {
          materialId: duplicate.id,
          message: `Exact content already exists as ${duplicate.title}`,
          row: item.index + 1,
          rowKey: item.rowKey,
          status: "REUSED",
        };
      }
      return {
        checksum: item.checksum,
        row: item.index + 1,
        rowKey: item.rowKey,
        status: input.dryRun ? "WOULD_CREATE" : "CREATE",
      };
    });
    if (input.dryRun) return bulkReport(report, true);
    const created = await this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const createdRows: Array<{
        job: Awaited<ReturnType<typeof createIngestionJob>>;
        materialId: string;
        rowKey: string;
      }> = [];
      for (const [index, item] of prepared.entries()) {
        if ("error" in item || existingByChecksum.has(item.checksum)) continue;
        const material = await transaction.material.create({
          data: materialCreateData(
            scope,
            {
              authorizationConfirmed: input.authorizationConfirmed,
              content: item.row.content,
              medicalMaterial: item.row.medicalMaterial,
              structuredFacts: item.row.structuredFacts,
              tags: item.row.tags,
              title: item.row.title,
              type: "TEXT",
            },
            principal.userId,
          ),
        });
        const job = await createIngestionJob(transaction, material);
        await auditContent(transaction, scope, principal.userId, {
          action: "material.bulk.create",
          resourceId: material.id,
          resourceType: "Material",
          stateAfter: { row: index + 1, rowKey: item.rowKey },
        });
        createdRows.push({ job, materialId: material.id, rowKey: item.rowKey });
      }
      await auditContent(transaction, scope, principal.userId, {
        action: "material.bulk.complete",
        resourceId: randomUUID(),
        resourceType: "MaterialBulkImport",
        stateAfter: {
          created: createdRows.length,
          requested: input.rows.length,
          reused: report.filter(({ status }) => status === "REUSED").length,
        },
      });
      return createdRows;
    });
    await Promise.all(created.map(({ job }) => this.enqueueBestEffort(job)));
    const createdByKey = new Map(created.map((row) => [row.rowKey, row.materialId]));
    return bulkReport(
      report.map((row) =>
        row.status === "CREATE"
          ? { ...row, materialId: createdByKey.get(row.rowKey), status: "CREATED" }
          : row,
      ),
      false,
    );
  }

  async importSensitiveRulesCsv(scope: ContentScope, input: ImportSensitiveRulesCsvDto) {
    const principal = this.requireScope(scope);
    const parsed = parseSensitiveRulesCsv(input.csv);
    const keys = parsed.rows.flatMap((row) =>
      row.value ? [sensitiveRuleKey(row.value.term)] : [],
    );
    const existing = await this.prisma.sensitiveRule.findMany({
      orderBy: { version: "desc" },
      where: { key: { in: keys }, scopeKey: contentScopeKey(scope), tenantId: scope.tenantId },
    });
    const existingByKey = new Map(existing.map((rule) => [rule.key, rule]));
    const report = parsed.rows.map((row) => {
      if (!row.value) return { message: row.error, row: row.row, status: "ERROR" };
      const key = sensitiveRuleKey(row.value.term);
      const current = existingByKey.get(key);
      if (current) {
        const same =
          current.severity === row.value.severity &&
          current.riskType === row.value.riskType &&
          (current.replacementSuggestion ?? "") === (row.value.replacementSuggestion ?? "");
        return {
          message: same
            ? "Exact rule already exists"
            : "Rule term conflicts with an existing series",
          row: row.row,
          ruleId: current.id,
          status: same ? "REUSED" : "CONFLICT",
          term: row.value.term,
        };
      }
      return {
        row: row.row,
        status: input.dryRun ? "WOULD_CREATE" : "CREATE",
        term: row.value.term,
      };
    });
    if (input.dryRun) return bulkReport(report, true);
    const created = await this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const rows: Array<{ row: number; ruleId: string }> = [];
      for (const parsedRow of parsed.rows) {
        if (!parsedRow.value) continue;
        const key = sensitiveRuleKey(parsedRow.value.term);
        if (existingByKey.has(key)) continue;
        const rule = await transaction.sensitiveRule.create({
          data: sensitiveRuleCreateData(scope, parsedRow.value, principal.userId, key),
        });
        await auditContent(transaction, scope, principal.userId, {
          action: "sensitive-rule.bulk.create",
          resourceId: rule.id,
          resourceType: "SensitiveRule",
          stateAfter: { row: parsedRow.row, term: rule.term },
        });
        rows.push({ row: parsedRow.row, ruleId: rule.id });
      }
      await auditContent(transaction, scope, principal.userId, {
        action: "sensitive-rule.bulk.complete",
        resourceId: randomUUID(),
        resourceType: "SensitiveRuleBulkImport",
        stateAfter: { created: rows.length, requested: parsed.rows.length },
      });
      return rows;
    });
    const createdByRow = new Map(created.map((row) => [row.row, row.ruleId]));
    return bulkReport(
      report.map((row) =>
        row.status === "CREATE"
          ? { ...row, ruleId: createdByRow.get(row.row), status: "CREATED" }
          : row,
      ),
      false,
    );
  }

  async listSensitiveRules(scope: ContentScope) {
    this.requireScope(scope);
    const includeShared = await this.includeSharedContent(scope);
    return this.prisma.sensitiveRule.findMany({
      orderBy: [{ severity: "asc" }, { updatedAt: "desc" }, { version: "desc" }],
      where: visibleContentWhere(scope, includeShared),
    });
  }

  async createSensitiveRule(scope: ContentScope, input: CreateSensitiveRuleDto) {
    const principal = this.requireScope(scope);
    validateRange(input.effectiveFrom, input.effectiveTo, "Sensitive rule");
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const key = sensitiveRuleKey(input.term);
      await requireNoActiveRuleConflict(transaction, scope, key);
      const rule = await transaction.sensitiveRule.create({
        data: sensitiveRuleCreateData(scope, input, principal.userId, key),
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "sensitive-rule.create",
        resourceId: rule.id,
        resourceType: "SensitiveRule",
        stateAfter: contentVersionState(rule),
      });
      return rule;
    });
  }

  async publishSensitiveRuleVersion(
    scope: ContentScope,
    ruleId: string,
    input: PublishSensitiveRuleVersionDto,
  ) {
    const principal = this.requireScope(scope);
    validateRange(input.effectiveFrom, input.effectiveTo, "Sensitive rule");
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedSensitiveRule(transaction, scope, ruleId);
      await requireLatestVersion(transaction.sensitiveRule, source);
      const key = sensitiveRuleKey(input.term);
      await requireNoActiveRuleConflict(transaction, scope, key, source.seriesId);
      await transaction.sensitiveRule.update({
        data: { status: "DISABLED" },
        where: { id: source.id },
      });
      const next = await transaction.sensitiveRule.create({
        data: {
          ...sensitiveRuleCreateData(scope, input, principal.userId, key),
          changeNote: input.changeNote,
          seriesId: source.seriesId,
          supersedesId: source.id,
          version: source.version + 1,
        },
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "sensitive-rule.version.publish",
        reason: input.changeNote,
        resourceId: next.id,
        resourceType: "SensitiveRule",
        stateAfter: contentVersionState(next),
        stateBefore: contentVersionState(source),
      });
      return next;
    });
  }

  async disableSensitiveRule(scope: ContentScope, ruleId: string, input: DisableContentDto) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedSensitiveRule(transaction, scope, ruleId);
      await requireLatestVersion(transaction.sensitiveRule, source);
      if (source.status === "DISABLED") return source;
      const disabled = await transaction.sensitiveRule.update({
        data: { status: "DISABLED" },
        where: { id: source.id },
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "sensitive-rule.disable",
        reason: input.reason,
        resourceId: source.id,
        resourceType: "SensitiveRule",
        stateAfter: contentVersionState(disabled),
        stateBefore: contentVersionState(source),
      });
      return disabled;
    });
  }

  async listGeoEntities(scope: ContentScope) {
    this.requireScope(scope);
    const includeShared = await this.includeSharedContent(scope);
    return this.prisma.geoEntity.findMany({
      include: { topics: { orderBy: [{ priority: "desc" }, { version: "desc" }] } },
      orderBy: [{ updatedAt: "desc" }, { version: "desc" }],
      where: visibleContentWhere(scope, includeShared),
    });
  }

  async createGeoEntity(scope: ContentScope, input: CreateGeoEntityDto) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      await this.capabilities.assertGeoSeriesCapacity(scope.tenantId, "ENTITY", 1, transaction);
      const key = geoEntityKey(input.type, input.name);
      await requireNoActiveGeoEntityConflict(transaction, scope, key);
      const entity = await transaction.geoEntity.create({
        data: geoEntityCreateData(scope, input, principal.userId, key),
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "geo-entity.create",
        resourceId: entity.id,
        resourceType: "GeoEntity",
        stateAfter: contentVersionState(entity),
      });
      return entity;
    });
  }

  async focusRecommendations(scope: ContentScope) {
    this.requireScope(scope);
    const now = new Date();
    const includeShared = await this.includeSharedContent(scope);
    const where = visibleContentWhere(scope, includeShared);
    const [materials, entities] = await Promise.all([
      this.prisma.material.findMany({
        where: {
          ...where,
          status: "ACTIVE",
          authorizationStatus: "AUTHORIZED",
          ingestionStatus: "READY",
          usabilityStatus: "USABLE",
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
        select: {
          id: true,
          title: true,
          enterpriseId: true,
          enterprise: { select: { industry: true } },
          analysis: true,
          structuredFacts: true,
          type: true,
          artifacts: {
            where: { status: { in: ["STORED", "VERIFIED"] } },
            select: { metadata: true },
          },
        },
        orderBy: [{ enterpriseId: "asc" }, { updatedAt: "desc" }],
      }),
      this.prisma.geoEntity.findMany({ where: { ...where, status: "ACTIVE" } }),
    ]);
    return recommendPromotionFocus(
      materials.flatMap((material) => {
        if (
          assetRecord(assetRecord(material.structuredFacts).medicalMaterial).purpose === "ARCHIVE"
        )
          return [];
        if (material.type !== "IMAGE_REFERENCE") return [material];
        return material.artifacts.flatMap(({ metadata }) => {
          const asset = imageAssetDetails(metadata);
          return asset.usabilityStatus === "USABLE" && asset.usage !== "LOGO"
            ? [{ ...material, analysis: asset.analysis as Prisma.JsonValue }]
            : [];
        });
      }),
      entities,
    );
  }

  async publishGeoEntityVersion(
    scope: ContentScope,
    entityId: string,
    input: PublishGeoEntityVersionDto,
  ) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedGeoEntity(transaction, scope, entityId);
      await requireLatestVersion(transaction.geoEntity, source);
      const key = geoEntityKey(input.type, input.name);
      await requireNoActiveGeoEntityConflict(transaction, scope, key, source.seriesId);
      await transaction.geoEntity.update({
        data: { status: "DISABLED" },
        where: { id: source.id },
      });
      const next = await transaction.geoEntity.create({
        data: {
          ...geoEntityCreateData(scope, input, principal.userId, key),
          changeNote: input.changeNote,
          seriesId: source.seriesId,
          supersedesId: source.id,
          version: source.version + 1,
        },
      });
      for (const topic of source.topics) {
        await transaction.geoTopic.update({
          data: { status: "DISABLED" },
          where: { id: topic.id },
        });
        await transaction.geoTopic.create({
          data: {
            changeNote: `随 GEO 实体发布 v${next.version}：${input.changeNote}`,
            createdBy: principal.userId,
            enterpriseId: scope.enterpriseId,
            entityId: next.id,
            intent: topic.intent,
            priority: topic.priority,
            question: topic.question,
            seriesId: topic.seriesId,
            supersedesId: topic.id,
            tenantId: scope.tenantId,
            version: topic.version + 1,
          },
        });
      }
      await auditContent(transaction, scope, principal.userId, {
        action: "geo-entity.version.publish",
        reason: input.changeNote,
        resourceId: next.id,
        resourceType: "GeoEntity",
        stateAfter: contentVersionState(next),
        stateBefore: contentVersionState(source),
      });
      return next;
    });
  }

  async disableGeoEntity(scope: ContentScope, entityId: string, input: DisableContentDto) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedGeoEntity(transaction, scope, entityId);
      await requireLatestVersion(transaction.geoEntity, source);
      if (source.status === "DISABLED") return source;
      const disabled = await transaction.geoEntity.update({
        data: { status: "DISABLED" },
        where: { id: source.id },
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "geo-entity.disable",
        reason: input.reason,
        resourceId: source.id,
        resourceType: "GeoEntity",
        stateAfter: contentVersionState(disabled),
        stateBefore: contentVersionState(source),
      });
      return disabled;
    });
  }

  async createGeoTopic(scope: ContentScope, input: CreateGeoTopicDto) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      await this.capabilities.assertGeoSeriesCapacity(scope.tenantId, "TOPIC", 1, transaction);
      const entity = await requireOwnedGeoEntity(transaction, scope, input.entityId);
      if (entity.status !== "ACTIVE") {
        throw new ConflictException("Cannot add a topic to a disabled GEO entity");
      }
      const topic = await transaction.geoTopic.create({
        data: geoTopicCreateData(scope, input, principal.userId),
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "geo-topic.create",
        resourceId: topic.id,
        resourceType: "GeoTopic",
        stateAfter: contentVersionState(topic),
      });
      return topic;
    });
  }

  async publishGeoTopicVersion(
    scope: ContentScope,
    topicId: string,
    input: PublishGeoTopicVersionDto,
  ) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedGeoTopic(transaction, scope, topicId);
      await requireLatestVersion(transaction.geoTopic, source);
      if (input.entityId !== source.entityId) {
        throw new ConflictException("A GEO topic version cannot move to another entity");
      }
      const entity = await requireOwnedGeoEntity(transaction, scope, input.entityId);
      if (entity.status !== "ACTIVE") {
        throw new ConflictException("Cannot publish into a disabled GEO entity");
      }
      await transaction.geoTopic.update({ data: { status: "DISABLED" }, where: { id: source.id } });
      const next = await transaction.geoTopic.create({
        data: {
          ...geoTopicCreateData(scope, input, principal.userId),
          changeNote: input.changeNote,
          seriesId: source.seriesId,
          supersedesId: source.id,
          version: source.version + 1,
        },
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "geo-topic.version.publish",
        reason: input.changeNote,
        resourceId: next.id,
        resourceType: "GeoTopic",
        stateAfter: contentVersionState(next),
        stateBefore: contentVersionState(source),
      });
      return next;
    });
  }

  async disableGeoTopic(scope: ContentScope, topicId: string, input: DisableContentDto) {
    const principal = this.requireScope(scope);
    return this.contentTransaction(async (transaction) => {
      await this.requireWritableScope(transaction, scope);
      const source = await requireOwnedGeoTopic(transaction, scope, topicId);
      await requireLatestVersion(transaction.geoTopic, source);
      if (source.status === "DISABLED") return source;
      const disabled = await transaction.geoTopic.update({
        data: { status: "DISABLED" },
        where: { id: source.id },
      });
      await auditContent(transaction, scope, principal.userId, {
        action: "geo-topic.disable",
        reason: input.reason,
        resourceId: source.id,
        resourceType: "GeoTopic",
        stateAfter: contentVersionState(disabled),
        stateBefore: contentVersionState(source),
      });
      return disabled;
    });
  }

  async generationContext(
    tenantId: string,
    enterpriseId: string,
    now: Date,
    materialIds?: readonly string[],
    focusEntityIds: readonly string[] = [],
  ) {
    const capability = await this.capabilities.current(tenantId, this.prisma);
    const includeShared = capability.groupSharedMaterialsEnabled;
    const where = effectiveContentWhere(tenantId, enterpriseId, includeShared);
    const [materials, sensitiveRules, geoEntities, enterprise] = await Promise.all([
      this.prisma.material.findMany({
        orderBy: [{ updatedAt: "desc" }, { version: "desc" }],
        where: {
          ...where,
          authorizationStatus: "AUTHORIZED",
          id: materialIds ? { in: [...materialIds] } : undefined,
          ingestionStatus: "READY",
          usabilityStatus: "USABLE",
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
      }),
      this.prisma.sensitiveRule.findMany({
        orderBy: [{ version: "asc" }, { updatedAt: "asc" }],
        where: {
          ...where,
          AND: [
            { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
          ],
        },
      }),
      this.prisma.geoEntity.findMany({
        include: {
          topics: {
            orderBy: [{ priority: "desc" }, { version: "desc" }],
            where: { status: "ACTIVE" },
          },
        },
        orderBy: [{ version: "asc" }, { updatedAt: "asc" }],
        where,
      }),
      this.prisma.enterprise.findFirst({
        select: { industry: true },
        where: { id: enterpriseId, tenantId, status: "ACTIVE" },
      }),
    ]);
    if (!enterprise) throw new NotFoundException("Active enterprise was not found");
    const eligibleMaterials = materials.filter(
      (material) =>
        assetRecord(assetRecord(material.structuredFacts).medicalMaterial).purpose !== "ARCHIVE",
    );
    return {
      geoEntities: selectPromotionFocus(
        resolveEnterpriseOverrides(geoEntities, enterpriseId),
        "",
        focusEntityIds,
      ),
      materials: materialIds
        ? orderByRequestedIds(eligibleMaterials, materialIds)
        : orderEnterpriseFirst(eligibleMaterials, enterpriseId),
      sensitiveRules: resolveEnterpriseOverrides(sensitiveRules, enterpriseId),
    };
  }

  async effectiveGeoEntities(tenantId: string, enterpriseId: string) {
    const capability = await this.capabilities.current(tenantId, this.prisma);
    const includeShared = capability.groupSharedMaterialsEnabled;
    const rows = await this.prisma.geoEntity.findMany({
      include: {
        topics: {
          orderBy: [{ priority: "desc" }, { version: "desc" }],
          where: { status: "ACTIVE" },
        },
      },
      orderBy: [{ version: "asc" }, { updatedAt: "asc" }],
      where: effectiveContentWhere(tenantId, enterpriseId, includeShared),
    });
    return resolveEnterpriseOverrides(rows, enterpriseId);
  }

  private async includeSharedContent(scope: ContentScope): Promise<boolean> {
    if (scope.enterpriseId === null) return true;
    const capability = await this.capabilities.current(scope.tenantId);
    return capability.groupSharedMaterialsEnabled;
  }

  private async requireWritableScope(
    transaction: Prisma.TransactionClient,
    scope: ContentScope,
  ): Promise<void> {
    await requireScopeTarget(transaction, scope);
    if (scope.enterpriseId !== null) return;
    const capability = await this.capabilities.current(scope.tenantId, transaction);
    this.capabilities.requireGroupSharedMaterials(capability);
  }

  private async contentTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("A content version with the same identity already exists");
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new ConflictException("Content changed concurrently; reload and retry the operation");
      }
      throw error;
    }
  }

  private async enqueueBestEffort(job: {
    id: string;
    materialId: string;
    queueVersion: number;
    tenantId: string;
  }): Promise<void> {
    try {
      await this.ingestionQueue.enqueue({
        ingestionJobId: job.id,
        materialId: job.materialId,
        queueVersion: job.queueVersion,
        tenantId: job.tenantId,
      });
    } catch {
      // Durable PENDING jobs are dispatched by the worker reconciler after Redis recovers.
    }
  }

  private requireScope(scope: ContentScope) {
    const principal = this.accessContext.requireSaasAdmin();
    const valid =
      (scope.enterpriseId === null &&
        principal.scope.type === "TENANT" &&
        principal.scope.tenantId === scope.tenantId) ||
      (scope.enterpriseId !== null &&
        principal.scope.type === "ENTERPRISE" &&
        principal.scope.tenantId === scope.tenantId &&
        principal.scope.enterpriseId === scope.enterpriseId);
    if (!valid) {
      throw new ForbiddenException("Active request scope does not match the content scope");
    }
    return principal;
  }
}

function orderByRequestedIds<T extends { id: string }>(values: T[], ids: readonly string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...values].sort(
    (left, right) => (rank.get(left.id) ?? 1e9) - (rank.get(right.id) ?? 1e9),
  );
}

function materialCreateData(
  scope: ContentScope,
  input: CreateMaterialDto,
  createdBy: string,
  previousFacts?: unknown,
): Prisma.MaterialUncheckedCreateInput {
  const structuredFacts = medicalMaterialFacts(input, input.type, previousFacts);
  return {
    authorizationStatus: "AUTHORIZED",
    content: input.content,
    sourceText: input.content,
    supplement:
      [
        input.title ? `用户提供的标题：${input.title}` : undefined,
        input.tags?.length ? `用户提供的关键词：${input.tags.join("、")}` : undefined,
        input.structuredFacts
          ? `用户提供的事实：${JSON.stringify(input.structuredFacts)}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    contentChecksum: sha256(input.content),
    createdBy,
    enterpriseId: scope.enterpriseId,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    id: randomUUID(),
    ingestionStatus: "PENDING",
    usabilityStatus: "PENDING",
    scopeKey: materialScopeKey(scope),
    sourceUrl: input.sourceUrl,
    structuredFacts: structuredFacts as Prisma.InputJsonValue | undefined,
    tags: normalizeTags(input.tags ?? []),
    tenantId: scope.tenantId,
    title: input.title ?? "正在整理文本资料",
    type: input.type,
    validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
  };
}

function createIngestionJob(
  transaction: Prisma.TransactionClient,
  material: Readonly<{
    enterpriseId: string | null;
    id: string;
    scopeKey: string;
    tenantId: string;
  }>,
) {
  return transaction.materialIngestionJob.create({
    data: {
      enterpriseId: material.enterpriseId,
      materialId: material.id,
      parserVersion: "material-ai-v2",
      scopeKey: material.scopeKey,
      tenantId: material.tenantId,
    },
  });
}

function materialScopeKey(scope: ContentScope): string {
  return scope.enterpriseId ?? "__tenant__";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sensitiveRuleCreateData(
  scope: ContentScope,
  input: CreateSensitiveRuleDto,
  createdBy: string,
  key: string,
): Prisma.SensitiveRuleUncheckedCreateInput {
  return {
    createdBy,
    effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : undefined,
    enterpriseId: scope.enterpriseId,
    id: randomUUID(),
    key,
    replacementSuggestion: input.replacementSuggestion,
    riskType: input.riskType,
    scopeKey: contentScopeKey(scope),
    severity: input.severity,
    tenantId: scope.tenantId,
    term: input.term,
  };
}

function geoEntityCreateData(
  scope: ContentScope,
  input: CreateGeoEntityDto,
  createdBy: string,
  key: string,
): Prisma.GeoEntityUncheckedCreateInput {
  return {
    aliases: normalizeTags(input.aliases ?? []),
    createdBy,
    enterpriseId: scope.enterpriseId,
    facts: input.facts as Prisma.InputJsonValue | undefined,
    id: randomUUID(),
    key,
    name: input.name,
    scopeKey: contentScopeKey(scope),
    tenantId: scope.tenantId,
    type: input.type,
  };
}

function geoTopicCreateData(
  scope: ContentScope,
  input: CreateGeoTopicDto,
  createdBy: string,
): Prisma.GeoTopicUncheckedCreateInput {
  return {
    createdBy,
    enterpriseId: scope.enterpriseId,
    entityId: input.entityId,
    id: randomUUID(),
    intent: input.intent,
    priority: input.priority,
    question: input.question,
    tenantId: scope.tenantId,
  };
}

function visibleContentWhere(scope: ContentScope, includeShared: boolean) {
  return {
    OR:
      scope.enterpriseId && includeShared
        ? [{ enterpriseId: null }, { enterpriseId: scope.enterpriseId }]
        : [{ enterpriseId: scope.enterpriseId }],
    tenantId: scope.tenantId,
  };
}

function effectiveContentWhere(tenantId: string, enterpriseId: string, includeShared: boolean) {
  return {
    OR: includeShared ? [{ enterpriseId: null }, { enterpriseId }] : [{ enterpriseId }],
    status: "ACTIVE" as const,
    tenantId,
  };
}

function exactScopeWhere(scope: ContentScope) {
  return { enterpriseId: scope.enterpriseId, tenantId: scope.tenantId };
}

function contentScopeKey(scope: ContentScope): string {
  return scope.enterpriseId ?? scope.tenantId;
}

function sensitiveRuleKey(term: string): string {
  return normalizeBusinessKey(term);
}

function geoEntityKey(type: string, name: string): string {
  return `${type.toLowerCase()}:${normalizeBusinessKey(name)}`;
}

function normalizeBusinessKey(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ");
}

async function requireNoActiveRuleConflict(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
  key: string,
  excludingSeriesId?: string,
): Promise<void> {
  const existing = await transaction.sensitiveRule.findFirst({
    select: { id: true },
    where: {
      key,
      scopeKey: contentScopeKey(scope),
      seriesId: excludingSeriesId ? { not: excludingSeriesId } : undefined,
      tenantId: scope.tenantId,
    },
  });
  if (existing) {
    throw new ConflictException(
      "A sensitive rule series with this term already exists in the scope; publish a new version instead",
    );
  }
}

async function requireNoActiveGeoEntityConflict(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
  key: string,
  excludingSeriesId?: string,
): Promise<void> {
  const existing = await transaction.geoEntity.findFirst({
    select: { id: true },
    where: {
      key,
      scopeKey: contentScopeKey(scope),
      seriesId: excludingSeriesId ? { not: excludingSeriesId } : undefined,
      tenantId: scope.tenantId,
    },
  });
  if (existing) {
    throw new ConflictException(
      "A GEO entity series with this identity already exists in the scope; publish a new version instead",
    );
  }
}

async function requireOwnedMaterial(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
  id: string,
) {
  const material = await transaction.material.findFirst({
    where: { id, ...exactScopeWhere(scope) },
  });
  if (!material) throw new NotFoundException("Material was not found in the writable scope");
  return material;
}

async function requireOwnedSensitiveRule(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
  id: string,
) {
  const rule = await transaction.sensitiveRule.findFirst({
    where: { id, ...exactScopeWhere(scope) },
  });
  if (!rule) throw new NotFoundException("Sensitive rule was not found in the writable scope");
  return rule;
}

async function requireOwnedGeoEntity(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
  id: string,
) {
  const entity = await transaction.geoEntity.findFirst({
    include: { topics: { orderBy: { version: "desc" }, where: { status: "ACTIVE" } } },
    where: { id, ...exactScopeWhere(scope) },
  });
  if (!entity) throw new NotFoundException("GEO entity was not found in the writable scope");
  return entity;
}

async function requireOwnedGeoTopic(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
  id: string,
) {
  const topic = await transaction.geoTopic.findFirst({ where: { id, ...exactScopeWhere(scope) } });
  if (!topic) throw new NotFoundException("GEO topic was not found in the writable scope");
  return topic;
}

async function requireLatestVersion<
  T extends Readonly<{ id: string; seriesId: string; version: number }>,
>(delegate: { findFirst(args: unknown): Promise<unknown> }, source: T): Promise<void> {
  const latest = (await delegate.findFirst({
    orderBy: { version: "desc" },
    select: { id: true },
    where: { seriesId: source.seriesId },
  })) as { id: string } | null;
  if (!latest || latest.id !== source.id) {
    throw new ConflictException("Only the latest content version can be changed");
  }
}

async function requireScopeTarget(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
): Promise<void> {
  if (scope.enterpriseId === null) {
    const tenant = await transaction.tenant.findFirst({
      select: { id: true },
      where: { id: scope.tenantId, status: "ACTIVE" },
    });
    if (!tenant) throw new NotFoundException("Active tenant was not found");
    return;
  }
  const enterprise = await transaction.enterprise.findFirst({
    select: { id: true },
    where: { id: scope.enterpriseId, status: "ACTIVE", tenantId: scope.tenantId },
  });
  if (!enterprise) throw new NotFoundException("Active enterprise was not found");
}

async function auditContent(
  transaction: Prisma.TransactionClient,
  scope: ContentScope,
  actorUserId: string,
  input: Readonly<{
    action: string;
    reason?: string;
    resourceId: string;
    resourceType: string;
    stateAfter?: Prisma.InputJsonValue;
    stateBefore?: Prisma.InputJsonValue;
  }>,
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      action: input.action,
      actorType: "USER",
      actorUserId,
      enterpriseId: scope.enterpriseId,
      reason: input.reason,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      stateAfter: input.stateAfter,
      stateBefore: input.stateBefore,
      tenantId: scope.tenantId,
    },
  });
}

function contentVersionState(value: {
  id: string;
  seriesId: string;
  status: string;
  version: number;
}): Prisma.InputJsonValue {
  return { id: value.id, seriesId: value.seriesId, status: value.status, version: value.version };
}

function bulkReport<T extends Readonly<{ status: string }>>(rows: T[], dryRun: boolean) {
  const counts = rows.reduce<Record<string, number>>((result, row) => {
    result[row.status] = (result[row.status] ?? 0) + 1;
    return result;
  }, {});
  return { counts, dryRun, rows };
}

function parseSensitiveRulesCsv(value: string): {
  rows: Array<{
    error?: string;
    row: number;
    value?: {
      effectiveFrom?: string;
      effectiveTo?: string;
      replacementSuggestion?: string;
      riskType: string;
      severity: "BLOCK" | "NOTICE" | "WARNING";
      term: string;
    };
  }>;
} {
  const records = parseCsv(value);
  if (records.length < 2) {
    throw new ConflictException("Sensitive rule CSV must contain a header and at least one row");
  }
  if (records.length > 501)
    throw new ConflictException("Sensitive rule CSV supports at most 500 rows");
  const headerRow = records[0];
  if (!headerRow) throw new ConflictException("Sensitive rule CSV header is missing");
  const headers = headerRow.map((header) => header.trim());
  const required = ["term", "severity", "riskType"];
  for (const name of required) {
    if (!headers.includes(name))
      throw new ConflictException(`Sensitive rule CSV is missing ${name}`);
  }
  return {
    rows: records.slice(1).map((record, index) => {
      const values = Object.fromEntries(
        headers.map((header, column) => [header, record[column]?.trim() ?? ""]),
      );
      const term = values.term ?? "";
      const severity = (values.severity ?? "").toUpperCase();
      const riskType = values.riskType ?? "";
      if (!term || !riskType || !new Set(["BLOCK", "WARNING", "NOTICE"]).has(severity)) {
        return {
          error: "term, severity and riskType are required and severity is invalid",
          row: index + 2,
        };
      }
      const effectiveFrom = validOptionalDate(values.effectiveFrom);
      const effectiveTo = validOptionalDate(values.effectiveTo);
      if (effectiveFrom === null || effectiveTo === null) {
        return { error: "effectiveFrom or effectiveTo is not a valid date", row: index + 2 };
      }
      if (effectiveFrom && effectiveTo && new Date(effectiveTo) <= new Date(effectiveFrom)) {
        return { error: "effectiveTo must be after effectiveFrom", row: index + 2 };
      }
      return {
        row: index + 2,
        value: {
          effectiveFrom,
          effectiveTo,
          replacementSuggestion: values.replacementSuggestion || undefined,
          riskType,
          severity: severity as "BLOCK" | "NOTICE" | "WARNING",
          term,
        },
      };
    }),
  };
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new ConflictException("Sensitive rule CSV contains an unclosed quote");
  row.push(field.replace(/\r$/u, ""));
  if (row.some((item) => item.trim())) rows.push(row);
  return rows;
}

function validOptionalDate(value: string | undefined): string | undefined | null {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function validateRange(start: string | undefined, end: string | undefined, label: string): void {
  if (start && end && new Date(end) <= new Date(start)) {
    throw new ConflictException(`${label} end time must be after its start time`);
  }
}

function resolveEnterpriseOverrides<
  T extends Readonly<{ enterpriseId: string | null; key: string; version: number }>,
>(rows: T[], enterpriseId: string): T[] {
  const effective = new Map<string, T>();
  for (const row of rows.filter(({ enterpriseId: owner }) => owner === null)) {
    const current = effective.get(row.key);
    if (!current || row.version >= current.version) effective.set(row.key, row);
  }
  for (const row of rows.filter(({ enterpriseId: owner }) => owner === enterpriseId)) {
    const current = effective.get(row.key);
    if (!current || current.enterpriseId === null || row.version >= current.version) {
      effective.set(row.key, row);
    }
  }
  return [...effective.values()];
}

function orderEnterpriseFirst<T extends Readonly<{ enterpriseId: string | null }>>(
  rows: T[],
  enterpriseId: string,
): T[] {
  return [...rows].sort((left, right) => {
    const leftPriority = left.enterpriseId === enterpriseId ? 0 : 1;
    const rightPriority = right.enterpriseId === enterpriseId ? 0 : 1;
    return leftPriority - rightPriority;
  });
}

import { nextMaterialVersion } from "./material-version-policy";
