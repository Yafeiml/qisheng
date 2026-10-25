import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { EnvironmentCredentialResolver } from "../credential-resolver";
import { ModelRoutingError } from "../errors";
import {
  type GeneratedCampaignBlueprint,
  RoutedGenerationAdapter,
  type TextGenerationStep,
} from "../generation-adapter";
import { differenceHash, hashSimilarity } from "../image-similarity";
import { ModelRouter } from "../model-router";
import { createRuntimeProvider } from "../provider-factory";
import type { InvocationAttempt } from "../types";
import { createRealProviderReviewTemplate } from "./real-provider-review";
import { createRealProviderReviewHtml } from "./real-provider-review-page";

const IMAGE_WIDTH = 1080;
const IMAGE_HEIGHT = 1440;
const PROMPT_TEMPLATE_VERSION = "xhs-full-femto-pro-v3-diverse-no-text-image";

type BenchmarkStage = "BLUEPRINT" | "EMPLOYEE_COPY" | "EMPLOYEE_IMAGE";

interface BenchmarkConfiguration {
  baseUrl: string;
  concurrency: number;
  count: number;
  costCurrency: string;
  imageCost: number;
  imageModel: string;
  inputCost: number;
  minimumManualPassRate: number;
  minimumSuccessRate: number;
  outputCost: number;
  outputDirectory: string;
  preflightOnly: boolean;
  pricingComplete: boolean;
  providerId: string;
  similarityThreshold: number;
  textModel: string;
  timeoutMs: number;
}

interface BenchmarkFailure {
  copyAttempts: readonly InvocationAttempt[];
  employeeMembershipId?: string;
  error: string;
  imageAttempts: readonly InvocationAttempt[];
  stage: BenchmarkStage;
}

interface SuccessfulItem {
  copy: {
    attempts: readonly InvocationAttempt[];
    body: string;
    cost: number;
    hashtags: readonly string[];
    imagePrompt: string;
    latencyMs: number;
    model: string;
    provider: string;
    title: string;
  };
  cost: number;
  employeeMembershipId: string;
  image: {
    attempts: readonly InvocationAttempt[];
    checksum: string;
    cost: number;
    height: number;
    imagePath: string;
    latencyMs: number;
    mimeType: string;
    model: string;
    perceptualHash: string;
    provider: string;
    seed: string;
    sourceHeight: number;
    sourceWidth: number;
    width: number;
  };
  latencyMs: number;
}

async function run(): Promise<void> {
  const configuration = loadConfiguration();
  const credentials = new EnvironmentCredentialResolver();
  const provider = await createRuntimeProvider(
    {
      baseUrl: configuration.baseUrl,
      credentialRef: "env://PILOT_BENCHMARK_API_KEY",
      id: configuration.providerId,
      modelPricing: {
        [configuration.imageModel]: { imageCost: configuration.imageCost },
        [configuration.textModel]: {
          inputCostPerMillionUnits: configuration.inputCost,
          outputCostPerMillionUnits: configuration.outputCost,
        },
      },
      protocol: "OPENAI_COMPATIBLE",
      synthetic: false,
      timeoutMs: configuration.timeoutMs,
    },
    credentials,
  );
  if (configuration.preflightOnly) {
    process.stdout.write(
      `${JSON.stringify(
        {
          apiKeyConfigured: true,
          baseUrl: configuration.baseUrl,
          concurrency: configuration.concurrency,
          costCurrency: configuration.costCurrency,
          imageModel: configuration.imageModel,
          memberCount: configuration.count,
          preflight: true,
          pricingComplete: configuration.pricingComplete,
          providerId: configuration.providerId,
          ready: true,
          synthetic: false,
          textModel: configuration.textModel,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  await mkdir(configuration.outputDirectory, { recursive: true });
  const benchmarkStartedAt = new Date();
  const benchmarkStarted = performance.now();
  const benchmarkId =
    "real-" +
    safeIdentifier(configuration.providerId) +
    "-" +
    safeIdentifier(configuration.imageModel) +
    "-" +
    benchmarkStartedAt.getTime();
  const router = new ModelRouter([provider.text], [provider.image]);
  const textBase = {
    fallbackModels: [],
    kind: "TEXT" as const,
    maxAttemptsPerModel: 2,
    primaryModel: {
      modelId: configuration.textModel,
      providerId: configuration.providerId,
    },
    scopeType: "PLATFORM" as const,
    version: 1,
  };
  const adapter = new RoutedGenerationAdapter(router, {
    blueprint: router.freezePolicy({
      ...textBase,
      id: "real-provider-blueprint",
      taskKind: "CAMPAIGN_BLUEPRINT",
    }),
    employeeCopy: router.freezePolicy({
      ...textBase,
      id: "real-provider-copy",
      taskKind: "EMPLOYEE_COPY",
    }),
    employeeImage: router.freezePolicy({
      fallbackModels: [],
      id: "real-provider-image",
      kind: "IMAGE",
      maxAttemptsPerModel: 2,
      primaryModel: {
        modelId: configuration.imageModel,
        providerId: configuration.providerId,
      },
      scopeType: "PLATFORM",
      taskKind: "EMPLOYEE_IMAGE",
      version: 1,
    }),
  });
  const context = {
    campaignId: "pilot-real-benchmark",
    enterpriseId: "pilot-enterprise",
    generationRunId: `real-${Date.now()}`,
    tenantId: "pilot-tenant",
  };
  const source = {
    geoSummary: "全飞秒 Pro（技术）；专业设备（设备）；规范术前评估（服务）",
    materialSummary:
      "已授权测试事实：专业设备、规范术前评估和个体差异均是沟通时需要说明的信息，不得承诺绝对效果。",
    prompt: "生成全飞秒 Pro 小红书风格科普，侧重设备、流程和理性决策。",
    sensitiveRuleSummary: "禁止绝对治愈、百分百、安全无风险等绝对承诺。",
    sourceContext: {
      benchmark: true,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      synthetic: false,
    },
    title: "全飞秒 Pro 技术分享",
  };

  let blueprint: TextGenerationStep<GeneratedCampaignBlueprint>;
  const blueprintStarted = performance.now();
  try {
    blueprint = await adapter.generateBlueprint(context, source);
  } catch (error) {
    const failure = createFailure("BLUEPRINT", error);
    const report = {
      automatedGate: { errors: ["Campaign blueprint generation failed"], passed: false },
      benchmarkId,
      completedAt: new Date().toISOString(),
      concurrency: configuration.concurrency,
      cost: {
        currency: configuration.costCurrency,
        pricingComplete: configuration.pricingComplete,
        total: attemptCost(failure.copyAttempts),
      },
      failures: [failure],
      imageModel: configuration.imageModel,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      providerId: configuration.providerId,
      requested: configuration.count,
      status: "AUTOMATED_GATE_FAILED",
      success: 0,
      synthetic: false,
      textModel: configuration.textModel,
    };
    await Promise.all([
      writeJson(resolve(configuration.outputDirectory, "report.json"), report),
      writeJson(resolve(configuration.outputDirectory, "results.json"), {
        benchmarkId,
        failures: [failure],
        items: [],
        synthetic: false,
      }),
    ]);
    process.stdout.write(
      `${JSON.stringify({ outputDirectory: configuration.outputDirectory, ...report }, null, 2)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const blueprintLatencyMs = performance.now() - blueprintStarted;

  const failures: BenchmarkFailure[] = [];
  const items = await parallelMap(
    Array.from({ length: configuration.count }, (_, index) => index + 1),
    configuration.concurrency,
    async (ordinal): Promise<SuccessfulItem | undefined> => {
      const employeeMembershipId = `membership-${ordinal.toString().padStart(3, "0")}`;
      const itemStartedAt = performance.now();
      const copyStartedAt = performance.now();
      let copy: Awaited<ReturnType<RoutedGenerationAdapter["generateEmployeeVariant"]>>;
      try {
        copy = await adapter.generateEmployeeVariant(context, blueprint.result, {
          employeeOrdinal: ordinal,
          title: source.title,
          uniquenessSeed: employeeMembershipId,
        });
      } catch (error) {
        failures.push(createFailure("EMPLOYEE_COPY", error, employeeMembershipId));
        return undefined;
      }
      const copyLatencyMs = performance.now() - copyStartedAt;
      const imageSeed = `${employeeMembershipId}:${context.generationRunId}`;
      const imageStartedAt = performance.now();
      let imageAttempts: readonly InvocationAttempt[] = [];
      try {
        const image = await adapter.generateImage(context, {
          materialSummary: source.materialSummary,
          industryGuidance: blueprint.result.industryGuidance,
          height: IMAGE_HEIGHT,
          prompt: copy.result.imagePrompt,
          seed: imageSeed,
          width: IMAGE_WIDTH,
        });
        imageAttempts = image.attempts;
        const sourceMetadata = await sharp(image.output.bytes).metadata();
        const sourceMimeType = mimeTypeForSharpFormat(sourceMetadata.format);
        if (!sourceMimeType || !sourceMetadata.width || !sourceMetadata.height) {
          throw new Error("Provider image could not be decoded as PNG, JPEG or WebP");
        }
        const normalizedBytes = await sharp(image.output.bytes)
          .rotate()
          .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: "cover", position: "attention" })
          .png({ compressionLevel: 9, quality: 95 })
          .toBuffer();
        const metadata = await sharp(normalizedBytes).metadata();
        if (metadata.format !== "png" || !metadata.width || !metadata.height) {
          throw new Error("Provider image could not be normalized to the delivery format");
        }
        const mimeType = "image/png";
        const extension = extensionFor(mimeType);
        const filename = `${employeeMembershipId}.${extension}`;
        const checksum = createHash("sha256").update(normalizedBytes).digest("hex");
        const perceptualHash = await differenceHash(normalizedBytes);
        await writeFile(resolve(configuration.outputDirectory, filename), normalizedBytes);
        const copyCost = attemptCost(copy.routing.attempts);
        const imageCost = attemptCost(image.attempts);
        return {
          copy: {
            attempts: copy.routing.attempts,
            body: copy.result.body,
            cost: copyCost,
            hashtags: copy.result.hashtags,
            imagePrompt: copy.result.imagePrompt,
            latencyMs: copyLatencyMs,
            model: copy.routing.modelId,
            provider: copy.routing.providerId,
            title: copy.result.title,
          },
          cost: copyCost + imageCost,
          employeeMembershipId,
          image: {
            attempts: image.attempts,
            checksum,
            cost: imageCost,
            height: metadata.height,
            imagePath: `./${filename}`,
            latencyMs: performance.now() - imageStartedAt,
            mimeType,
            model: image.modelId,
            perceptualHash,
            provider: image.providerId,
            seed: imageSeed,
            sourceHeight: sourceMetadata.height,
            sourceWidth: sourceMetadata.width,
            width: metadata.width,
          },
          latencyMs: performance.now() - itemStartedAt,
        };
      } catch (error) {
        failures.push({
          ...createFailure("EMPLOYEE_IMAGE", error, employeeMembershipId),
          copyAttempts: copy.routing.attempts,
          imageAttempts: imageAttempts.length > 0 ? imageAttempts : attemptsFromError(error),
        });
        return undefined;
      }
    },
  );
  const successes = items.filter((item): item is SuccessfulItem => Boolean(item));
  const candidatePairs = candidateSimilarities(successes, configuration.similarityThreshold);
  const checksumCount = new Set(successes.map((item) => item.image.checksum)).size;
  const perceptualHashCount = new Set(successes.map((item) => item.image.perceptualHash)).size;
  const itemLatencies = successes.map((item) => item.latencyMs).sort((a, b) => a - b);
  const copyLatencies = successes.map((item) => item.copy.latencyMs).sort((a, b) => a - b);
  const imageLatencies = successes.map((item) => item.image.latencyMs).sort((a, b) => a - b);
  const copyAttempts = [
    ...successes.flatMap((item) => item.copy.attempts),
    ...failures.flatMap((failure) => failure.copyAttempts),
  ];
  const imageAttempts = [
    ...successes.flatMap((item) => item.image.attempts),
    ...failures.flatMap((failure) => failure.imageAttempts),
  ];
  const allAttempts = [...blueprint.routing.attempts, ...copyAttempts, ...imageAttempts];
  const successRate = successes.length / configuration.count;
  const automatedErrors: string[] = [];
  if (successes.length < 100) {
    automatedErrors.push("Formal acceptance requires at least 100 successful employee packages");
  }
  if (successRate < configuration.minimumSuccessRate) {
    automatedErrors.push(
      "Success rate " +
        successRate.toFixed(4) +
        " is below " +
        configuration.minimumSuccessRate.toFixed(4),
    );
  }
  if (checksumCount !== successes.length) {
    automatedErrors.push("Generated images contain exact byte duplicates");
  }
  if (perceptualHashCount !== successes.length) {
    automatedErrors.push("Generated images contain identical perceptual hashes");
  }
  if (!configuration.pricingComplete) {
    automatedErrors.push("Provider pricing is incomplete; total cost cannot be accepted");
  }

  const blueprintCost = attemptCost(blueprint.routing.attempts);
  const copyCost = attemptCost(copyAttempts);
  const imageCost = attemptCost(imageAttempts);
  const totalCost = blueprintCost + copyCost + imageCost;
  const maximumSimilarity = maximumPairSimilarity(successes);
  const report = {
    automatedGate: {
      errors: automatedErrors,
      passed: automatedErrors.length === 0,
    },
    benchmarkId,
    completedAt: new Date().toISOString(),
    concurrency: configuration.concurrency,
    cost: {
      blueprint: blueprintCost,
      copy: copyCost,
      currency: configuration.costCurrency,
      image: imageCost,
      perSuccessfulPackage: successes.length === 0 ? 0 : totalCost / successes.length,
      pricingComplete: configuration.pricingComplete,
      total: totalCost,
    },
    failures,
    image: {
      candidatePairCount: candidatePairs.length,
      candidatePairs,
      checksumUniqueCount: checksumCount,
      heightRequested: IMAGE_HEIGHT,
      maximumPerceptualSimilarity: maximumSimilarity,
      sourceDimensions: countSourceDimensions(successes),
      perceptualHashUniqueCount: perceptualHashCount,
      similarityThreshold: configuration.similarityThreshold,
      widthRequested: IMAGE_WIDTH,
    },
    imageModel: configuration.imageModel,
    invocation: {
      attempts: allAttempts.length,
      failedAttempts: allAttempts.filter((attempt) => attempt.status === "FAILED").length,
      failureCodes: countFailureCodes(allAttempts),
      successfulAttempts: allAttempts.filter((attempt) => attempt.status === "SUCCEEDED").length,
    },
    latencyMs: {
      blueprint: blueprintLatencyMs,
      copyP50: percentile(copyLatencies, 0.5),
      copyP95: percentile(copyLatencies, 0.95),
      imageP50: percentile(imageLatencies, 0.5),
      imageP95: percentile(imageLatencies, 0.95),
      packageP50: percentile(itemLatencies, 0.5),
      packageP95: percentile(itemLatencies, 0.95),
      total: performance.now() - benchmarkStarted,
    },
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    providerId: configuration.providerId,
    qualityReview: {
      artifact: "manual-review.json",
      criteriaVersion: "xhs-pilot-quality-v1",
      minimumPassRate: configuration.minimumManualPassRate,
      required: true,
      status: "PENDING",
      templateArtifact: "manual-review.template.json",
      visualIndexArtifact: "review.html",
    },
    requested: configuration.count,
    startedAt: benchmarkStartedAt.toISOString(),
    status: automatedErrors.length === 0 ? "AWAITING_MANUAL_REVIEW" : "AUTOMATED_GATE_FAILED",
    success: successes.length,
    successRate,
    synthetic: false,
    textModel: configuration.textModel,
  };
  const results = {
    benchmarkId,
    blueprint: {
      attempts: blueprint.routing.attempts,
      cost: blueprintCost,
      imageDirection: blueprint.result.imageDirection,
      latencyMs: blueprintLatencyMs,
      masterCopy: blueprint.result.masterCopy,
      model: blueprint.routing.modelId,
      provider: blueprint.routing.providerId,
    },
    failures,
    items: successes,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    source,
    synthetic: false,
  };
  const reviewTargets = successes.map((item) => ({
    employeeMembershipId: item.employeeMembershipId,
    imagePath: item.image.imagePath,
    title: item.copy.title,
  }));
  await Promise.all([
    writeJson(resolve(configuration.outputDirectory, "report.json"), report),
    writeJson(resolve(configuration.outputDirectory, "results.json"), results),
    writeJson(resolve(configuration.outputDirectory, "image-manifest.json"), {
      benchmarkId,
      entries: successes.map((item) => ({
        checksum: item.image.checksum,
        cost: item.image.cost,
        employeeMembershipId: item.employeeMembershipId,
        height: item.image.height,
        imagePath: item.image.imagePath,
        latencyMs: item.image.latencyMs,
        mimeType: item.image.mimeType,
        model: item.image.model,
        perceptualHash: item.image.perceptualHash,
        provider: item.image.provider,
        seed: item.image.seed,
        sourceHeight: item.image.sourceHeight,
        sourceWidth: item.image.sourceWidth,
        width: item.image.width,
      })),
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      synthetic: false,
    }),
    writeJson(
      resolve(configuration.outputDirectory, "manual-review.template.json"),
      createRealProviderReviewTemplate(benchmarkId, reviewTargets),
    ),
    writeFile(
      resolve(configuration.outputDirectory, "review.html"),
      createRealProviderReviewHtml(benchmarkId, successes),
    ),
  ]);
  process.stdout.write(
    `${JSON.stringify({ outputDirectory: configuration.outputDirectory, ...report }, null, 2)}\n`,
  );
  if (automatedErrors.length > 0) process.exitCode = 2;
}

function loadConfiguration(): BenchmarkConfiguration {
  const count = positiveInteger(process.env.PILOT_BENCHMARK_MEMBER_COUNT ?? "100");
  if (count < 100 && process.env.PILOT_BENCHMARK_ALLOW_SMALL !== "true") {
    throw new Error("Real provider benchmark requires at least 100 members");
  }
  const pricingVariables = [
    "PILOT_BENCHMARK_INPUT_COST",
    "PILOT_BENCHMARK_OUTPUT_COST",
    "PILOT_BENCHMARK_IMAGE_COST",
  ] as const;
  const missingPricing = pricingVariables.filter(
    (name) => !process.env[name] || process.env[name]?.trim() === "",
  );
  const allowUnknownCost = process.env.PILOT_BENCHMARK_ALLOW_UNKNOWN_COST === "true";
  if (missingPricing.length > 0 && !allowUnknownCost) {
    throw new Error(
      "Missing provider pricing: " +
        missingPricing.join(", ") +
        ". Set PILOT_BENCHMARK_ALLOW_UNKNOWN_COST=true only for a non-acceptance smoke run.",
    );
  }
  const baseUrl = validateBaseUrl(requiredEnv("PILOT_BENCHMARK_BASE_URL"));
  return {
    baseUrl,
    concurrency: positiveInteger(process.env.PILOT_BENCHMARK_CONCURRENCY ?? "2"),
    costCurrency: costCurrency(process.env.PILOT_BENCHMARK_COST_CURRENCY ?? "CNY"),
    count,
    imageCost: nonNegativeNumber(process.env.PILOT_BENCHMARK_IMAGE_COST),
    imageModel: requiredEnv("PILOT_BENCHMARK_IMAGE_MODEL"),
    inputCost: nonNegativeNumber(process.env.PILOT_BENCHMARK_INPUT_COST),
    minimumManualPassRate: rate(
      process.env.PILOT_BENCHMARK_MANUAL_PASS_RATE ?? "0.9",
      "manual pass rate",
    ),
    minimumSuccessRate: rate(
      process.env.PILOT_BENCHMARK_MIN_SUCCESS_RATE ?? "1",
      "minimum success rate",
    ),
    outputCost: nonNegativeNumber(process.env.PILOT_BENCHMARK_OUTPUT_COST),
    outputDirectory: resolve(
      process.env.PILOT_BENCHMARK_OUTPUT_DIR ??
        `.artifacts/ai-real-benchmark-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
    ),
    preflightOnly: process.env.PILOT_BENCHMARK_PREFLIGHT_ONLY === "true",
    pricingComplete: missingPricing.length === 0,
    providerId: process.env.PILOT_BENCHMARK_PROVIDER_ID ?? "pilot-real-provider",
    similarityThreshold: rate(
      process.env.PILOT_BENCHMARK_SIMILARITY_THRESHOLD ?? "0.95",
      "similarity threshold",
    ),
    textModel: requiredEnv("PILOT_BENCHMARK_TEXT_MODEL"),
    timeoutMs: positiveInteger(process.env.PILOT_BENCHMARK_TIMEOUT_MS ?? "120000"),
  };
}

function createFailure(
  stage: BenchmarkStage,
  error: unknown,
  employeeMembershipId?: string,
): BenchmarkFailure {
  const attempts = attemptsFromError(error);
  return {
    copyAttempts: stage === "EMPLOYEE_COPY" || stage === "BLUEPRINT" ? attempts : [],
    employeeMembershipId,
    error: safeError(error),
    imageAttempts: stage === "EMPLOYEE_IMAGE" ? attempts : [],
    stage,
  };
}

function attemptsFromError(error: unknown): readonly InvocationAttempt[] {
  return error instanceof ModelRoutingError ? error.attempts : [];
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown provider failure").slice(0, 500);
}

function attemptCost(attempts: readonly InvocationAttempt[]): number {
  return attempts.reduce((sum, attempt) => sum + (attempt.estimatedCost ?? 0), 0);
}

function candidateSimilarities(
  successes: readonly SuccessfulItem[],
  threshold: number,
): Array<{ first: string; second: string; similarity: number }> {
  const pairs: Array<{ first: string; second: string; similarity: number }> = [];
  for (let first = 0; first < successes.length; first += 1) {
    for (let second = first + 1; second < successes.length; second += 1) {
      const left = successes[first];
      const right = successes[second];
      if (!left || !right) continue;
      const similarity = hashSimilarity(left.image.perceptualHash, right.image.perceptualHash);
      if (similarity >= threshold) {
        pairs.push({
          first: left.employeeMembershipId,
          second: right.employeeMembershipId,
          similarity,
        });
      }
    }
  }
  return pairs;
}

function maximumPairSimilarity(successes: readonly SuccessfulItem[]): number {
  let maximum = 0;
  for (let first = 0; first < successes.length; first += 1) {
    for (let second = first + 1; second < successes.length; second += 1) {
      const left = successes[first];
      const right = successes[second];
      if (!left || !right) continue;
      maximum = Math.max(
        maximum,
        hashSimilarity(left.image.perceptualHash, right.image.perceptualHash),
      );
    }
  }
  return maximum;
}

function countSourceDimensions(successes: readonly SuccessfulItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of successes) {
    const key = `${item.image.sourceWidth}x${item.image.sourceHeight}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function countFailureCodes(attempts: readonly InvocationAttempt[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    if (attempt.status !== "FAILED") continue;
    const code = attempt.errorCode ?? "UNKNOWN";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

async function parallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    }),
  );
  return results;
}

function extensionFor(mimeType: string): "jpg" | "png" | "webp" {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function mimeTypeForSharpFormat(format: string | undefined): string | undefined {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return undefined;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Expected a positive integer");
  return parsed;
}

function nonNegativeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Expected a non-negative cost");
  return parsed;
}

function rate(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return parsed;
}

function costCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new Error("PILOT_BENCHMARK_COST_CURRENCY must be a three-letter currency code");
  }
  return normalized;
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PILOT_BENCHMARK_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PILOT_BENCHMARK_BASE_URL cannot contain credentials, query or fragment");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && process.env.PILOT_BENCHMARK_ALLOW_HTTP === "true")
  ) {
    throw new Error(
      "Real provider base URL must use HTTPS; HTTP requires PILOT_BENCHMARK_ALLOW_HTTP=true for a local test endpoint",
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

function safeIdentifier(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]+/gu, "-")
      .slice(0, 80) || "provider"
  );
}

function requiredEnv(
  name: "PILOT_BENCHMARK_BASE_URL" | "PILOT_BENCHMARK_IMAGE_MODEL" | "PILOT_BENCHMARK_TEXT_MODEL",
): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Real provider benchmark failed"}\n`,
  );
  process.exitCode = 1;
});
