import { createHash } from "node:crypto";
import { differenceHash, hashSimilarity } from "../image-similarity";
import { ModelRouter } from "../model-router";
import { SyntheticImageProvider, SyntheticTextProvider } from "../synthetic-provider";

const MEMBER_COUNT = 100;
const CONCURRENCY = 10;

async function run(): Promise<void> {
  const router = new ModelRouter(
    [new SyntheticTextProvider({ estimatedCost: 0, providerId: "pilot-synthetic" })],
    [new SyntheticImageProvider({ estimatedCost: 0, providerId: "pilot-synthetic" })],
  );
  const textPolicy = router.freezePolicy({
    fallbackModels: [],
    id: "pilot-synthetic-copy",
    kind: "TEXT",
    maxAttemptsPerModel: 2,
    primaryModel: { modelId: "synthetic-copy-v1", providerId: "pilot-synthetic" },
    scopeType: "PLATFORM",
    taskKind: "EMPLOYEE_COPY",
    version: 1,
  });
  const imagePolicy = router.freezePolicy({
    fallbackModels: [],
    id: "pilot-synthetic-image",
    kind: "IMAGE",
    maxAttemptsPerModel: 2,
    primaryModel: { modelId: "synthetic-image-v1", providerId: "pilot-synthetic" },
    scopeType: "PLATFORM",
    taskKind: "EMPLOYEE_IMAGE",
    version: 1,
  });
  const startedAt = performance.now();
  const results = await parallelMap(
    Array.from({ length: MEMBER_COUNT }, (_, index) => index + 1),
    CONCURRENCY,
    async (ordinal) => {
      const itemStartedAt = performance.now();
      const context = {
        enterpriseId: "pilot-enterprise",
        generationRunId: "pilot-synthetic-100",
        tenantId: "pilot-tenant",
      };
      const text = await router.generateText(textPolicy, {
        context,
        prompt: `员工 ${ordinal} 的全飞秒 Pro 小红书风格差异化文案`,
      });
      const image = await router.generateImage(imagePolicy, {
        context,
        height: 1440,
        prompt: "暖白与珊瑚红医疗科技竖版图片",
        seed: `pilot-member-${ordinal.toString().padStart(3, "0")}`,
        width: 1080,
      });
      return {
        checksum: createHash("sha256").update(image.output.bytes).digest("hex"),
        cost: text.output.usage.estimatedCost + image.output.usage.estimatedCost,
        latencyMs: performance.now() - itemStartedAt,
        perceptualHash: await differenceHash(image.output.bytes),
      };
    },
  );
  const exactUnique = new Set(results.map((result) => result.checksum)).size;
  if (exactUnique !== MEMBER_COUNT) {
    throw new Error(
      `Synthetic pilot benchmark produced ${MEMBER_COUNT - exactUnique} exact duplicate(s)`,
    );
  }
  let perceptualCandidatePairs = 0;
  for (let first = 0; first < results.length; first += 1) {
    for (let second = first + 1; second < results.length; second += 1) {
      const left = results[first];
      const right = results[second];
      if (left && right && hashSimilarity(left.perceptualHash, right.perceptualHash) >= 0.95) {
        perceptualCandidatePairs += 1;
      }
    }
  }
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "pilot-readiness-100-member-orchestration",
        concurrency: CONCURRENCY,
        exactUniqueImages: exactUnique,
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
          total: performance.now() - startedAt,
        },
        members: MEMBER_COUNT,
        perceptualCandidatePairs,
        success: results.length,
        synthetic: true,
        totalEstimatedCost: results.reduce((sum, result) => sum + result.cost, 0),
        warning: "SYNTHETIC_ORCHESTRATION_ONLY_NOT_VALID_FOR_PROVIDER_COST_OR_QUALITY",
      },
      null,
      2,
    )}\n`,
  );
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

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Pilot benchmark failed"}\n`);
  process.exitCode = 1;
});
