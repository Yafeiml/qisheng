import { describe, expect, it } from "vitest";
import { ProviderInvocationError } from "./errors";
import { ModelRouter } from "./model-router";
import { SyntheticTextProvider } from "./synthetic-provider";
import type { TextGenerationProvider } from "./types";

const request = {
  context: { generationRunId: "run-1", tenantId: "tenant-1" },
  prompt: "生成全飞秒 Pro 术式的小红书风格科普文案",
};

describe("ModelRouter", () => {
  it("freezes a policy and falls back only after retryable failures", async () => {
    const primary = new SyntheticTextProvider({
      estimatedCost: 0.01,
      failFirstCalls: 2,
      providerId: "text-a",
    });
    const fallback = new SyntheticTextProvider({ estimatedCost: 0.02, providerId: "text-b" });
    const router = new ModelRouter([primary, fallback], [], () => new Date("2026-08-28T00:00:00Z"));
    const policy = router.freezePolicy({
      fallbackModels: [{ modelId: "advanced", providerId: "text-b" }],
      id: "employee-copy-default",
      kind: "TEXT",
      maxAttemptsPerModel: 2,
      primaryModel: { modelId: "standard", providerId: "text-a" },
      scopeType: "PLATFORM",
      taskKind: "EMPLOYEE_COPY",
      version: 1,
    });

    const result = await router.generateText(policy, request);

    expect(Object.isFrozen(policy)).toBe(true);
    expect(result.providerId).toBe("text-b");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      "FAILED",
      "FAILED",
      "SUCCEEDED",
    ]);
  });

  it("does not fall back after a non-retryable provider error", async () => {
    const rejectedProvider: TextGenerationProvider = {
      providerId: "rejected",
      async generate() {
        throw new ProviderInvocationError("Policy rejected", "POLICY_REJECTED", false);
      },
    };
    const fallback = new SyntheticTextProvider({ estimatedCost: 0.02, providerId: "fallback" });
    const router = new ModelRouter([rejectedProvider, fallback], []);
    const policy = router.freezePolicy({
      fallbackModels: [{ modelId: "fallback", providerId: "fallback" }],
      id: "non-retryable",
      kind: "TEXT",
      maxAttemptsPerModel: 2,
      primaryModel: { modelId: "rejected", providerId: "rejected" },
      scopeType: "PLATFORM",
      taskKind: "EMPLOYEE_COPY",
      version: 1,
    });

    await expect(router.generateText(policy, request)).rejects.toMatchObject({
      attempts: [{ errorCode: "POLICY_REJECTED", status: "FAILED" }],
    });
  });
});
