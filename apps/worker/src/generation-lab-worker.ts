import { createHash, randomUUID } from "node:crypto";
import {
  type GenerationLabInput,
  labCost,
  ModelRoutingError,
  medicalPublisherFor,
  medicalPublishingSafetyContext,
  readMedicalPlan,
} from "@xhs-agentic/ai-gateway";
import {
  CONTENT_SAFETY_INSTRUCTIONS,
  createContentSafetyScanner,
} from "@xhs-agentic/content-safety";
import { type Prisma, PrismaClient } from "@xhs-agentic/database";
import { createObjectStorage } from "@xhs-agentic/object-storage";
import { writeStructuredLog } from "@xhs-agentic/observability";
import { sanitizeVariant } from "./generation-runtime";
import { renderMedicalOriginal, renderMedicalQuestionCard } from "./medical-images";
import { loadWorkerPlatformSettings } from "./platform-settings";
import { composePoster, loadPosterAssets } from "./poster-assets";
import {
  createRoutedAdapter,
  type FrozenRoute,
  type InvocationObserver,
  modelPricing,
} from "./routed-generation";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Durable DB queue: expired claims terminate; paid calls are never replayed automatically. */
export async function processLabTick(prisma: PrismaClient) {
  await prisma.generationLabRun.updateMany({
    where: { status: "CHECKING", updatedAt: { lt: new Date(Date.now() - 600_000) } },
    data: { status: "FAILED", error: "素材检查中断，未自动重试，请新建测试；检索费用可能已发生" },
  });
  const stale = new Date(Date.now() - 120_000);
  await prisma.generationLabRun.updateMany({
    where: { status: "RUNNING", heartbeatAt: { lt: stale } },
    data: {
      status: "INTERRUPTED",
      leaseToken: null,
      error: "执行中断，供应商可能已计费；未自动重试，请检查调用记录后复制版本",
    },
  });
  await prisma.generationLabRun.updateMany({
    where: { reviewStatus: "RUNNING", heartbeatAt: { lt: stale } },
    data: {
      reviewStatus: "INTERRUPTED",
      leaseToken: null,
      review: { message: "审核中断，未自动重试，费用可能已发生" },
    },
  });
  const pending = await prisma.generationLabRun.findFirst({
    where: { OR: [{ status: "QUEUED" }, { reviewStatus: "QUEUED" }] },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) return;
  const reviewing = pending.reviewStatus === "QUEUED";
  const token = randomUUID();
  const changed = await prisma.generationLabRun.updateMany({
    where: { id: pending.id, ...(reviewing ? { reviewStatus: "QUEUED" } : { status: "QUEUED" }) },
    data: {
      ...(reviewing ? { reviewStatus: "RUNNING" } : { status: "RUNNING" }),
      leaseToken: token,
      heartbeatAt: new Date(),
    },
  });
  if (!changed.count) return;
  const owned = {
    id: pending.id,
    leaseToken: token,
    ...(reviewing ? { reviewStatus: "RUNNING" } : { status: "RUNNING" }),
  };
  const heartbeat = async () => {
    const current = await prisma.generationLabRun.updateMany({
      where: owned,
      data: { heartbeatAt: new Date() },
    });
    if (!current.count) throw new Error("LAB_LEASE_LOST");
  };
  const timer = setInterval(() => void heartbeat().catch(() => undefined), 15_000);
  timer.unref();
  try {
    const enterprise = await prisma.enterprise.findFirst({
      where: {
        id: pending.enterpriseId,
        tenantId: pending.tenantId,
        status: "ACTIVE",
        tenant: { status: "ACTIVE" },
      },
    });
    if (!enterprise) throw new Error("LAB_ENTERPRISE_UNAVAILABLE");
    const input = pending.input as unknown as GenerationLabInput;
    const medicalPlan = readMedicalPlan(input.medicalPlan);
    const firstPublisher = medicalPlan?.publishers[0];
    const medicalPublisher =
      medicalPlan && firstPublisher
        ? medicalPublisherFor(medicalPlan, firstPublisher.membershipId)
        : undefined;
    const settings = await loadWorkerPlatformSettings(prisma);
    const stored = await prisma.generationLabAsset.findMany({ where: { runId: pending.id } });
    if (reviewing) {
      if (settings.contentSafety.mode === "DISABLED" || !settings.contentSafety.verified)
        throw new Error("LAB_REVIEW_NOT_CONFIGURED");
      const scanner = createContentSafetyScanner(
        settings.contentSafety,
        process.env.NODE_ENV === "production",
      );
      const poster = stored.find((a) => a.kind === "POSTER");
      const result = pending.result as {
        copy?: GenerationLabInput["copy"];
        localAssessment?: { warnings?: string[] };
      } | null;
      if (!scanner || !poster || !result?.copy) throw new Error("LAB_REVIEW_INPUT_MISSING");
      const reviewModel =
        settings.contentSafety.mode === "MODEL"
          ? await prisma.modelDefinition.findFirst({
              where: {
                externalModelId: settings.contentSafety.model,
                provider: { code: settings.contentSafety.provider },
              },
              select: { metadata: true },
            })
          : null;
      const pricing = modelPricing(reviewModel?.metadata ?? null);
      await heartbeat();
      const call = await prisma.generationLabCall.create({
        data: {
          runId: pending.id,
          kind: "REVIEW",
          providerId: settings.contentSafety.provider,
          modelId: settings.contentSafety.mode === "MODEL" ? settings.contentSafety.model : "HTTP",
          request: json({
            instructions:
              settings.contentSafety.mode === "MODEL" ? CONTENT_SAFETY_INSTRUCTIONS : null,
            text: result.copy,
            sourceFacts: input.materialSummary.slice(0, 12000),
            image: { assetId: poster.id, checksum: poster.checksum },
            pricing,
          }),
        },
      });
      const started = Date.now();
      try {
        const review = await scanner.scan({
          publishingContext:
            medicalPlan && medicalPublisher
              ? medicalPublishingSafetyContext(medicalPlan, medicalPublisher)
              : undefined,
          requestId: `lab:${pending.id}:review`,
          text: result.copy,
          sourceFacts: input.materialSummary,
          images: [
            { bytes: poster.bytes, checksum: poster.checksum, mimeType: "image/png", sequence: 1 },
          ],
        });
        await prisma.generationLabCall.update({
          where: { id: call.id },
          data: {
            status: "SUCCEEDED",
            latencyMs: Date.now() - started,
            usage: json({
              ...review.usage,
              providerRequestId: review.providerRequestId,
              estimatedCost: labCost(pricing, "TEXT", review.usage),
              note: "按审核模型配置价格估算；缺少价格或用量时费用未知",
            }),
          },
        });
        await prisma.generationLabRun.updateMany({
          where: owned,
          data: {
            reviewStatus: "DONE",
            review: json(
              review.decision === "PASS" && result.localAssessment?.warnings?.length
                ? {
                    ...review,
                    decision: "REVIEW",
                    categories: [
                      ...review.categories,
                      {
                        code: "LOCAL_RULE_WARNING",
                        message: "本地规则仍有警告，请人工确认",
                        decision: "REVIEW",
                      },
                    ],
                  }
                : review,
            ),
            leaseToken: null,
          },
        });
      } catch (error) {
        await prisma.generationLabCall.update({
          where: { id: call.id },
          data: {
            status: "FAILED",
            latencyMs: Date.now() - started,
            error: labError(error),
            usage: { estimatedCost: null },
          },
        });
        throw error;
      }
      return;
    }
    const route = input.route as FrozenRoute;
    if (route.synthetic) throw new Error("LAB_REAL_MODEL_REQUIRED");
    // Reassert the budget boundary even for old/malformed saved records.
    route.maxAttemptsPerModel = 1;
    route.text.fallbacks = [];
    route.image.fallbacks = [];
    const observer: InvocationObserver = async (request, execute) => {
      await heartbeat();
      const references =
        "referenceImages" in request.request ? request.request.referenceImages : undefined;
      const call = await prisma.generationLabCall.create({
        data: {
          runId: pending.id,
          kind: request.kind,
          providerId: request.providerId,
          modelId: request.modelId,
          request: json({
            ...request.request,
            referenceImages: references?.map(({ bytes, ...rest }) => ({
              ...rest,
              checksum: checksum(bytes),
              byteLength: bytes.length,
            })),
            pricing: request.pricing,
          }),
        },
      });
      const started = Date.now();
      try {
        const output = await execute();
        const receipt = output as {
          usage?: { inputUnits?: number; outputUnits?: number };
          providerRequestId?: string;
          text?: string;
        };
        await prisma.generationLabCall.update({
          where: { id: call.id },
          data: {
            status: "SUCCEEDED",
            latencyMs: Date.now() - started,
            usage: json({
              ...receipt.usage,
              estimatedCost: labCost(request.pricing, request.kind, receipt.usage),
              providerRequestId: receipt.providerRequestId,
              text: receipt.text,
              currency: "provider-configured",
            }),
          },
        });
        await heartbeat();
        return output;
      } catch (error) {
        await prisma.generationLabCall.update({
          where: { id: call.id },
          data: {
            status: "FAILED",
            latencyMs: Date.now() - started,
            error: labError(error),
            usage: { estimatedCost: null },
          },
        });
        throw error;
      }
    };
    const requiresImage = !medicalPlan || medicalPlan.imageMode === "ILLUSTRATION";
    const adapter =
      pending.action !== "IMAGE" || requiresImage
        ? (
            await createRoutedAdapter(
              prisma,
              pending.id,
              route,
              observer,
              undefined,
              undefined,
              requiresImage,
            )
          ).adapter
        : undefined;
    const context = {
      tenantId: pending.tenantId,
      enterpriseId: pending.enterpriseId,
      generationRunId: pending.id,
    };
    let copy = input.copy;
    if (pending.action !== "IMAGE") {
      if (!adapter) throw new Error("LAB_ADAPTER_MISSING");
      const blueprint = await adapter.generateBlueprint(context, {
        medicalPlan,
        generationStyle: input.generationStyle,
        geoSummary: input.geoSummary,
        materialSummary: input.materialSummary,
        industryGuidance: input.industryGuidance,
        sensitiveRuleSummary: input.sensitiveRuleSummary,
        prompt: input.brief,
        sourceContext: input.sourceContext,
        title: pending.title,
      });
      const generated = await adapter.generateEmployeeVariant(context, blueprint.result, {
        medicalPublisher,
        employeeOrdinal: 1,
        title: pending.title,
        uniquenessSeed: input.seed,
      });
      copy = generated.result;
    }
    if (!copy) throw new Error("LAB_COPY_MISSING");
    const sanitized = sanitizeVariant(
      { ...copy, hashtags: [...copy.hashtags] },
      input.sensitiveRules ?? [],
    );
    copy = sanitized.variant;
    // Preserve completed copy when a later image call fails.
    await prisma.generationLabRun.updateMany({
      where: owned,
      data: { result: json({ copy, localAssessment: sanitized.riskAssessment }) },
    });
    if (pending.action !== "COPY") {
      const storage = createObjectStorage(settings.storage);
      const assets = await loadPosterAssets(
        prisma,
        storage,
        pending.tenantId,
        input.imageAssets,
        Boolean(medicalPlan),
      );
      const references = [
        ...assets.filter((a) => a.usage === "REFERENCE"),
        ...stored.filter((a) => a.kind === "REFERENCE"),
      ];
      if (references.length > 3) throw new Error("LAB_TOO_MANY_REFERENCES");
      const logo = medicalPlan ? undefined : assets.find((a) => a.usage === "LOGO");
      const localBytes =
        medicalPlan?.imageMode === "ORIGINAL_EDIT"
          ? await renderMedicalOriginal(
              assets.filter((asset) => asset.usage === "REFERENCE"),
              1,
            )
          : medicalPlan?.imageMode === "QUESTION_CARD"
            ? await renderMedicalQuestionCard(medicalPlan, copy, 1)
            : undefined;
      if (!localBytes && !adapter) throw new Error("LAB_ADAPTER_MISSING");
      const generated = localBytes
        ? undefined
        : await adapter?.generateImage(context, {
            medicalPlan,
            medicalPublisher,
            imageSequence: 1,
            generationStyle: input.generationStyle,
            height: 1440,
            width: 1080,
            prompt: copy.imagePrompt,
            campaignBrief: input.brief,
            materialSummary: input.materialSummary,
            industryGuidance: input.industryGuidance,
            finalCopy: copy,
            seed: input.seed,
            referenceImages: references.map((a) => ({
              bytes: a.bytes,
              description: a.description,
              mimeType: a.mimeType,
            })),
            reserveLogoSpace: Boolean(logo),
          });
      const imageBytes = localBytes ?? generated?.output.bytes;
      if (!imageBytes) throw new Error("LAB_IMAGE_MISSING");
      const bytes = await composePoster(imageBytes, logo?.bytes);
      if (bytes.length > 12 * 1024 * 1024) throw new Error("LAB_POSTER_TOO_LARGE");
      await prisma.$transaction(async (tx) => {
        const updated = await tx.generationLabRun.updateMany({
          where: owned,
          data: {
            status: "SUCCEEDED",
            leaseToken: null,
            result: json({
              copy,
              localAssessment: sanitized.riskAssessment,
              logo: logo
                ? {
                    artifactId: logo.artifactId,
                    checksum: logo.checksum,
                    composition: "原图等比缩放，左上角合成；未传入模型",
                  }
                : null,
              referenceChecksums: references.map((a) => a.checksum),
              width: 1080,
              height: 1440,
              productionMode: medicalPlan?.imageMode ?? "AI_POSTER",
              imageProviderCalled: Boolean(generated),
              imageProviderCost: localBytes ? 0 : undefined,
            }),
          },
        });
        if (!updated.count) throw new Error("LAB_LEASE_LOST");
        await tx.generationLabAsset.create({
          data: {
            runId: pending.id,
            kind: "POSTER",
            bytes: new Uint8Array(bytes),
            checksum: checksum(bytes),
            description: medicalPlan ? "医疗问题配图测试" : "测试海报",
            mimeType: "image/png",
          },
        });
      });
    } else
      await prisma.generationLabRun.updateMany({
        where: owned,
        data: { status: "SUCCEEDED", leaseToken: null },
      });
  } catch (error) {
    await prisma.generationLabRun.updateMany({
      where: owned,
      data: reviewing
        ? { reviewStatus: "FAILED", review: { message: labError(error) }, leaseToken: null }
        : { status: "FAILED", error: labError(error), leaseToken: null },
    });
  } finally {
    clearInterval(timer);
  }
}

export function labError(error: unknown): string {
  // Provider messages can contain credentials or signed URLs; persist only bounded safe codes.
  const code =
    error instanceof ModelRoutingError
      ? error.attempts.at(-1)?.errorCode
      : typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error && /^LAB_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "LAB_EXECUTION_FAILED";
  return `测试未完成（${/^[A-Z0-9_]{1,80}$/u.test(code ?? "") ? code : "LAB_EXECUTION_FAILED"}）。未自动重试，请检查配置或复制版本后再试。`;
}

export async function startGenerationLabWorker() {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = () => {
    if (stopped || active) return;
    active = processLabTick(prisma)
      .catch((error) => {
        writeStructuredLog({
          level: "error",
          service: "worker",
          event: "generation-lab.tick-failed",
          fields: { code: labError(error) },
        });
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 3000);
  timer.unref();
  tick();
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      await active;
      await prisma.$disconnect();
    },
  };
}
