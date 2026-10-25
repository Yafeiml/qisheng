import { createHash } from "node:crypto";
import {
  isModelRuntimeFailure,
  type ModelRuntimeCapability,
  NON_MODEL_FAILURE_CODES,
  ROUTE_RUNTIME_FAILURE,
  ROUTE_RUNTIME_MINIMUM_ATTEMPTS,
  ROUTE_RUNTIME_RESOURCE,
  ROUTE_RUNTIME_SUCCESS,
} from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";
import type { GenerationErrorClassification } from "./generation-execution";

export async function recordRouteRuntimeOutcome(
  transaction: Prisma.TransactionClient,
  input: {
    campaignId: string;
    generationRunId: string;
    workItemId?: string;
    executionVersion: number;
    tenantId: string;
    capabilities?: readonly ModelRuntimeCapability[];
    failure?: GenerationErrorClassification;
    attemptCount?: number;
  },
): Promise<void> {
  let capabilities = input.capabilities ?? [];
  let errorCode: string | null = null;
  if (input.failure) {
    if (
      (input.attemptCount ?? 0) < ROUTE_RUNTIME_MINIMUM_ATTEMPTS ||
      (!input.failure.modelFailure && input.failure.code !== "PROVIDER_CIRCUIT_OPEN")
    )
      return;
    // Only a recorded upstream attempt can implicate the model. A queue retry,
    // storage error, lease expiry or the breaker refusing a call cannot do so.
    const invocation = await transaction.modelInvocation.findFirst({
      select: { kind: true, errorCode: true, retryable: true, idempotencyKey: true },
      where: {
        generationRunId: input.generationRunId,
        generationWorkItemId: input.workItemId ?? null,
        status: "FAILED",
        retryable: true,
        errorCode:
          input.failure.code === "PROVIDER_CIRCUIT_OPEN"
            ? { notIn: NON_MODEL_FAILURE_CODES }
            : input.failure.code,
      },
      orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
    });
    if (!invocation || !isModelRuntimeFailure(invocation.errorCode, invocation.retryable)) return;
    // Require failed upstream evidence from two distinct durable rounds. Repeated
    // calls in one round or retries rejected by the circuit are not enough.
    const prefix = input.workItemId
      ? invocation.idempotencyKey.match(/^(work:.*?:v\d+:)job:\d+:/u)?.[1]
      : `run:${input.generationRunId}:blueprint:`;
    if (!prefix) return;
    const attempts = await transaction.modelInvocation.findMany({
      where: {
        generationRunId: input.generationRunId,
        generationWorkItemId: input.workItemId ?? null,
        kind: invocation.kind,
        status: "FAILED",
        retryable: true,
        idempotencyKey: { startsWith: prefix },
      },
      select: { idempotencyKey: true, errorCode: true, retryable: true },
    });
    const rounds = new Set(
      attempts
        .filter((attempt) => isModelRuntimeFailure(attempt.errorCode, attempt.retryable))
        .map(
          (attempt) =>
            attempt.idempotencyKey.slice(prefix.length).match(/^(?:job|execution):(\d+):/u)?.[1],
        )
        .filter((round): round is string => Boolean(round)),
    );
    if (rounds.size < ROUTE_RUNTIME_MINIMUM_ATTEMPTS) return;
    errorCode = invocation.errorCode;
    capabilities = [invocation.kind === "EMPLOYEE_IMAGE" ? "IMAGE" : "TEXT"];
  }
  if (!capabilities.length) return;
  const [snapshot, run] = await Promise.all([
    transaction.campaignPreflightSnapshot.findUnique({
      where: { campaignId: input.campaignId },
      select: { configurationFingerprint: true, deliveryMode: true },
    }),
    transaction.generationRun.findUnique({
      where: { id: input.generationRunId },
      select: { routingPolicy: true, synthetic: true },
    }),
  ]);
  const routeId =
    run?.routingPolicy && typeof run.routingPolicy === "object" && !Array.isArray(run.routingPolicy)
      ? run.routingPolicy.routeId
      : null;
  if (!snapshot || run?.synthetic || typeof routeId !== "string") return;
  const action = input.failure ? ROUTE_RUNTIME_FAILURE : ROUTE_RUNTIME_SUCCESS;
  for (const capability of capabilities) {
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          "route-runtime-v1",
          input.generationRunId,
          input.workItemId ?? null,
          input.failure ? "terminal" : input.executionVersion,
          capability,
          action,
        ]),
      )
      .digest("hex");
    await transaction.auditLog.upsert({
      where: { id },
      update: {},
      create: {
        id,
        action,
        actorType: "SYSTEM",
        tenantId: input.tenantId,
        resourceType: ROUTE_RUNTIME_RESOURCE,
        resourceId: routeId,
        metadata: {
          configurationFingerprint: snapshot.configurationFingerprint,
          deliveryMode: snapshot.deliveryMode,
          capability,
          generationRunId: input.generationRunId,
          workItemId: input.workItemId ?? null,
          attemptCount: input.attemptCount ?? 1,
          errorCode,
        },
      },
    });
  }
}
