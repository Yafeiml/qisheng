import { describe, expect, it, vi } from "vitest";
import { recordRouteRuntimeOutcome } from "./route-runtime-health";

function fixture() {
  const tx = {
    modelInvocation: {
      findFirst: vi.fn().mockResolvedValue({
        kind: "EMPLOYEE_IMAGE",
        errorCode: "HTTP_503",
        retryable: true,
        idempotencyKey: "work:item:v1:job:6:image:1:1",
      }),
      findMany: vi.fn().mockResolvedValue([
        { idempotencyKey: "work:item:v1:job:5:image:1:1", errorCode: "HTTP_503", retryable: true },
        { idempotencyKey: "work:item:v1:job:6:image:1:1", errorCode: "HTTP_503", retryable: true },
      ]),
    },
    campaignPreflightSnapshot: {
      findUnique: vi.fn().mockResolvedValue({
        configurationFingerprint: "original-configuration",
        deliveryMode: "PRODUCTION",
      }),
    },
    generationRun: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ synthetic: false, routingPolicy: { routeId: "route-a" } }),
    },
    auditLog: { upsert: vi.fn() },
  };
  const input = {
    campaignId: "campaign",
    generationRunId: "run",
    workItemId: "item",
    executionVersion: 6,
    tenantId: "tenant",
    attemptCount: 6,
    failure: { code: "HTTP_503", retryable: true, modelFailure: true, message: "upstream failure" },
  };
  return { tx, input };
}

describe("durable terminal model outcomes", () => {
  it("counts a retried task once and binds the event to its original configuration", async () => {
    const { tx, input } = fixture();
    await recordRouteRuntimeOutcome(tx as never, input);
    await recordRouteRuntimeOutcome(tx as never, input);
    const first = tx.auditLog.upsert.mock.calls[0]?.[0];
    expect(first).toMatchObject({
      create: {
        resourceId: "route-a",
        action: "model-route.runtime.exhausted",
        metadata: {
          capability: "IMAGE",
          configurationFingerprint: "original-configuration",
          workItemId: "item",
        },
      },
      update: {},
    });
    expect(tx.auditLog.upsert.mock.calls[1]?.[0].where.id).toBe(first.where.id);
  });
  it("does not count one attempt, non-model errors, limits or absent upstream evidence", async () => {
    const { tx, input } = fixture();
    await recordRouteRuntimeOutcome(tx as never, { ...input, attemptCount: 1 });
    await recordRouteRuntimeOutcome(tx as never, {
      ...input,
      failure: { code: "STORAGE_ERROR", retryable: true, message: "disk" },
    });
    tx.modelInvocation.findFirst.mockResolvedValue({
      kind: "EMPLOYEE_IMAGE",
      errorCode: "HTTP_429",
      retryable: true,
    });
    await recordRouteRuntimeOutcome(tx as never, input);
    tx.modelInvocation.findFirst.mockResolvedValue(null);
    await recordRouteRuntimeOutcome(tx as never, input);
    expect(tx.auditLog.upsert).not.toHaveBeenCalled();
  });
  it("does not count repeated calls in one round or retries refused by the circuit", async () => {
    const { tx, input } = fixture();
    tx.modelInvocation.findMany.mockResolvedValue([
      { idempotencyKey: "work:item:v1:job:5:image:1:1", errorCode: "HTTP_503", retryable: true },
      { idempotencyKey: "work:item:v1:job:5:image:1:2", errorCode: "HTTP_503", retryable: true },
      {
        idempotencyKey: "work:item:v1:job:6:image:1:1",
        errorCode: "PROVIDER_CIRCUIT_OPEN",
        retryable: true,
      },
    ]);
    await recordRouteRuntimeOutcome(tx as never, input);
    expect(tx.auditLog.upsert).not.toHaveBeenCalled();
  });
  it("records a recovered task as success for both capabilities without counting intermediate retries", async () => {
    const { tx, input } = fixture();
    await recordRouteRuntimeOutcome(tx as never, {
      ...input,
      failure: undefined,
      capabilities: ["TEXT", "IMAGE"],
    });
    expect(tx.modelInvocation.findFirst).not.toHaveBeenCalled();
    expect(tx.auditLog.upsert.mock.calls.map(([call]) => call.create.action)).toEqual([
      "model-route.runtime.succeeded",
      "model-route.runtime.succeeded",
    ]);
  });
});
