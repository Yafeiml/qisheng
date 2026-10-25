import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  assetRecord,
  deterministicEmbedding,
  embeddingProfileVersion,
  imageAssetDetails,
  ModelCredentialCipher,
  modelCredentialAssociatedData,
  OpenAICompatibleEmbeddingProvider,
  readMedicalMaterial,
  resolveEmbeddingProfile,
} from "@xhs-agentic/ai-gateway";
import { Prisma, PrismaClient } from "@xhs-agentic/database";
import {
  PublicHttpPolicyError,
  resolvePublicHttpUrl,
  withPublicHttpResponse,
} from "@xhs-agentic/network-security";
import {
  createObjectStorage,
  materialArtifactObjectKey,
  type ObjectStorage,
} from "@xhs-agentic/object-storage";
import { writeStructuredLog } from "@xhs-agentic/observability";
import { type ConnectionOptions, type Job, Queue, UnrecoverableError, Worker } from "bullmq";
import { load } from "cheerio";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import {
  classifyArtifactReadError,
  classifyIngestionError,
  classifyModelIngestionError,
  MaterialIngestionError,
} from "./material-ingestion-errors";
import {
  MATERIAL_AI_VERSION,
  type MaterialAnalysis,
  type MaterialUnderstanding,
  PlatformMaterialUnderstanding,
  type UnderstandingInput,
} from "./material-understanding";
import { loadWorkerPlatformSettings } from "./platform-settings";
import { WorkerStorageQuota } from "./storage-quota";

export const MATERIAL_INGESTION_QUEUE_NAME = "material-ingestion-v1";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LINK_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 250_000;
const MAX_PDF_PAGES = 100;
const BUNDLE_PARSER_VERSION = "material-ai-bundle-v1";

export type MaterialIngestionJobData = Readonly<{
  ingestionJobId: string;
  materialId: string;
  queueVersion: number;
  tenantId: string;
}>;

export interface MaterialIngestionWorkerHandle {
  close(): Promise<void>;
}

export async function startMaterialIngestionWorker(): Promise<MaterialIngestionWorkerHandle> {
  const prisma = new PrismaClient();
  let queue: Queue<MaterialIngestionJobData> | undefined;
  let worker: Worker<MaterialIngestionJobData> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = async (force = false) => {
    clearInterval(timer);
    await Promise.allSettled([worker?.close(force), queue?.close()]);
    await prisma.$disconnect();
  };
  try {
    await prisma.$connect();
    const platformSettings = await loadWorkerPlatformSettings(prisma, { contentSafety: false });
    const storage = createObjectStorage(platformSettings.storage);
    await storage.ensureBucket(process.env.NODE_ENV !== "production");
    const connection = redisConnection(requiredEnv("REDIS_URL"));
    const prefix = requiredEnv("REDIS_PREFIX");
    queue = new Queue<MaterialIngestionJobData>(MATERIAL_INGESTION_QUEUE_NAME, {
      connection,
      prefix,
    });
    const runtime = new MaterialIngestionRuntime(prisma, storage);
    const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
    worker = new Worker<MaterialIngestionJobData>(
      MATERIAL_INGESTION_QUEUE_NAME,
      async (job) => processMaterialJob(job, runtime, workerId),
      {
        concurrency: platformSettings.material.concurrency,
        connection,
        prefix,
      },
    );
    worker.on("completed", (job) => workerLog("info", "material-ingestion.completed", job.data));
    worker.on("failed", (job, error) =>
      workerLog("error", "material-ingestion.failed", { ...job?.data, error }),
    );
    worker.on("error", (error) => workerLog("error", "material-ingestion.worker-error", { error }));
    await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
    await Promise.all([reconcilePendingMaterialJobs(prisma, queue), runtime.reconcileStorage()]);
    const activeQueue = queue;
    timer = setInterval(
      () =>
        void Promise.all([
          reconcilePendingMaterialJobs(prisma, activeQueue),
          runtime.reconcileStorage(),
        ]),
      platformSettings.material.reconcileIntervalMs,
    );
    timer.unref();
    workerLog("info", "material-ingestion.ready", { workerId });
    return { close };
  } catch (error) {
    await close(true).catch(() => undefined);
    throw error;
  }
}

export class MaterialIngestionRuntime {
  private readonly storageQuota: WorkerStorageQuota;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
    private readonly understanding: MaterialUnderstanding = new PlatformMaterialUnderstanding(
      prisma,
    ),
  ) {
    this.storageQuota = new WorkerStorageQuota(prisma, storage);
  }

  reconcileStorage(): Promise<number> {
    return this.storageQuota.releaseExpired();
  }

  async process(data: MaterialIngestionJobData, workerId: string): Promise<{ chunks: number }> {
    const leaseToken = randomUUID();
    let pendingStorage: Readonly<{ id: string; key: string; tenantId: string }> | undefined;
    const claimed = await this.prisma.materialIngestionJob.updateMany({
      data: {
        attemptCount: { increment: 1 },
        heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        leaseOwner: workerId,
        leaseToken,
        startedAt: new Date(),
        status: "PROCESSING",
      },
      where: {
        id: data.ingestionJobId,
        materialId: data.materialId,
        queueVersion: data.queueVersion,
        status: { in: ["PENDING", "FAILED"] },
        tenantId: data.tenantId,
      },
    });
    if (claimed.count === 0) {
      const existing = await this.prisma.material.findFirst({
        select: { ingestionStatus: true },
        where: { id: data.materialId, tenantId: data.tenantId },
      });
      if (existing?.ingestionStatus === "READY") return { chunks: 0 };
      throw new UnrecoverableError("Material ingestion job is stale or already claimed");
    }
    const heartbeat = setInterval(() => {
      void this.prisma.materialIngestionJob
        .updateMany({
          data: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 5 * 60_000) },
          where: { id: data.ingestionJobId, leaseToken, status: "PROCESSING" },
        })
        .catch(() => undefined);
    }, 30000);
    heartbeat.unref();
    try {
      const source = await this.loadSource(data);
      const medicalMaterial = readMedicalMaterial(
        assetRecord(source.material.structuredFacts).medicalMaterial,
      );
      const archived = medicalMaterial?.purpose === "ARCHIVE";
      if (source.job.purpose === "REINDEX") {
        return await this.reindex(data, leaseToken, source);
      }
      await this.prisma.material.update({
        data: { ingestionStatus: "PROCESSING" },
        where: { id: data.materialId },
      });
      const bundle =
        source.job.parserVersion === BUNDLE_PARSER_VERSION ||
        (source.material.type === "IMAGE_REFERENCE" &&
          source.job.parserVersion === MATERIAL_AI_VERSION)
          ? await this.extractBundle(source)
          : null;
      const extracted = bundle?.extracted ?? (await this.extract(source));
      if (extracted.storageReservationId && extracted.objectKey) {
        pendingStorage = {
          id: extracted.storageReservationId,
          key: extracted.objectKey,
          tenantId: source.material.tenantId,
        };
      }
      const policy = await this.prisma.runtimePolicy.findUnique({ where: { id: "platform" } });
      if (!policy) throw new MaterialIngestionError("RUNTIME_POLICY_MISSING", false);
      const analysis = archived
        ? null
        : (bundle?.analysis ??
          (source.job.parserVersion === MATERIAL_AI_VERSION
            ? await this.analyze({
                tenantId: source.material.tenantId,
                enterpriseId: source.material.enterpriseId,
                materialId: source.material.id,
                type: source.material.type,
                text: source.material.type === "IMAGE_REFERENCE" ? "" : extracted.text,
                fileName: source.artifact?.originalFileName ?? null,
                supplement: source.material.supplement ?? "",
                medicalMaterial: medicalMaterial ?? undefined,
                imageBytes:
                  source.material.type === "IMAGE_REFERENCE" ? source.artifactBytes : undefined,
              })
            : null));
      const imageEntries = bundle?.imageEntries;
      const usableEntries = imageEntries?.filter(
        (entry) => !entry.analysis.missingInformation.length,
      );
      const usable = imageEntries?.length
        ? Boolean(usableEntries?.length)
        : !analysis || analysis.missingInformation.length === 0;
      const usableImageAnalysis = usableEntries?.length
        ? mergeMaterialAnalyses(usableEntries.map((entry) => entry.analysis))
        : null;
      const tags = usableImageAnalysis?.keywords ?? analysis?.keywords ?? source.material.tags;
      const content =
        analysis && source.material.type === "IMAGE_REFERENCE"
          ? [
              (usableImageAnalysis ?? analysis).visualDescription,
              (usableImageAnalysis ?? analysis).recognizedText,
              source.material.supplement,
            ]
              .filter(Boolean)
              .join("\n\n")
          : [extracted.text, source.material.supplement].filter(Boolean).join("\n\n");
      const searchableText = analysis
        ? [`资料：${analysis.title}`, `检索关键词：${tags.join("、")}`, content].join("\n\n")
        : content;
      const chunks = archived
        ? []
        : imageEntries?.length
          ? (usableEntries ?? [])
              .flatMap((entry) =>
                chunkText(
                  [
                    `图片：${entry.fileName}`,
                    `主体：${entry.analysis.title}`,
                    `关键词：${entry.analysis.keywords.join("、")}`,
                    entry.analysis.visualDescription,
                    entry.analysis.recognizedText,
                    entry.description,
                    source.material.supplement,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  policy.materialChunkSizeCharacters,
                  policy.materialChunkOverlapCharacters,
                ).map((chunk) => ({ ...chunk, artifactId: entry.artifactId })),
              )
              .map((chunk, ordinal) => ({ ...chunk, ordinal }))
          : usable
            ? chunkText(
                searchableText,
                policy.materialChunkSizeCharacters,
                policy.materialChunkOverlapCharacters,
              )
            : [];
      if (usable && !archived && chunks.length === 0)
        throw new MaterialIngestionError("EMPTY_EXTRACTED_TEXT", false);
      const embedding =
        usable && !archived
          ? await this.embed(
              chunks.map((chunk) => chunk.text),
              policy.embeddingModelId,
            )
          : { vectors: [], dimensions: 0, modelDefinitionId: null, profileVersion: "not-indexed" };
      const rows = chunks.map((chunk) => ({
        ...chunk,
        id: randomUUID(),
        textChecksum: sha256(chunk.text),
      }));
      await this.prisma.$transaction(
        async (transaction) => {
          const activeLease = await transaction.materialIngestionJob.findFirst({
            where: { id: data.ingestionJobId, leaseToken, status: "PROCESSING" },
          });
          if (!activeLease) throw new Error("Material ingestion lease was lost");
          await transaction.materialEmbedding.deleteMany({
            where: { materialId: source.material.id },
          });
          await transaction.materialChunk.deleteMany({ where: { materialId: source.material.id } });
          await transaction.materialChunk.createMany({
            data: rows.map((chunk) => ({
              characterCount: chunk.text.length,
              enterpriseId: source.material.enterpriseId,
              id: chunk.id,
              materialId: source.material.id,
              metadata: {
                endCharacter: chunk.end,
                parserVersion: activeLease.parserVersion,
                startCharacter: chunk.start,
                ...("artifactId" in chunk && typeof chunk.artifactId === "string"
                  ? { artifactId: chunk.artifactId }
                  : {}),
              },
              ordinal: chunk.ordinal,
              scopeKey: source.material.scopeKey,
              structuredFacts: source.material.structuredFacts ?? undefined,
              tenantId: source.material.tenantId,
              text: chunk.text,
              textChecksum: chunk.textChecksum,
              tokenCount: approximateTokenCount(chunk.text),
            })),
          });
          await transaction.materialEmbedding.createMany({
            data: rows.map((chunk, index) => {
              const vector = embedding.vectors[index];
              if (!vector)
                throw new MaterialIngestionError("EMBEDDING_VECTOR_COUNT_MISMATCH", false);
              return {
                chunkId: chunk.id,
                dimension: embedding.dimensions,
                enterpriseId: source.material.enterpriseId,
                materialId: source.material.id,
                modelDefinitionId: embedding.modelDefinitionId,
                profileVersion: embedding.profileVersion,
                scopeKey: source.material.scopeKey,
                tenantId: source.material.tenantId,
                vector,
              };
            }),
          });
          const currentMaterial = await transaction.material.findUniqueOrThrow({
            where: { id: source.material.id },
          });
          const newerUsable = usable
            ? await transaction.material.findFirst({
                where: {
                  seriesId: source.material.seriesId,
                  version: { gt: source.material.version },
                  ingestionStatus: "READY",
                  usabilityStatus: "USABLE",
                },
              })
            : null;
          if (usable && currentMaterial.status === "ACTIVE" && source.material.supersedesId) {
            await transaction.material.updateMany({
              data: { status: "DISABLED" },
              where: {
                scopeKey: source.material.scopeKey,
                seriesId: source.material.seriesId,
                tenantId: source.material.tenantId,
                version: { lt: source.material.version },
              },
            });
          }
          await transaction.material.update({
            data: {
              content,
              contentChecksum: sha256(content),
              title: analysis?.title,
              tags,
              analysis: analysis
                ? (JSON.parse(JSON.stringify(analysis)) as Prisma.InputJsonValue)
                : undefined,
              usabilityStatus: usable ? "USABLE" : "NEEDS_INPUT",
              status: newerUsable ? "DISABLED" : undefined,
              extractedMetadata: extracted.metadata as Prisma.InputJsonValue,
              ingestionErrorCode: null,
              ingestionErrorMessage: null,
              ingestionStatus: "READY",
              parserVersion: activeLease.parserVersion,
              readyAt: usable ? new Date() : null,
            },
            where: { id: source.material.id },
          });
          if (bundle) {
            for (const entry of imageEntries ?? []) {
              await transaction.materialArtifact.update({
                where: { id: entry.artifactId },
                data: {
                  metadata: JSON.parse(
                    JSON.stringify({
                      ...entry.metadata,
                      analysis: entry.analysis,
                      usabilityStatus: entry.analysis.missingInformation.length
                        ? "NEEDS_INPUT"
                        : "USABLE",
                      analysisVersion: "per-image-v1",
                    }),
                  ) as Prisma.InputJsonValue,
                },
              });
            }
            await transaction.materialArtifact.updateMany({
              data: { status: "VERIFIED", verifiedAt: new Date() },
              where: { materialId: source.material.id, status: { in: ["STORED", "VERIFIED"] } },
            });
          } else if (source.artifact) {
            await transaction.materialArtifact.update({
              data: {
                byteSize:
                  extracted.artifactByteSize ??
                  source.artifactBytes?.byteLength ??
                  source.artifact.byteSize,
                checksum:
                  extracted.artifactChecksum ??
                  (source.artifactBytes ? sha256(source.artifactBytes) : source.artifact.checksum),
                metadata: {
                  ...assetRecord(source.artifact.metadata),
                  ...extracted.artifactMetadata,
                } as Prisma.InputJsonValue,
                mimeType: extracted.mimeType,
                objectKey: extracted.objectKey ?? source.artifact.objectKey,
                status: "VERIFIED",
                storedAt: source.artifact.storedAt ?? new Date(),
                verifiedAt: new Date(),
              },
              where: { id: source.artifact.id },
            });
          }
          if (extracted.storageReservationId) {
            await this.storageQuota.commitInTransaction(
              transaction,
              extracted.storageReservationId,
              source.material.tenantId,
              "Commit link snapshot after material ingestion transaction succeeded",
            );
          }
          await transaction.materialIngestionJob.update({
            data: {
              errorCode: null,
              errorMessage: null,
              finishedAt: new Date(),
              heartbeatAt: new Date(),
              leaseExpiresAt: null,
              leaseOwner: null,
              leaseToken: null,
              status: "READY",
            },
            where: { id: data.ingestionJobId },
          });
          await transaction.auditLog.create({
            data: {
              action: usable ? "material.ingestion.ready" : "material.ingestion.needs_input",
              actorType: "SYSTEM",
              enterpriseId: source.material.enterpriseId,
              resourceId: source.material.id,
              resourceType: "Material",
              stateAfter: {
                chunks: rows.length,
                ingestionJobId: data.ingestionJobId,
                parserVersion: activeLease.parserVersion,
                profileVersion: embedding.profileVersion,
              },
              tenantId: source.material.tenantId,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      pendingStorage = undefined;
      return { chunks: rows.length };
    } catch (error) {
      if (pendingStorage) {
        await this.storage.delete(pendingStorage.key).catch(() => undefined);
        await this.storageQuota
          .release(
            pendingStorage.id,
            pendingStorage.tenantId,
            "Release link snapshot capacity after ingestion failed",
          )
          .catch(() => undefined);
      }
      await this.recordFailure(data, leaseToken, error);
      throw classifyIngestionError(error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async reindex(
    data: MaterialIngestionJobData,
    leaseToken: string,
    source: Awaited<ReturnType<MaterialIngestionRuntime["loadSource"]>>,
  ): Promise<{ chunks: number }> {
    const archived =
      readMedicalMaterial(assetRecord(source.material.structuredFacts).medicalMaterial)?.purpose ===
      "ARCHIVE";
    const [policy, storedChunks] = await Promise.all([
      this.prisma.runtimePolicy.findUnique({ where: { id: "platform" } }),
      this.prisma.materialChunk.findMany({
        orderBy: { ordinal: "asc" },
        where: {
          materialId: source.material.id,
          scopeKey: source.material.scopeKey,
          tenantId: source.material.tenantId,
        },
      }),
    ]);
    const chunks = archived ? [] : storedChunks;
    if (!policy) throw new MaterialIngestionError("RUNTIME_POLICY_MISSING", false);
    if (!archived && chunks.length === 0)
      throw new MaterialIngestionError("MATERIAL_CHUNKS_MISSING", false);
    const embedding = archived
      ? { vectors: [], dimensions: 0, modelDefinitionId: null, profileVersion: "not-indexed" }
      : await this.embed(
          chunks.map((chunk) => chunk.text),
          policy.embeddingModelId,
        );
    await this.prisma.$transaction(async (transaction) => {
      const activeLease = await transaction.materialIngestionJob.findFirst({
        where: { id: data.ingestionJobId, leaseToken, purpose: "REINDEX", status: "PROCESSING" },
      });
      if (!activeLease) throw new Error("Material reindex lease was lost");
      await transaction.materialEmbedding.createMany({
        data: chunks.map((chunk, index) => {
          const vector = embedding.vectors[index];
          if (!vector) throw new MaterialIngestionError("EMBEDDING_VECTOR_COUNT_MISMATCH", false);
          return {
            chunkId: chunk.id,
            dimension: embedding.dimensions,
            enterpriseId: source.material.enterpriseId,
            materialId: source.material.id,
            modelDefinitionId: embedding.modelDefinitionId,
            profileVersion: embedding.profileVersion,
            scopeKey: source.material.scopeKey,
            tenantId: source.material.tenantId,
            vector,
          };
        }),
        skipDuplicates: true,
      });
      await transaction.materialIngestionJob.update({
        data: {
          errorCode: null,
          errorMessage: null,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          status: "READY",
        },
        where: { id: data.ingestionJobId },
      });
      await transaction.auditLog.create({
        data: {
          action: "material.embedding.reindexed",
          actorType: "SYSTEM",
          enterpriseId: source.material.enterpriseId,
          resourceId: source.material.id,
          resourceType: "Material",
          stateAfter: {
            chunks: chunks.length,
            ingestionJobId: data.ingestionJobId,
            profileVersion: embedding.profileVersion,
          },
          tenantId: source.material.tenantId,
        },
      });
    });
    return { chunks: chunks.length };
  }

  private async loadSource(data: MaterialIngestionJobData) {
    const job = await this.prisma.materialIngestionJob.findFirst({
      include: { artifact: true, material: true },
      where: { id: data.ingestionJobId, materialId: data.materialId, tenantId: data.tenantId },
    });
    if (!job) throw new MaterialIngestionError("MATERIAL_SOURCE_NOT_FOUND", false);
    let artifactBytes: Uint8Array | undefined;
    if (
      job.purpose === "INGEST" &&
      job.parserVersion !== BUNDLE_PARSER_VERSION &&
      (job.material.type === "DOCUMENT" ||
        (job.material.type === "IMAGE_REFERENCE" && job.parserVersion !== MATERIAL_AI_VERSION))
    ) {
      if (!job.artifact?.objectKey) throw new MaterialIngestionError("ARTIFACT_NOT_STORED", false);
      const objectKey = job.artifact.objectKey;
      const head = await this.readArtifact(() => this.storage.head(objectKey));
      if (
        head.byteSize !== job.artifact.byteSize ||
        normalizeMime(head.contentType) !== job.artifact.mimeType
      ) {
        throw new MaterialIngestionError("ARTIFACT_METADATA_MISMATCH", false);
      }
      artifactBytes = await this.readArtifact(() => this.storage.get(objectKey, MAX_FILE_BYTES));
      if (sha256(artifactBytes) !== job.artifact.checksum) {
        throw new MaterialIngestionError("ARTIFACT_CHECKSUM_MISMATCH", false);
      }
    }
    return { artifact: job.artifact, artifactBytes, job, material: job.material };
  }

  private async extractBundle(source: Awaited<ReturnType<MaterialIngestionRuntime["loadSource"]>>) {
    if (source.material.type !== "DOCUMENT" && source.material.type !== "IMAGE_REFERENCE") {
      throw new MaterialIngestionError("BUNDLE_MATERIAL_TYPE_UNSUPPORTED", false);
    }
    const artifacts = await this.prisma.materialArtifact.findMany({
      orderBy: { createdAt: "asc" },
      where: {
        materialId: source.material.id,
        status: { in: ["STORED", "VERIFIED"] },
        tenantId: source.material.tenantId,
      },
    });
    artifacts.sort((left, right) => {
      const ordinal = (metadata: Prisma.JsonValue | null) =>
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        typeof metadata.bundleOrdinal === "number"
          ? metadata.bundleOrdinal
          : Number.MAX_SAFE_INTEGER;
      return (
        ordinal(left.metadata) - ordinal(right.metadata) ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id)
      );
    });
    if (!artifacts.length || artifacts.length > 20) {
      throw new MaterialIngestionError("BUNDLE_ARTIFACT_COUNT_INVALID", false);
    }
    const texts: string[] = [];
    const analyses: MaterialAnalysis[] = [];
    const medicalMaterial = readMedicalMaterial(
      assetRecord(source.material.structuredFacts).medicalMaterial,
    );
    const archived = medicalMaterial?.purpose === "ARCHIVE";
    const imageEntries: Array<{
      artifactId: string;
      fileName: string;
      description: string;
      metadata: Record<string, unknown>;
      analysis: MaterialAnalysis;
    }> = [];
    for (const artifact of artifacts) {
      if (!artifact.objectKey) throw new MaterialIngestionError("ARTIFACT_NOT_STORED", false);
      const objectKey = artifact.objectKey;
      const head = await this.readArtifact(() => this.storage.head(objectKey));
      if (
        head.byteSize !== artifact.byteSize ||
        normalizeMime(head.contentType) !== artifact.mimeType
      ) {
        throw new MaterialIngestionError("ARTIFACT_METADATA_MISMATCH", false);
      }
      const bytes = await this.readArtifact(() => this.storage.get(objectKey, MAX_FILE_BYTES));
      if (sha256(bytes) !== artifact.checksum) {
        throw new MaterialIngestionError("ARTIFACT_CHECKSUM_MISMATCH", false);
      }
      const label = artifact.originalFileName ?? "附件";
      if (source.material.type === "DOCUMENT") {
        const document = await extractDocument(bytes, artifact.mimeType);
        texts.push(`文件：${label}\n${document.text}`);
      } else {
        const image = await extractImageReference(bytes, artifact.mimeType, {
          ...source.material,
          content: "",
        });
        texts.push(`图片：${label}\n${image.text}`);
        if (archived) continue;
        const details = imageAssetDetails(artifact.metadata);
        const analysis: MaterialAnalysis =
          details.usage === "LOGO"
            ? {
                title: "品牌 Logo",
                summary: source.material.supplement ?? "原始品牌标识",
                keywords: ["Logo", "品牌标识"],
                entities: [],
                suggestedUses: ["原图合成"],
                missingInformation: [],
                personFocused: false,
                visualDescription: "用户指定的原始品牌 Logo，不进行模型重绘",
                recognizedText: "",
              }
            : await this.analyze({
                tenantId: source.material.tenantId,
                enterpriseId: source.material.enterpriseId,
                materialId: source.material.id,
                type: source.material.type,
                text: "",
                fileName: artifact.originalFileName,
                supplement: source.material.supplement ?? "",
                attachmentDescription: details.description,
                bundleFileNames: artifacts.map((item) => item.originalFileName ?? "附件"),
                imageBytes: bytes,
                medicalMaterial:
                  readMedicalMaterial(assetRecord(artifact.metadata).medicalMaterial) ??
                  medicalMaterial ??
                  undefined,
              });
        analyses.push(analysis);
        imageEntries.push({
          artifactId: artifact.id,
          fileName: label,
          description: details.description,
          metadata: assetRecord(artifact.metadata),
          analysis,
        });
      }
    }
    const combined = texts.join("\n\n");
    const extracted = extractedText(combined, "text/plain", {
      attachmentCount: artifacts.length,
      fileNames: artifacts.map((item) => item.originalFileName),
    });
    if (source.material.type === "DOCUMENT" && !archived) {
      analyses.push(
        await this.analyze({
          tenantId: source.material.tenantId,
          enterpriseId: source.material.enterpriseId,
          materialId: source.material.id,
          type: source.material.type,
          text: extracted.text,
          fileName: null,
          supplement: source.material.supplement ?? "",
          medicalMaterial: medicalMaterial ?? undefined,
        }),
      );
    }
    return {
      analysis: analyses.length ? mergeMaterialAnalyses(analyses) : null,
      extracted,
      imageEntries,
    };
  }

  private async extract(source: Awaited<ReturnType<MaterialIngestionRuntime["loadSource"]>>) {
    switch (source.material.type) {
      case "TEXT":
        return extractedText(source.material.sourceText ?? source.material.content, "text/plain", {
          source: "text",
        });
      case "DOCUMENT": {
        if (!source.artifactBytes) throw new MaterialIngestionError("ARTIFACT_NOT_LOADED", false);
        return extractDocument(source.artifactBytes, source.artifact?.mimeType ?? "");
      }
      case "IMAGE_REFERENCE": {
        if (!source.artifactBytes) throw new MaterialIngestionError("ARTIFACT_NOT_LOADED", false);
        return extractImageReference(
          source.artifactBytes,
          source.artifact?.mimeType ?? "",
          source.material,
        );
      }
      case "LINK": {
        if (!source.artifact?.sourceUrl)
          throw new MaterialIngestionError("LINK_URL_MISSING", false);
        const snapshot = await fetchPublicSnapshot(source.artifact.sourceUrl);
        const checksum = sha256(snapshot.bytes);
        const objectKey = materialArtifactObjectKey({
          artifactId: source.artifact.id,
          fileName: snapshot.mimeType === "text/html" ? "snapshot.html" : "snapshot.txt",
          materialId: source.material.id,
          tenantId: source.material.tenantId,
        });
        const reservation = await this.storageQuota.reserve({
          byteSize: snapshot.bytes.byteLength,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          reservationKey: `link-snapshot:${source.job.id}:attempt:${source.job.attemptCount}`,
          resourceId: source.artifact.id,
          resourceType: "LINK_SNAPSHOT",
          storageKey: objectKey,
          tenantId: source.material.tenantId,
        });
        try {
          await this.storage.put({
            bytes: snapshot.bytes,
            checksum,
            key: objectKey,
            mimeType: snapshot.mimeType,
          });
        } catch (error) {
          await this.storage.delete(objectKey).catch(() => undefined);
          await this.storageQuota
            .release(
              reservation.id,
              source.material.tenantId,
              "Release link snapshot capacity after storage failure",
            )
            .catch(() => undefined);
          throw error;
        }
        const parsed = parseLinkSnapshot(snapshot.bytes, snapshot.mimeType);
        return {
          ...extractedText(
            [source.material.sourceText ?? source.material.content, parsed]
              .filter(Boolean)
              .join("\n\n"),
            snapshot.mimeType,
            { finalUrl: snapshot.finalUrl, redirects: snapshot.redirects },
          ),
          artifactByteSize: snapshot.bytes.byteLength,
          artifactChecksum: checksum,
          objectKey,
          storageReservationId: reservation.id,
        };
      }
    }
  }

  private async readArtifact<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw classifyArtifactReadError(error);
    }
  }

  private async analyze(input: UnderstandingInput): Promise<MaterialAnalysis> {
    try {
      return await this.understanding.analyze(input);
    } catch (error) {
      throw classifyModelIngestionError(error, "MATERIAL_ANALYSIS");
    }
  }

  private async embed(texts: readonly string[], embeddingModelId: string | null) {
    try {
      return await this.embedWithModel(texts, embeddingModelId);
    } catch (error) {
      throw classifyModelIngestionError(error, "EMBEDDING");
    }
  }

  private async embedWithModel(texts: readonly string[], embeddingModelId: string | null) {
    if (!embeddingModelId) {
      const vectors = texts.map((text) => deterministicEmbedding(text));
      const firstVector = vectors[0];
      if (!firstVector) throw new MaterialIngestionError("EMPTY_EMBEDDING_INPUT", false);
      return {
        dimensions: firstVector.length,
        modelDefinitionId: null,
        profileVersion: "deterministic-char-ngram-v1",
        vectors,
      };
    }
    const model = await this.prisma.modelDefinition.findFirst({
      include: { provider: { include: { activeCredential: true } } },
      where: {
        capabilities: { has: "EMBEDDING" },
        id: embeddingModelId,
        provider: { status: "ACTIVE", synthetic: false },
        status: "ACTIVE",
        synthetic: false,
      },
    });
    const credential = model?.provider.activeCredential;
    if (!model || credential?.status !== "ACTIVE") {
      throw new MaterialIngestionError("EMBEDDING_MODEL_UNAVAILABLE", true);
    }
    let apiKey: string;
    try {
      apiKey = ModelCredentialCipher.fromEnvironment().decrypt(
        credential,
        modelCredentialAssociatedData(model.providerId, credential.id),
      );
    } catch {
      throw new MaterialIngestionError("EMBEDDING_CREDENTIAL_UNAVAILABLE", false);
    }
    let provider: OpenAICompatibleEmbeddingProvider;
    let profile: ReturnType<typeof resolveEmbeddingProfile>;
    try {
      provider = new OpenAICompatibleEmbeddingProvider({
        apiKey,
        baseUrl: model.provider.baseUrl,
        providerId: model.provider.id,
        timeoutMs: model.provider.timeoutMs,
      });
      profile = resolveEmbeddingProfile(model);
    } catch {
      throw new MaterialIngestionError("EMBEDDING_CONFIGURATION_INVALID", false);
    }
    const vectors: number[][] = [];
    let dimensions = 0;
    for (let index = 0; index < texts.length; index += profile.maxBatchSize) {
      const result = await provider.embed(
        model.externalModelId,
        texts.slice(index, index + profile.maxBatchSize),
        { inputKind: "DOCUMENT", profile },
      );
      if (dimensions && result.dimensions !== dimensions)
        throw new MaterialIngestionError("EMBEDDING_DIMENSIONS_CHANGED", false);
      dimensions = result.dimensions;
      vectors.push(...result.vectors.map((vector) => [...vector]));
    }
    return {
      dimensions,
      modelDefinitionId: model.id,
      profileVersion: embeddingProfileVersion(model),
      vectors,
    };
  }

  private async recordFailure(data: MaterialIngestionJobData, leaseToken: string, error: unknown) {
    const failure = classifyIngestionError(error);
    const status = failure.retryable ? "FAILED" : "QUARANTINED";
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.materialIngestionJob.updateMany({
        data: {
          errorCode: failure.code,
          errorMessage: failure.message.slice(0, 500),
          finishedAt: new Date(),
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          status,
        },
        where: { id: data.ingestionJobId, leaseToken, status: "PROCESSING" },
      });
      if (updated.count === 0) return;
      const ingestionJob = await transaction.materialIngestionJob.findUniqueOrThrow({
        select: { enterpriseId: true, purpose: true },
        where: { id: data.ingestionJobId },
      });
      if (ingestionJob.purpose === "INGEST") {
        await transaction.material.update({
          data: {
            ingestionErrorCode: failure.code,
            ingestionErrorMessage: failure.message.slice(0, 500),
            ingestionStatus: status,
          },
          where: { id: data.materialId },
        });
      }
      await transaction.auditLog.create({
        data: {
          action:
            ingestionJob.purpose === "REINDEX"
              ? `material.embedding.reindex.${status.toLowerCase()}`
              : `material.ingestion.${status.toLowerCase()}`,
          actorType: "SYSTEM",
          enterpriseId: ingestionJob.enterpriseId,
          resourceId: data.materialId,
          resourceType: "Material",
          stateAfter: { code: failure.code, ingestionJobId: data.ingestionJobId },
          tenantId: data.tenantId,
        },
      });
    });
  }
}

function mergeMaterialAnalyses(analyses: MaterialAnalysis[]): MaterialAnalysis {
  const first = analyses[0];
  if (!first) throw new MaterialIngestionError("MATERIAL_ANALYSIS_EMPTY", false);
  const unique = (items: string[], limit: number) => [...new Set(items)].slice(0, limit);
  return {
    title:
      analyses.length > 1
        ? `${[...new Set(analyses.map((item) => item.title))].slice(0, 2).join(" / ").slice(0, 170)}${analyses.length > 2 ? `等 ${analyses.length} 张图片` : ""}`
        : first.title,
    summary: analyses
      .map((item) => item.summary)
      .join("\n")
      .slice(0, 3000),
    keywords: unique(
      analyses.flatMap((item) => item.keywords),
      30,
    ),
    entities: analyses.flatMap((item) => item.entities).slice(0, 60),
    suggestedUses: unique(
      analyses.flatMap((item) => item.suggestedUses),
      10,
    ),
    missingInformation: unique(
      analyses.flatMap((item) => item.missingInformation),
      10,
    ),
    personFocused: analyses.some((item) => item.personFocused),
    visualDescription: analyses
      .map((item) => item.visualDescription)
      .filter(Boolean)
      .join("\n")
      .slice(0, 3000),
    recognizedText: analyses
      .map((item) => item.recognizedText)
      .filter(Boolean)
      .join("\n")
      .slice(0, 10000),
  };
}

async function processMaterialJob(
  job: Job<MaterialIngestionJobData>,
  runtime: MaterialIngestionRuntime,
  workerId: string,
) {
  try {
    return await runtime.process(job.data, workerId);
  } catch (error) {
    const failure = classifyIngestionError(error);
    if (!failure.retryable) throw new UnrecoverableError(`${failure.code}: ${failure.message}`);
    throw failure;
  }
}

async function reconcilePendingMaterialJobs(
  prisma: PrismaClient,
  queue: Queue<MaterialIngestionJobData>,
): Promise<void> {
  await scheduleMissingMaterialEmbeddings(prisma);
  const pending = await prisma.materialIngestionJob.findMany({
    orderBy: { createdAt: "asc" },
    take: 200,
    where: { status: "PENDING" },
  });
  for (const job of pending) {
    await queue.add(
      "ingest-material",
      {
        ingestionJobId: job.id,
        materialId: job.materialId,
        queueVersion: job.queueVersion,
        tenantId: job.tenantId,
      },
      {
        attempts: 5,
        backoff: { delay: 2_000, type: "exponential" },
        jobId: `material-${job.materialId}-q${job.queueVersion}`,
        removeOnComplete: { age: 86_400, count: 5_000 },
        removeOnFail: { age: 604_800, count: 10_000 },
      },
    );
  }
}

export async function scheduleMissingMaterialEmbeddings(
  prisma: PrismaClient,
  tenantId?: string,
): Promise<void> {
  const policy = await prisma.runtimePolicy.findUnique({ where: { id: "platform" } });
  if (!policy) return;
  let profileVersion = "deterministic-char-ngram-v1";
  if (policy.embeddingModelId) {
    const model = await prisma.modelDefinition.findFirst({
      select: {
        id: true,
        updatedAt: true,
        externalModelId: true,
        metadata: true,
        provider: { select: { baseUrl: true } },
      },
      where: {
        capabilities: { has: "EMBEDDING" },
        id: policy.embeddingModelId,
        provider: { status: "ACTIVE", synthetic: false },
        status: "ACTIVE",
        synthetic: false,
      },
    });
    if (!model) return;
    profileVersion = embeddingProfileVersion(model);
  }
  const candidates = await prisma.materialChunk.findMany({
    distinct: ["materialId"],
    orderBy: { createdAt: "asc" },
    select: {
      enterpriseId: true,
      materialId: true,
      scopeKey: true,
      tenantId: true,
      material: { select: { structuredFacts: true } },
    },
    take: 100,
    where: {
      embeddings: { none: { profileVersion } },
      material: {
        authorizationStatus: "AUTHORIZED",
        ingestionStatus: "READY",
        usabilityStatus: "USABLE",
        status: "ACTIVE",
      },
      tenantId,
    },
  });
  for (const candidate of candidates) {
    if (
      readMedicalMaterial(assetRecord(candidate.material.structuredFacts).medicalMaterial)
        ?.purpose === "ARCHIVE"
    )
      continue;
    try {
      await prisma.$transaction(
        async (transaction) => {
          const recent = await transaction.materialIngestionJob.findFirst({
            orderBy: { createdAt: "desc" },
            where: {
              materialId: candidate.materialId,
              parserVersion: `embedding-reindex:${profileVersion}`,
              purpose: "REINDEX",
            },
          });
          if (
            recent &&
            (new Set(["PENDING", "PROCESSING"]).has(recent.status) ||
              recent.createdAt > new Date(Date.now() - 15 * 60_000))
          ) {
            return;
          }
          const latest = await transaction.materialIngestionJob.aggregate({
            _max: { queueVersion: true },
            where: { materialId: candidate.materialId },
          });
          await transaction.materialIngestionJob.create({
            data: {
              enterpriseId: candidate.enterpriseId,
              materialId: candidate.materialId,
              parserVersion: `embedding-reindex:${profileVersion}`,
              purpose: "REINDEX",
              queueVersion: (latest._max.queueVersion ?? 0) + 1,
              scopeKey: candidate.scopeKey,
              tenantId: candidate.tenantId,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        new Set(["P2002", "P2034"]).has(error.code)
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function extractDocument(bytes: Uint8Array, declaredMime: string) {
  try {
    return await parseDocument(bytes, declaredMime);
  } catch (error) {
    if (error instanceof MaterialIngestionError) throw error;
    throw new MaterialIngestionError("DOCUMENT_PARSE_FAILED", false);
  }
}

async function parseDocument(bytes: Uint8Array, declaredMime: string) {
  assertMagic(bytes, declaredMime);
  if (declaredMime === "application/pdf") {
    const parser = new PDFParse({ data: Buffer.from(bytes) });
    try {
      const info = await parser.getInfo();
      if (info.total > MAX_PDF_PAGES) throw new MaterialIngestionError("PDF_PAGE_LIMIT", false);
      const result = await parser.getText();
      return extractedText(result.text, declaredMime, { pages: info.total });
    } finally {
      await parser.destroy();
    }
  }
  if (declaredMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return extractedText(result.value, declaredMime, { warnings: result.messages.length });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MaterialIngestionError("TEXT_ENCODING_UNSUPPORTED", false);
  }
  return extractedText(text, declaredMime, {});
}

async function extractImageReference(
  bytes: Uint8Array,
  declaredMime: string,
  material: Readonly<{
    content: string;
    structuredFacts: Prisma.JsonValue | null;
    tags: string[];
    title: string;
  }>,
) {
  let metadata: Awaited<ReturnType<sharp.Sharp["metadata"]>>;
  try {
    metadata = await sharp(bytes, { failOn: "error" }).metadata();
  } catch {
    throw new MaterialIngestionError("IMAGE_PARSE_FAILED", false);
  }
  const detectedMime = imageMime(metadata.format);
  if (detectedMime !== declaredMime) {
    throw new MaterialIngestionError("FILE_MAGIC_MISMATCH", false);
  }
  const facts = material.structuredFacts ? JSON.stringify(material.structuredFacts) : "";
  const searchable = [
    material.title,
    material.content,
    material.tags.join(" "),
    facts,
    `图片尺寸 ${metadata.width ?? 0}x${metadata.height ?? 0}`,
  ]
    .filter(Boolean)
    .join("\n");
  return extractedText(searchable, detectedMime, {
    format: metadata.format,
    height: metadata.height,
    width: metadata.width,
  });
}

function extractedText(text: string, mimeType: string, metadata: Record<string, unknown>) {
  const normalized = normalizeExtractedText(text);
  if (!normalized) throw new MaterialIngestionError("EMPTY_EXTRACTED_TEXT", false);
  if ([...normalized].length > MAX_EXTRACTED_CHARACTERS) {
    throw new MaterialIngestionError("EXTRACTED_TEXT_LIMIT", false);
  }
  return {
    artifactByteSize: undefined,
    artifactChecksum: undefined,
    artifactMetadata: metadata,
    metadata,
    mimeType,
    objectKey: undefined,
    storageReservationId: undefined,
    text: normalized,
  };
}

export async function fetchPublicSnapshot(initialUrl: string, maxBytes = MAX_LINK_BYTES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await withPublicHttpResponse(
      initialUrl,
      {
        headers: { "User-Agent": "XHS-Agentic-MaterialFetcher/1.0" },
        method: "GET",
        signal: controller.signal,
      },
      { ...materialPublicHttpOptions(), maxRedirects: 3 },
      async (response, finalUrl, redirects) => {
        if (!response.ok) {
          throw new MaterialIngestionError(`LINK_HTTP_${response.status}`, response.status >= 500);
        }
        const mimeType = normalizeMime(response.headers.get("content-type"));
        if (!mimeType || !new Set(["text/html", "text/plain", "text/markdown"]).has(mimeType)) {
          throw new MaterialIngestionError("LINK_CONTENT_TYPE_UNSUPPORTED", false);
        }
        const declaredLength = Number(response.headers.get("content-length") ?? 0);
        if (declaredLength > maxBytes) {
          throw new MaterialIngestionError("LINK_RESPONSE_TOO_LARGE", false);
        }
        const bytes = await readBoundedResponseBody(response, maxBytes);
        if (bytes.byteLength < 1) {
          throw new MaterialIngestionError("LINK_RESPONSE_TOO_LARGE", false);
        }
        return { bytes, finalUrl: finalUrl.toString(), mimeType, redirects };
      },
    );
  } catch (error) {
    if (error instanceof MaterialIngestionError) throw error;
    if (error instanceof PublicHttpPolicyError) throw materialNetworkPolicyError(error);
    if (error instanceof Error && error.name === "AbortError") {
      throw new MaterialIngestionError("LINK_FETCH_TIMEOUT", true);
    }
    throw new MaterialIngestionError("LINK_FETCH_NETWORK", true);
  } finally {
    clearTimeout(timer);
  }
}

export async function assertPublicHttpUrl(url: URL): Promise<{ address: string; family: number }> {
  try {
    const { address, family } = await resolvePublicHttpUrl(url, materialPublicHttpOptions());
    return { address, family };
  } catch (error) {
    if (error instanceof PublicHttpPolicyError) throw materialNetworkPolicyError(error);
    throw new MaterialIngestionError("LINK_DNS_EMPTY", true);
  }
}

function materialPublicHttpOptions(): Readonly<{ allowHttp: boolean; allowPrivate: boolean }> {
  return {
    allowHttp: process.env.NODE_ENV !== "production",
    allowPrivate:
      process.env.NODE_ENV === "test" &&
      process.env.MATERIAL_FETCH_ALLOW_PRIVATE_TEST_URLS === "true",
  };
}

function materialNetworkPolicyError(error: PublicHttpPolicyError): MaterialIngestionError {
  if (error.code === "PUBLIC_HTTP_REDIRECT_FORBIDDEN") {
    return new MaterialIngestionError("LINK_REDIRECT_LIMIT", false);
  }
  if (error.code === "PUBLIC_HTTP_DNS_EMPTY" || error.code === "PUBLIC_HTTP_DNS_FAILED") {
    return new MaterialIngestionError("LINK_DNS_EMPTY", true);
  }
  if (error.code === "PUBLIC_HTTP_DNS_PRIVATE" || error.code === "PUBLIC_HTTP_HOST_PRIVATE") {
    return new MaterialIngestionError("LINK_URL_PRIVATE", false);
  }
  return new MaterialIngestionError("LINK_URL_UNSAFE", false);
}

async function readBoundedResponseBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteSize += chunk.value.byteLength;
      if (byteSize > limit) {
        await reader.cancel();
        throw new MaterialIngestionError("LINK_RESPONSE_TOO_LARGE", false);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseLinkSnapshot(bytes: Uint8Array, mimeType: string): string {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (mimeType !== "text/html") return source;
  const $ = load(source);
  $("script,style,noscript,svg,iframe").remove();
  return $("main,article").first().text() || $("body").text();
}

export function chunkText(text: string, maxCharacters: number, overlapCharacters: number) {
  const units = [...text];
  const chunks: Array<{ end: number; ordinal: number; start: number; text: string }> = [];
  let start = 0;
  while (start < units.length) {
    let end = Math.min(units.length, start + maxCharacters);
    if (end < units.length) {
      const window = units.slice(start, end).join("");
      const boundary = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
      );
      if (boundary >= Math.floor(maxCharacters * 0.55)) end = start + boundary + 1;
    }
    const value = units.slice(start, end).join("").trim();
    if (value) chunks.push({ end, ordinal: chunks.length, start, text: value });
    if (end >= units.length) break;
    start = Math.max(start + 1, end - overlapCharacters);
  }
  return chunks;
}

function normalizeExtractedText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function assertMagic(bytes: Uint8Array, mimeType: string): void {
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (mimeType === "application/pdf" && !pdf)
    throw new MaterialIngestionError("FILE_MAGIC_MISMATCH", false);
  if (mimeType.includes("wordprocessingml") && !zip)
    throw new MaterialIngestionError("FILE_MAGIC_MISMATCH", false);
}

function imageMime(format?: string): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  throw new MaterialIngestionError("IMAGE_FORMAT_UNSUPPORTED", false);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function approximateTokenCount(value: string): number {
  return Math.max(1, Math.ceil([...value].length / 2));
}

function normalizeMime(value?: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    db: Number(url.pathname.slice(1) || 0),
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: Number(url.port || 6379),
    username: decodeURIComponent(url.username),
  };
}

function workerLog(
  level: "error" | "info",
  event: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  writeStructuredLog({ event, fields, level, service: "worker" });
}
