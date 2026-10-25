import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { imageAssetDetails, readMedicalMaterial } from "@xhs-agentic/ai-gateway";
import { type MaterialArtifact, type MaterialIngestionJob, Prisma } from "@xhs-agentic/database";
import sharp from "sharp";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { StorageQuotaService } from "../resource-policy/storage-quota.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import type {
  CompleteMaterialUploadDto,
  CreateMaterialLinkDto,
  CreateMaterialRevisionDto,
  CreateMaterialUploadIntentDto,
  RetryMaterialIngestionDto,
  SupplementMaterialDto,
} from "./content.dto";
import { materialFailureResponse } from "./material-failure-response";
import { MaterialIngestionQueueService } from "./material-ingestion-queue.service";
import { canRetryQuarantinedMaterial } from "./material-ingestion-retry-policy";
import { medicalMaterialFacts } from "./material-medical-input";
import { MaterialStorageService } from "./material-storage.service";

export type MaterialContentScope = Readonly<{ tenantId: string; enterpriseId: string | null }>;

const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
const PARSER_VERSION = "material-ai-v2";
export const BUNDLE_PARSER_VERSION = "material-ai-bundle-v1";
const MAX_REVISION_ARTIFACTS = 20;
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

@Injectable()
export class MaterialIngestionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService)
    private readonly capabilities: TenantCapabilityService,
    @Inject(StorageQuotaService) private readonly storageQuota: StorageQuotaService,
    @Inject(MaterialIngestionQueueService)
    private readonly queue: MaterialIngestionQueueService,
    @Inject(MaterialStorageService) private readonly storage: MaterialStorageService,
  ) {}

  async createUploadIntent(scope: MaterialContentScope, input: CreateMaterialUploadIntentDto) {
    const principal = this.requireScope(scope);
    validateUploadInput(input);
    await this.storageQuota.releaseExpired(scope.tenantId);
    const duplicate = input.supersedesId
      ? null
      : await this.prisma.materialArtifact.findFirst({
          include: { material: { select: { id: true, title: true } } },
          where: {
            checksum: input.checksum,
            status: { in: ["STORED", "VERIFIED"] },
            material: { status: "ACTIVE" },
            tenantId: scope.tenantId,
            enterpriseId: scope.enterpriseId,
          },
        });
    if (duplicate) {
      throw new ConflictException({
        code: "MATERIAL_ARTIFACT_DUPLICATE",
        existingMaterialId: duplicate.material.id,
        existingMaterialTitle: duplicate.material.title,
        message: "This file already exists in the tenant; reuse the existing material",
      });
    }
    const materialId = randomUUID();
    const artifactId = randomUUID();
    const objectKey = this.storage.objectKey({
      artifactId,
      fileName: input.fileName,
      materialId,
      tenantId: scope.tenantId,
    });
    const prepared = await this.prisma.$transaction(
      async (transaction) => {
        await this.requireWritableScope(transaction, scope);
        const version = await materialVersionData(
          transaction,
          scope,
          input.type,
          input.supersedesId,
          input.changeNote,
        );
        const data = materialData(scope, input, principal.userId, materialId, "", version);
        await transaction.material.create({
          data,
        });
        await transaction.materialArtifact.create({
          data: {
            byteSize: input.byteSize,
            checksum: input.checksum,
            enterpriseId: scope.enterpriseId,
            id: artifactId,
            kind: input.type === "IMAGE_REFERENCE" ? "IMAGE_SOURCE" : "UPLOAD",
            materialId,
            mimeType: input.mimeType,
            objectKey,
            originalFileName: input.fileName,
            metadata: {
              description: "",
              usage: input.usage ?? "REFERENCE",
              ...medicalArtifactMetadata(data.structuredFacts),
            },
            scopeKey: materialScopeKey(scope),
            status: "PENDING_UPLOAD",
            tenantId: scope.tenantId,
          },
        });
        const reservation = await this.storageQuota.reserveInTransaction(transaction, {
          byteSize: input.byteSize,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          reservationKey: `material-upload:${artifactId}`,
          resourceId: artifactId,
          resourceType: "MATERIAL_UPLOAD",
          storageKey: objectKey,
          tenantId: scope.tenantId,
        });
        await audit(
          transaction,
          scope,
          principal.userId,
          "material.upload.intent.create",
          materialId,
          {
            artifactId,
            byteSize: input.byteSize,
            changeNote: input.changeNote,
            mimeType: input.mimeType,
            supersedesId: input.supersedesId,
          },
        );
        return { reservationId: reservation.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    let uploadUrl: string;
    try {
      uploadUrl = await this.storage.signedUpload({
        byteSize: input.byteSize,
        key: objectKey,
        mimeType: input.mimeType,
      });
    } catch (error) {
      await this.prisma
        .$transaction(async (transaction) => {
          await transaction.materialArtifact.deleteMany({ where: { id: artifactId } });
          await transaction.material.deleteMany({ where: { id: materialId } });
          await this.storageQuota.releaseInTransaction(
            transaction,
            prepared.reservationId,
            scope.tenantId,
            "Release material upload capacity because signing failed",
          );
        })
        .catch(() => undefined);
      throw error;
    }
    return {
      artifactId,
      expiresInSeconds: 900,
      headers: { "Content-Type": input.mimeType },
      materialId,
      uploadUrl,
    };
  }

  async createRevision(
    scope: MaterialContentScope,
    sourceId: string,
    input: CreateMaterialRevisionDto,
  ) {
    const principal = this.requireScope(scope);
    if (!Array.isArray(input.files) || input.files.length > MAX_REVISION_ARTIFACTS) {
      throw new ConflictException("每份资料最多保留 20 个附件");
    }
    await this.storageQuota.releaseExpired(scope.tenantId);
    const result = await this.prisma.$transaction(
      async (transaction) => {
        await this.requireWritableScope(transaction, scope);
        const source = await transaction.material.findFirst({
          where: { id: sourceId, ...exactScope(scope) },
        });
        if (!source || !new Set(["DOCUMENT", "IMAGE_REFERENCE"]).has(source.type)) {
          throw new NotFoundException("可更新的文件资料不存在");
        }
        const structuredFacts = medicalMaterialFacts(input, source.type, source.structuredFacts);
        if (source.status !== "ACTIVE") throw new ConflictException("已停用资料不能追加附件");
        const version = await materialVersionData(
          transaction,
          scope,
          source.type as "DOCUMENT" | "IMAGE_REFERENCE",
          sourceId,
          "更新资料附件或说明",
        );
        const historical = await transaction.materialArtifact.findMany({
          include: { material: { select: { version: true } } },
          where: {
            ...exactScope(scope),
            material: { seriesId: source.seriesId },
            status: { in: ["STORED", "VERIFIED"] },
          },
        });
        historical.sort((left, right) => right.material.version - left.material.version);
        const removed = new Set(input.removeArtifactIds ?? []);
        const descriptions = new Map(
          (input.attachmentDescriptions ?? []).map((item) => [item.artifactId, item]),
        );
        for (const artifactId of [...removed, ...descriptions.keys()]) {
          if (
            !historical.some(
              (artifact) => artifact.id === artifactId && artifact.materialId === source.id,
            )
          ) {
            throw new ConflictException("只能修改当前版本中的附件");
          }
        }
        const requestedRestores = new Set(input.restoreArtifactIds ?? []);
        if (requestedRestores.size !== (input.restoreArtifactIds?.length ?? 0)) {
          throw new ConflictException("请勿重复选择历史附件");
        }
        for (const artifactId of requestedRestores) {
          if (!historical.some((artifact) => artifact.id === artifactId && artifact.objectKey)) {
            throw new ConflictException("选择的历史附件不在当前资料版本中");
          }
        }
        const retainedByKey = new Map<string, (typeof historical)[number]>();
        for (const artifact of historical) {
          if (
            artifact.objectKey &&
            !removed.has(artifact.id) &&
            (artifact.materialId === source.id || requestedRestores.has(artifact.id)) &&
            !retainedByKey.has(artifact.objectKey)
          ) {
            retainedByKey.set(artifact.objectKey, artifact);
          }
        }
        const retained = [...retainedByKey.values()];
        if (
          (!retained.length && !input.files.length) ||
          retained.length + input.files.length > MAX_REVISION_ARTIFACTS
        ) {
          throw new ConflictException("资料需保留至少一个附件，且新旧附件总数不能超过 20 个");
        }
        if (
          !input.files.length &&
          !removed.size &&
          !descriptions.size &&
          !requestedRestores.size &&
          input.medicalMaterial === undefined &&
          input.structuredFacts === undefined &&
          (input.supplement ?? source.supplement ?? "") === (source.supplement ?? "")
        ) {
          throw new ConflictException("请修改资料说明或添加附件");
        }
        const seenChecksums = new Set(retained.map((artifact) => artifact.checksum));
        for (const file of input.files) {
          validateUploadInput({
            ...file,
            authorizationConfirmed: input.authorizationConfirmed,
            type: source.type as "DOCUMENT" | "IMAGE_REFERENCE",
          });
          if (seenChecksums.has(file.checksum)) {
            throw new ConflictException(`附件“${file.fileName}”已存在，请勿重复上传`);
          }
          seenChecksums.add(file.checksum);
        }
        const revision = await transaction.material.create({
          data: {
            authorizationStatus: source.authorizationStatus,
            changeNote: "更新资料附件或说明",
            content: source.sourceText ?? source.content,
            createdBy: principal.userId,
            enterpriseId: scope.enterpriseId,
            expiresAt: source.expiresAt,
            scopeKey: source.scopeKey,
            seriesId: source.seriesId,
            sourceText: source.sourceText ?? source.content,
            structuredFacts: structuredFacts as Prisma.InputJsonValue | undefined,
            supplement: input.supplement ?? source.supplement,
            supersedesId: source.id,
            tags: source.tags,
            tenantId: scope.tenantId,
            title: source.title,
            type: source.type,
            parserVersion: BUNDLE_PARSER_VERSION,
            ingestionStatus: "PENDING",
            usabilityStatus: "PENDING",
            validFrom: source.validFrom,
            version: version.version,
          },
        });
        for (const [ordinal, artifact] of retained.entries()) {
          await transaction.materialArtifact.create({
            data: {
              byteSize: artifact.byteSize,
              checksum: artifact.checksum,
              enterpriseId: scope.enterpriseId,
              kind: artifact.kind,
              materialId: revision.id,
              metadata: {
                ...(artifact.metadata &&
                typeof artifact.metadata === "object" &&
                !Array.isArray(artifact.metadata)
                  ? artifact.metadata
                  : {}),
                bundleOrdinal: ordinal,
                ...(descriptions.has(artifact.id)
                  ? {
                      description: descriptions.get(artifact.id)?.description ?? "",
                      usage:
                        descriptions.get(artifact.id)?.usage ??
                        imageAssetDetails(artifact.metadata).usage,
                    }
                  : {}),
                ...medicalArtifactMetadata(structuredFacts),
                // A new version must not expose stale availability while it is processed.
                analysis: {},
                usabilityStatus: "PENDING",
              },
              mimeType: artifact.mimeType,
              objectKey: artifact.objectKey,
              originalFileName: artifact.originalFileName,
              scopeKey: source.scopeKey,
              status: artifact.status,
              storedAt: artifact.storedAt,
              tenantId: scope.tenantId,
              verifiedAt: artifact.verifiedAt,
            },
          });
        }
        const pending = [];
        for (const file of input.files) {
          const artifactId = randomUUID();
          const key = this.storage.objectKey({
            artifactId,
            fileName: file.fileName,
            materialId: revision.id,
            tenantId: scope.tenantId,
          });
          await transaction.materialArtifact.create({
            data: {
              byteSize: file.byteSize,
              checksum: file.checksum,
              enterpriseId: scope.enterpriseId,
              id: artifactId,
              kind: source.type === "IMAGE_REFERENCE" ? "IMAGE_SOURCE" : "UPLOAD",
              materialId: revision.id,
              metadata: {
                bundleOrdinal: retained.length + pending.length,
                description: file.description ?? "",
                usage: file.usage ?? "REFERENCE",
                ...medicalArtifactMetadata(structuredFacts),
              },
              mimeType: file.mimeType,
              objectKey: key,
              originalFileName: file.fileName,
              scopeKey: source.scopeKey,
              status: "PENDING_UPLOAD",
              tenantId: scope.tenantId,
            },
          });
          const reservation = await this.storageQuota.reserveInTransaction(transaction, {
            byteSize: file.byteSize,
            expiresAt: new Date(Date.now() + 15 * 60_000),
            reservationKey: `material-upload:${artifactId}`,
            resourceId: artifactId,
            resourceType: "MATERIAL_UPLOAD",
            storageKey: key,
            tenantId: scope.tenantId,
          });
          pending.push({ artifactId, file, key, reservationId: reservation.id });
        }
        await audit(transaction, scope, principal.userId, "material.revision.create", revision.id, {
          sourceMaterialId: source.id,
          existingAttachmentCount: retained.length,
          newAttachmentCount: pending.length,
          restoredAttachmentCount: requestedRestores.size,
        });
        return { materialId: revision.id, pending };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    try {
      const intents = [];
      for (const item of result.pending) {
        intents.push({
          artifactId: item.artifactId,
          expiresInSeconds: 900,
          headers: { "Content-Type": item.file.mimeType },
          materialId: result.materialId,
          uploadUrl: await this.storage.signedUpload({
            byteSize: item.file.byteSize,
            key: item.key,
            mimeType: item.file.mimeType,
          }),
        });
      }
      return { intents, materialId: result.materialId };
    } catch (error) {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.materialArtifact.deleteMany({ where: { materialId: result.materialId } });
        await transaction.material.delete({ where: { id: result.materialId } });
        for (const item of result.pending) {
          await this.storageQuota.releaseInTransaction(
            transaction,
            item.reservationId,
            scope.tenantId,
            "Release material revision upload after signing failure",
          );
        }
      });
      throw error;
    }
  }

  async resumeRevision(
    scope: MaterialContentScope,
    materialId: string,
    input: CreateMaterialRevisionDto,
  ) {
    this.requireScope(scope);
    await this.storageQuota.releaseExpired(scope.tenantId);
    const material = await this.prisma.material.findFirst({
      where: { id: materialId, ...exactScope(scope), parserVersion: BUNDLE_PARSER_VERSION },
    });
    if (material?.status !== "ACTIVE") {
      throw new NotFoundException("待上传的资料版本不存在");
    }
    const structuredFacts = medicalMaterialFacts(input, material.type, material.structuredFacts);
    if (
      !isDeepStrictEqual(
        structuredFacts,
        medicalMaterialFacts(
          { authorizationConfirmed: input.authorizationConfirmed },
          material.type,
          material.structuredFacts,
        ),
      )
    )
      throw new ConflictException("续传时不能修改素材用途，请沿用该版本已确认的资料");
    if (await this.prisma.materialIngestionJob.findFirst({ where: { materialId } })) {
      throw new ConflictException("资料已进入 AI 处理队列");
    }
    const pending = await this.prisma.materialArtifact.findMany({
      where: { materialId, ...exactScope(scope), status: "PENDING_UPLOAD" },
    });
    if (!input.files || input.files.length !== pending.length) {
      throw new ConflictException("请重新选择全部待上传附件");
    }
    const intents: Array<{
      artifactId: string;
      expiresInSeconds: number;
      headers: Record<string, string>;
      materialId: string;
      uploadUrl: string;
    }> = [];
    for (const file of input.files) {
      const match = pending.find(
        (item) =>
          item.originalFileName === file.fileName &&
          item.checksum === file.checksum &&
          item.mimeType === file.mimeType &&
          item.byteSize === file.byteSize &&
          item.objectKey,
      );
      if (!match?.objectKey || intents.some((item) => item.artifactId === match.id)) {
        throw new ConflictException(`附件“${file.fileName}”与待上传文件不一致`);
      }
      const reserved = await this.prisma.storageReservation.findFirst({
        where: {
          resourceId: match.id,
          resourceType: "MATERIAL_UPLOAD",
          status: "RESERVED",
          tenantId: scope.tenantId,
        },
      });
      if (reserved) {
        await this.storageQuota.release(
          reserved.id,
          scope.tenantId,
          "Refresh unfinished material revision upload",
        );
      }
      await this.storageQuota.reserve({
        byteSize: match.byteSize ?? file.byteSize,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        reservationKey: `material-upload:${match.id}:resume:${randomUUID()}`,
        resourceId: match.id,
        resourceType: "MATERIAL_UPLOAD",
        storageKey: match.objectKey,
        tenantId: scope.tenantId,
      });
      intents.push({
        artifactId: match.id,
        expiresInSeconds: 900,
        headers: { "Content-Type": file.mimeType },
        materialId,
        uploadUrl: await this.storage.signedUpload({
          byteSize: file.byteSize,
          key: match.objectKey,
          mimeType: file.mimeType,
        }),
      });
    }
    return { materialId, intents };
  }

  async finalizeRevision(scope: MaterialContentScope, materialId: string) {
    const principal = this.requireScope(scope);
    const job = await this.prisma.$transaction(
      async (transaction) => {
        await this.requireWritableScope(transaction, scope);
        const material = await transaction.material.findFirst({
          where: { id: materialId, ...exactScope(scope), parserVersion: BUNDLE_PARSER_VERSION },
        });
        if (!material) throw new NotFoundException("待处理的资料更新不存在");
        if (
          await transaction.materialArtifact.count({
            where: { materialId, status: "PENDING_UPLOAD" },
          })
        ) {
          throw new ConflictException("请先完成所有新附件的上传");
        }
        const existing = await transaction.materialIngestionJob.findFirst({
          where: { materialId },
          orderBy: { queueVersion: "desc" },
        });
        if (existing) return existing;
        const first = await transaction.materialArtifact.findFirst({
          where: { materialId, status: { in: ["STORED", "VERIFIED"] } },
          orderBy: { createdAt: "asc" },
        });
        if (!first) throw new ConflictException("没有可用于处理的资料附件");
        const created = await transaction.materialIngestionJob.create({
          data: {
            artifactId: first.id,
            enterpriseId: scope.enterpriseId,
            materialId,
            parserVersion: BUNDLE_PARSER_VERSION,
            scopeKey: materialScopeKey(scope),
            tenantId: scope.tenantId,
          },
        });
        await audit(
          transaction,
          scope,
          principal.userId,
          "material.revision.finalize",
          materialId,
          {
            attachmentCount: await transaction.materialArtifact.count({ where: { materialId } }),
            ingestionJobId: created.id,
          },
        );
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (job.status === "PENDING") await this.enqueueBestEffort(job);
    return { materialId, job: materialIngestionJobResponse(job) };
  }

  async completeUpload(
    scope: MaterialContentScope,
    materialId: string,
    artifactId: string,
    _input: CompleteMaterialUploadDto,
  ) {
    const principal = this.requireScope(scope);
    const artifact = await this.prisma.materialArtifact.findFirst({
      where: { id: artifactId, materialId, ...exactScope(scope) },
    });
    if (!artifact?.objectKey) throw new NotFoundException("Pending material upload was not found");
    const material = await this.prisma.material.findUnique({
      select: { parserVersion: true },
      where: { id: materialId },
    });
    const isRevision = material?.parserVersion === BUNDLE_PARSER_VERSION;
    if (artifact.status !== "PENDING_UPLOAD") {
      const job = await this.prisma.materialIngestionJob.findFirst({
        orderBy: { queueVersion: "desc" },
        where: { materialId, tenantId: scope.tenantId },
      });
      if (!job && !isRevision) throw new ConflictException("Material upload has no ingestion job");
      return {
        artifact: materialArtifactResponse(artifact),
        job: job ? materialIngestionJobResponse(job) : null,
        materialId,
      };
    }
    const head = await this.storage.head(artifact.objectKey);
    if (
      head.byteSize !== artifact.byteSize ||
      normalizeMime(head.contentType) !== artifact.mimeType
    ) {
      await this.storage.delete(artifact.objectKey).catch(() => undefined);
      const reservation = await this.prisma.storageReservation.findFirst({
        where: {
          resourceId: artifact.id,
          resourceType: "MATERIAL_UPLOAD",
          tenantId: scope.tenantId,
        },
      });
      if (reservation?.status === "RESERVED") {
        await this.storageQuota
          .release(
            reservation.id,
            scope.tenantId,
            "Release material upload capacity after object metadata mismatch",
          )
          .catch(() => undefined);
      }
      throw new ConflictException({
        code: "MATERIAL_UPLOAD_MISMATCH",
        message: "Uploaded object size or MIME type does not match the reserved upload",
      });
    }
    let reservation = await this.prisma.storageReservation.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        resourceId: artifact.id,
        resourceType: "MATERIAL_UPLOAD",
        status: { in: ["RESERVED", "COMMITTED"] },
        tenantId: scope.tenantId,
      },
    });
    if (!reservation) {
      reservation = await this.storageQuota.reserve({
        byteSize: head.byteSize,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        reservationKey: `material-upload:${artifact.id}:complete:${randomUUID()}`,
        resourceId: artifact.id,
        resourceType: "MATERIAL_UPLOAD",
        storageKey: artifact.objectKey,
        tenantId: scope.tenantId,
      });
    }
    const ingestionJobId = randomUUID();
    const result = await this.prisma.$transaction(async (transaction) => {
      const updatedArtifact = await transaction.materialArtifact.update({
        data: { status: "STORED", storedAt: new Date() },
        where: { id: artifact.id },
      });
      const job = isRevision
        ? null
        : await transaction.materialIngestionJob.create({
            data: {
              artifactId,
              enterpriseId: scope.enterpriseId,
              id: ingestionJobId,
              materialId,
              parserVersion: PARSER_VERSION,
              scopeKey: materialScopeKey(scope),
              tenantId: scope.tenantId,
            },
          });
      await this.storageQuota.commitInTransaction(
        transaction,
        reservation.id,
        scope.tenantId,
        "Commit material upload after object metadata verification",
      );
      await audit(transaction, scope, principal.userId, "material.upload.complete", materialId, {
        artifactId,
        ingestionJobId: job?.id ?? null,
      });
      return { artifact: updatedArtifact, job };
    });
    if (result.job) await this.enqueueBestEffort(result.job);
    return {
      artifact: materialArtifactResponse(result.artifact),
      job: result.job ? materialIngestionJobResponse(result.job) : null,
      materialId,
    };
  }

  async createLink(scope: MaterialContentScope, input: CreateMaterialLinkDto) {
    const principal = this.requireScope(scope);
    validatePublicUrlShape(input.sourceUrl);
    validateMaterialRange(input.validFrom, input.expiresAt);
    const materialId = randomUUID();
    const artifactId = randomUUID();
    const ingestionJobId = randomUUID();
    const result = await this.prisma.$transaction(
      async (transaction) => {
        await this.requireWritableScope(transaction, scope);
        const version = await materialVersionData(
          transaction,
          scope,
          "LINK",
          input.supersedesId,
          input.changeNote,
        );
        const material = await transaction.material.create({
          data: materialData(
            scope,
            { ...input, type: "LINK" },
            principal.userId,
            materialId,
            input.content ?? "",
            version,
          ),
        });
        const artifact = await transaction.materialArtifact.create({
          data: {
            enterpriseId: scope.enterpriseId,
            id: artifactId,
            kind: "LINK_SNAPSHOT",
            materialId,
            mimeType: "application/octet-stream",
            scopeKey: materialScopeKey(scope),
            sourceUrl: input.sourceUrl,
            metadata: medicalArtifactMetadata(material.structuredFacts),
            tenantId: scope.tenantId,
          },
        });
        const job = await transaction.materialIngestionJob.create({
          data: {
            artifactId,
            enterpriseId: scope.enterpriseId,
            id: ingestionJobId,
            materialId,
            parserVersion: PARSER_VERSION,
            scopeKey: materialScopeKey(scope),
            tenantId: scope.tenantId,
          },
        });
        await audit(transaction, scope, principal.userId, "material.link.create", materialId, {
          artifactId,
          changeNote: input.changeNote,
          ingestionJobId,
          sourceUrl: input.sourceUrl,
          supersedesId: input.supersedesId,
        });
        return { artifact, job, material };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.enqueueBestEffort(result.job);
    return {
      artifact: materialArtifactResponse(result.artifact),
      job: materialIngestionJobResponse(result.job),
      materialId: result.material.id,
    };
  }

  async retry(scope: MaterialContentScope, materialId: string, input: RetryMaterialIngestionDto) {
    const principal = this.requireScope(scope);
    return this.retryInScope(scope, materialId, input, principal.userId);
  }

  async retryForPlatform(
    scope: MaterialContentScope,
    materialId: string,
    input: RetryMaterialIngestionDto,
    expectedJobId?: string,
  ) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "PLATFORM" ||
      !principal.permissions.includes("platform.monitor.manage")
    ) {
      throw new ForbiddenException("平台处理异常恢复需要平台管理员管理权限");
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: scope.tenantId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!tenant) throw new ConflictException("客户已停用，不能重新处理资料");
    return this.retryInScope(scope, materialId, input, principal.userId, expectedJobId);
  }

  private async retryInScope(
    scope: MaterialContentScope,
    materialId: string,
    input: RetryMaterialIngestionDto,
    actorUserId: string,
    expectedJobId?: string,
  ) {
    const result = await this.prisma.$transaction(
      async (transaction) => {
        await this.requireWritableScope(transaction, scope);
        const material = await transaction.material.findFirst({
          include: { ingestionJobs: { orderBy: { queueVersion: "desc" }, take: 1 } },
          where: { id: materialId, ...exactScope(scope) },
        });
        if (!material) throw new NotFoundException("Material was not found in the writable scope");
        const recheck =
          material.ingestionStatus === "READY" && material.usabilityStatus === "NEEDS_INPUT";
        const retryAfterConfigurationFix =
          material.ingestionStatus === "QUARANTINED" &&
          canRetryQuarantinedMaterial(material.ingestionErrorCode);
        if (
          material.status !== "ACTIVE" ||
          (material.ingestionStatus !== "FAILED" && !recheck && !retryAfterConfigurationFix)
        ) {
          throw new ConflictException(
            "仅可重新处理启用中的失败资料或待补充资料；文件校验失败请更新内容",
          );
        }
        await nextMaterialVersion(transaction, material);
        const previous = material.ingestionJobs[0];
        if (expectedJobId && previous?.id !== expectedJobId) {
          throw new ConflictException("这条异常已有新的处理任务，请刷新列表后查看最新结果");
        }
        if (
          previous?.status === "PROCESSING" ||
          (previous?.status === "FAILED" && previous.attemptCount < previous.maxAttempts)
        ) {
          throw new ConflictException("系统正在自动重试，请稍后查看处理结果");
        }
        const queueVersion = (previous?.queueVersion ?? 0) + 1;
        const job = await transaction.materialIngestionJob.create({
          data: {
            artifactId: previous?.artifactId,
            enterpriseId: scope.enterpriseId,
            materialId,
            parserVersion:
              material.parserVersion === BUNDLE_PARSER_VERSION
                ? BUNDLE_PARSER_VERSION
                : PARSER_VERSION,
            queueVersion,
            scopeKey: materialScopeKey(scope),
            tenantId: scope.tenantId,
          },
        });
        await transaction.material.update({
          data: {
            ingestionErrorCode: null,
            ingestionErrorMessage: null,
            ingestionStatus: "PENDING",
          },
          where: { id: materialId },
        });
        await audit(transaction, scope, actorUserId, "material.ingestion.retry", materialId, {
          ingestionJobId: job.id,
          queueVersion,
          reason: input.reason,
        });
        return job;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.enqueueBestEffort(result);
    return materialIngestionJobResponse(result);
  }

  async supplement(scope: MaterialContentScope, materialId: string, input: SupplementMaterialDto) {
    const principal = this.requireScope(scope);
    const result = await this.prisma.$transaction(
      async (transaction) => {
        await this.requireWritableScope(transaction, scope);
        const source = await transaction.material.findFirst({
          include: {
            artifacts: true,
            ingestionJobs: { orderBy: { queueVersion: "desc" }, take: 1 },
          },
          where: { id: materialId, ...exactScope(scope) },
        });
        if (!source) throw new NotFoundException("资料不存在或不在当前管理范围内");
        if (source.status !== "ACTIVE" || source.ingestionStatus !== "READY") {
          throw new ConflictException("请等待资料处理完成后再补充说明");
        }
        const nextVersion = await nextMaterialVersion(transaction, source);
        // Pending clarification has never been callable. Published material instead gets
        // an immutable revision, reusing its stored artifact without another upload.
        const revise = source.usabilityStatus === "USABLE";
        const supplement = input.supplement;
        if (supplement.length > 10000)
          throw new ConflictException("补充说明过长，请发布新版本整理内容");
        const target = revise
          ? await transaction.material.create({
              data: {
                authorizationStatus: source.authorizationStatus,
                changeNote: "补充资料说明",
                content: source.sourceText ?? source.content,
                parserVersion: source.parserVersion,
                createdBy: principal.userId,
                enterpriseId: scope.enterpriseId,
                expiresAt: source.expiresAt,
                scopeKey: source.scopeKey,
                seriesId: source.seriesId,
                sourceText: source.sourceText ?? source.content,
                sourceUrl: source.sourceUrl,
                structuredFacts: source.structuredFacts ?? undefined,
                supplement,
                supersedesId: source.id,
                tags: source.tags,
                tenantId: scope.tenantId,
                title: source.title,
                type: source.type,
                usabilityStatus: "PENDING",
                validFrom: source.validFrom,
                version: nextVersion,
              },
            })
          : await transaction.material.update({
              data: {
                ingestionStatus: "PENDING",
                usabilityStatus: "PENDING",
                supplement,
                ingestionErrorCode: null,
                ingestionErrorMessage: null,
              },
              where: { id: source.id },
            });
        const storedArtifacts = source.artifacts.filter(
          (artifact) => artifact.status === "STORED" || artifact.status === "VERIFIED",
        );
        let artifactId = storedArtifacts[0]?.id;
        if (revise) {
          for (const original of storedArtifacts) {
            const {
              id: _id,
              createdAt: _created,
              updatedAt: _updated,
              metadata,
              ...artifactData
            } = original;
            const medicalMetadata = medicalArtifactMetadata(target.structuredFacts);
            const artifact = await transaction.materialArtifact.create({
              data: {
                ...artifactData,
                materialId: target.id,
                metadata: Object.keys(medicalMetadata).length
                  ? {
                      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
                        ? metadata
                        : {}),
                      ...medicalMetadata,
                    }
                  : (metadata ?? undefined),
              },
            });
            if (original.id === storedArtifacts[0]?.id) artifactId = artifact.id;
          }
        }
        const job = await transaction.materialIngestionJob.create({
          data: {
            artifactId,
            enterpriseId: scope.enterpriseId,
            materialId: target.id,
            parserVersion:
              source.parserVersion === BUNDLE_PARSER_VERSION
                ? BUNDLE_PARSER_VERSION
                : PARSER_VERSION,
            queueVersion: revise ? 1 : (source.ingestionJobs[0]?.queueVersion ?? 0) + 1,
            scopeKey: source.scopeKey,
            tenantId: scope.tenantId,
          },
        });
        await audit(transaction, scope, principal.userId, "material.supplement", target.id, {
          ingestionJobId: job.id,
          sourceMaterialId: source.id,
          supplement,
        });
        return { job, materialId: target.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.enqueueBestEffort(result.job);
    return { materialId: result.materialId, job: materialIngestionJobResponse(result.job) };
  }

  async previewArtifact(scope: MaterialContentScope, materialId: string, artifactId: string) {
    this.requireScope(scope);
    const artifact = await this.prisma.materialArtifact.findFirst({
      where: {
        id: artifactId,
        materialId,
        status: { in: ["STORED", "VERIFIED"] },
        ...exactScope(scope),
      },
    });
    if (!artifact?.objectKey) throw new NotFoundException("Stored material artifact was not found");
    // Only image previews are downloaded by the API. Never substitute the signed original
    // into the inline preview when decoding/compression fails.
    let optimizedDataUrl: string | null = null;
    if (IMAGE_MIME_TYPES.has(artifact.mimeType)) {
      try {
        const source = await this.storage.readPreviewSource(artifact.objectKey, MAX_MATERIAL_BYTES);
        for (const [width, quality] of [
          [960, 68],
          [640, 52],
          [420, 42],
        ]) {
          const thumbnail = await sharp(source, { limitInputPixels: 40_000_000 })
            .rotate()
            .resize(width, width, { fit: "inside", withoutEnlargement: true })
            .webp({ quality, effort: 4 })
            .toBuffer();
          if (thumbnail.byteLength <= 256 * 1024) {
            optimizedDataUrl = `data:image/webp;base64,${thumbnail.toString("base64")}`;
            break;
          }
        }
      } catch {
        // A corrupt/oversized image can still be opened explicitly as an original file.
      }
    }
    return {
      expiresInSeconds: 900,
      optimizedDataUrl,
      url: await this.storage.signedPreview(artifact.objectKey),
    };
  }

  private async enqueueBestEffort(job: {
    id: string;
    materialId: string;
    queueVersion: number;
    tenantId: string;
  }) {
    try {
      await this.queue.enqueue({
        ingestionJobId: job.id,
        materialId: job.materialId,
        queueVersion: job.queueVersion,
        tenantId: job.tenantId,
      });
    } catch {
      // The worker reconciler also dispatches durable PENDING rows.
    }
  }

  private requireScope(scope: MaterialContentScope) {
    const principal = this.accessContext.requireSaasAdmin();
    const valid =
      (scope.enterpriseId === null &&
        principal.scope.type === "TENANT" &&
        principal.scope.tenantId === scope.tenantId) ||
      (scope.enterpriseId !== null &&
        principal.scope.type === "ENTERPRISE" &&
        principal.scope.tenantId === scope.tenantId &&
        principal.scope.enterpriseId === scope.enterpriseId);
    if (!valid)
      throw new ForbiddenException("Active request scope does not match the content scope");
    return principal;
  }

  private async requireWritableScope(
    transaction: Prisma.TransactionClient,
    scope: MaterialContentScope,
  ) {
    if (scope.enterpriseId) {
      const enterprise = await transaction.enterprise.findFirst({
        where: { id: scope.enterpriseId, status: "ACTIVE", tenantId: scope.tenantId },
      });
      if (!enterprise) throw new NotFoundException("Active enterprise was not found");
      return;
    }
    const tenant = await transaction.tenant.findFirst({
      where: { id: scope.tenantId, status: "ACTIVE" },
    });
    if (!tenant) throw new NotFoundException("Active tenant was not found");
    const capability = await this.capabilities.current(scope.tenantId, transaction);
    this.capabilities.requireGroupSharedMaterials(capability);
  }
}

function materialArtifactResponse(artifact: MaterialArtifact) {
  return {
    ...imageAssetDetails(artifact.metadata),
    byteSize: artifact.byteSize,
    checksum: artifact.checksum,
    createdAt: artifact.createdAt,
    id: artifact.id,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    originalFileName: artifact.originalFileName,
    sourceUrl: artifact.sourceUrl,
    status: artifact.status,
    verifiedAt: artifact.verifiedAt,
  };
}

function materialIngestionJobResponse(job: MaterialIngestionJob) {
  const failure = materialFailureResponse(job.errorCode);
  return {
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    finishedAt: job.finishedAt,
    id: job.id,
    queueVersion: job.queueVersion,
    status: job.status,
  };
}

function materialData(
  scope: MaterialContentScope,
  input: CreateMaterialUploadIntentDto | (CreateMaterialLinkDto & { type: "LINK" }),
  createdBy: string,
  id: string,
  content: string,
  version: MaterialVersionData,
): Prisma.MaterialUncheckedCreateInput {
  const { sourceFacts, ...versionData } = version;
  const structuredFacts = medicalMaterialFacts(input, input.type, sourceFacts);
  return {
    authorizationStatus: "AUTHORIZED",
    content,
    sourceText: content,
    supplement:
      [
        "supplement" in input ? input.supplement : undefined,
        input.title ? `用户提供的标题：${input.title}` : undefined,
        input.tags?.length ? `用户提供的关键词：${input.tags.join("、")}` : undefined,
        input.structuredFacts
          ? `用户提供的事实：${JSON.stringify(input.structuredFacts)}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    createdBy,
    enterpriseId: scope.enterpriseId,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    id,
    ingestionStatus: "PENDING",
    usabilityStatus: "PENDING",
    scopeKey: materialScopeKey(scope),
    sourceUrl: "sourceUrl" in input ? input.sourceUrl : undefined,
    structuredFacts: structuredFacts as Prisma.InputJsonValue | undefined,
    tags: normalizeTags(input.tags ?? []),
    tenantId: scope.tenantId,
    title: input.title ?? ("fileName" in input ? input.fileName.slice(0, 200) : "正在整理资料"),
    type: input.type,
    validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
    ...versionData,
  };
}

type MaterialVersionData = Readonly<{
  sourceFacts?: unknown;
  changeNote?: string;
  seriesId?: string;
  supersedesId?: string;
  version?: number;
}>;

async function materialVersionData(
  transaction: Prisma.TransactionClient,
  scope: MaterialContentScope,
  type: "DOCUMENT" | "IMAGE_REFERENCE" | "LINK",
  supersedesId?: string,
  changeNote?: string,
): Promise<MaterialVersionData> {
  if (!supersedesId) {
    if (changeNote) throw new ConflictException("A change note requires a source material version");
    return {};
  }
  if (!changeNote) throw new ConflictException("A new material version requires a change note");
  const source = await transaction.material.findFirst({
    where: { id: supersedesId, ...exactScope(scope) },
  });
  if (!source) throw new NotFoundException("Source material version was not found");
  if (source.type !== type) {
    throw new ConflictException("A material version must keep the same source type");
  }
  const nextVersion = await nextMaterialVersion(transaction, source);
  return {
    changeNote,
    sourceFacts: source.structuredFacts,
    seriesId: source.seriesId,
    supersedesId: source.id,
    version: nextVersion,
  };
}

async function audit(
  transaction: Prisma.TransactionClient,
  scope: MaterialContentScope,
  actorUserId: string,
  action: string,
  materialId: string,
  stateAfter: Prisma.InputJsonValue,
) {
  await transaction.auditLog.create({
    data: {
      action,
      actorType: "USER",
      actorUserId,
      enterpriseId: scope.enterpriseId,
      resourceId: materialId,
      resourceType: "Material",
      stateAfter,
      tenantId: scope.tenantId,
    },
  });
}

function validateUploadInput(input: CreateMaterialUploadIntentDto): void {
  medicalMaterialFacts(input, input.type);
  if (input.byteSize < 1 || input.byteSize > MAX_MATERIAL_BYTES) {
    throw new ConflictException("Material file must be between 1 byte and 25 MiB");
  }
  const supported = input.type === "DOCUMENT" ? DOCUMENT_MIME_TYPES : IMAGE_MIME_TYPES;
  if (!supported.has(input.mimeType)) {
    throw new ConflictException("Material MIME type is not supported for this source type");
  }
  validateMaterialRange(input.validFrom, input.expiresAt);
}

function medicalArtifactMetadata(structuredFacts: unknown): Prisma.InputJsonObject {
  const facts =
    structuredFacts && typeof structuredFacts === "object" && !Array.isArray(structuredFacts)
      ? (structuredFacts as Record<string, unknown>)
      : {};
  return facts.medicalMaterial === undefined
    ? {}
    : {
        medicalMaterial: facts.medicalMaterial as Prisma.InputJsonValue,
        ...(readMedicalMaterial(facts.medicalMaterial)?.purpose === "REAL_SCENE"
          ? { usage: "REFERENCE" }
          : {}),
      };
}

function validatePublicUrlShape(value: string): void {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new ConflictException(
      "Material link must be a public HTTP or HTTPS URL without credentials",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new ConflictException("Local network material links are not allowed");
  }
}

function validateMaterialRange(validFrom?: string, expiresAt?: string): void {
  if (validFrom && expiresAt && new Date(expiresAt) <= new Date(validFrom)) {
    throw new ConflictException("Material expiresAt must be after validFrom");
  }
}

function normalizeMime(value?: string): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function exactScope(scope: MaterialContentScope) {
  return { enterpriseId: scope.enterpriseId, tenantId: scope.tenantId };
}

function materialScopeKey(scope: MaterialContentScope): string {
  return scope.enterpriseId ?? "__tenant__";
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 30);
}

import { nextMaterialVersion } from "./material-version-policy";
