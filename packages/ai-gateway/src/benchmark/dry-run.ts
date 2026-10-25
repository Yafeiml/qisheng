import { differenceHash, hashSimilarity } from "../image-similarity";
import { ModelRouter } from "../model-router";
import { SyntheticImageProvider, SyntheticTextProvider } from "../synthetic-provider";

async function run(): Promise<void> {
  const router = new ModelRouter(
    [
      new SyntheticTextProvider({ estimatedCost: 0.01, failFirstCalls: 1, providerId: "text-a" }),
      new SyntheticTextProvider({ estimatedCost: 0.02, providerId: "text-b" }),
    ],
    [
      new SyntheticImageProvider({ estimatedCost: 0.08, failFirstCalls: 1, providerId: "image-a" }),
      new SyntheticImageProvider({ estimatedCost: 0.12, providerId: "image-b" }),
    ],
    () => new Date("2026-08-28T00:00:00Z"),
  );

  const textPolicy = router.freezePolicy({
    fallbackModels: [{ modelId: "text-standard-b", providerId: "text-b" }],
    id: "dry-run-text",
    kind: "TEXT",
    maxAttemptsPerModel: 1,
    primaryModel: { modelId: "text-standard-a", providerId: "text-a" },
    scopeType: "PLATFORM",
    taskKind: "EMPLOYEE_COPY",
    version: 1,
  });
  const imagePolicy = router.freezePolicy({
    fallbackModels: [{ modelId: "image-standard-b", providerId: "image-b" }],
    id: "dry-run-image",
    kind: "IMAGE",
    maxAttemptsPerModel: 1,
    primaryModel: { modelId: "image-standard-a", providerId: "image-a" },
    scopeType: "PLATFORM",
    taskKind: "EMPLOYEE_IMAGE",
    version: 1,
  });
  const context = { generationRunId: "synthetic-run", tenantId: "synthetic-tenant" };
  const text = await router.generateText(textPolicy, {
    context,
    prompt: "生成全飞秒 Pro 术式的小红书风格科普文案",
  });
  const firstImage = await router.generateImage(imagePolicy, {
    context,
    height: 1280,
    prompt: "设备与专业空间",
    seed: "employee-001-a5f",
    width: 960,
  });
  const secondImage = await router.generateImage(imagePolicy, {
    context,
    height: 1280,
    prompt: "术前个性化评估",
    seed: "employee-002-b8d",
    width: 960,
  });
  const firstHash = await differenceHash(firstImage.output.bytes);
  const secondHash = await differenceHash(secondImage.output.bytes);

  process.stdout.write(
    `${JSON.stringify(
      {
        warning: "SYNTHETIC_DRY_RUN_NOT_VALID_FOR_COST_OR_MODEL_SELECTION",
        synthetic: true,
        text: {
          attempts: text.attempts,
          estimatedCost: text.output.usage.estimatedCost,
          selected: `${text.providerId}/${text.modelId}`,
        },
        image: {
          attempts: firstImage.attempts,
          estimatedCostPerImage: firstImage.output.usage.estimatedCost,
          perceptualSimilarity: hashSimilarity(firstHash, secondHash),
          selected: `${firstImage.providerId}/${firstImage.modelId}`,
          uniquenessEvaluation: "NOT_APPLICABLE_TO_SYNTHETIC_OUTPUT",
        },
      },
      null,
      2,
    )}\n`,
  );
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown synthetic benchmark error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
