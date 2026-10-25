import { randomUUID } from "node:crypto";
import {
  isModelRuntimeFailure,
  ProviderInvocationError,
  type RuntimeProviderPair,
} from "@xhs-agentic/ai-gateway";
import type { Prisma, PrismaClient } from "@xhs-agentic/database";
import { writeStructuredLog } from "@xhs-agentic/observability";

interface CircuitPermit {
  probeToken?: string;
  providerId: string;
}

export interface ProviderCircuitBreakerOptions {
  cooldownMs: number;
  failureThreshold: number;
  probeLeaseMs: number;
}

export class ProviderCircuitBreaker {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: ProviderCircuitBreakerOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  wrap(pair: RuntimeProviderPair): RuntimeProviderPair {
    return {
      image: {
        providerId: pair.image.providerId,
        generate: async (modelId, request) => {
          const permit = await this.acquire(pair.image.providerId);
          try {
            const result = await pair.image.generate(modelId, request);
            await this.recordSuccessSafely(permit);
            return result;
          } catch (error) {
            await this.recordFailureSafely(permit, error);
            throw error;
          }
        },
      },
      text: {
        providerId: pair.text.providerId,
        generate: async (modelId, request) => {
          const permit = await this.acquire(pair.text.providerId);
          try {
            const result = await pair.text.generate(modelId, request);
            await this.recordSuccessSafely(permit);
            return result;
          } catch (error) {
            await this.recordFailureSafely(permit, error);
            throw error;
          }
        },
      },
    };
  }

  private async acquire(providerId: string): Promise<CircuitPermit> {
    const now = this.now();
    let provider: {
      circuitOpenUntil: Date | null;
      circuitProbeExpiresAt: Date | null;
      circuitState: "CLOSED" | "HALF_OPEN" | "OPEN";
      status: "ACTIVE" | "DISABLED";
    } | null = null;
    try {
      provider = await this.prisma.modelProvider.findUnique({
        select: {
          circuitOpenUntil: true,
          circuitProbeExpiresAt: true,
          circuitState: true,
          status: true,
        },
        where: { id: providerId },
      });
    } catch {
      throw new ProviderInvocationError(
        "Provider circuit state could not be read",
        "PROVIDER_CIRCUIT_STATE_UNAVAILABLE",
        true,
      );
    }
    if (provider?.status !== "ACTIVE") {
      throw new ProviderInvocationError(
        "Provider is disabled or unavailable",
        "PROVIDER_DISABLED",
        false,
      );
    }
    if (provider.circuitState === "CLOSED") return { providerId };

    const isProbeEligible =
      provider.circuitState === "OPEN"
        ? !provider.circuitOpenUntil || provider.circuitOpenUntil <= now
        : !provider.circuitProbeExpiresAt || provider.circuitProbeExpiresAt <= now;
    if (!isProbeEligible) throw circuitOpenError();

    const probeToken = randomUUID();
    const probeExpiresAt = new Date(now.getTime() + this.options.probeLeaseMs);
    const claimed = await this.prisma.modelProvider.updateMany({
      data: {
        circuitProbeExpiresAt: probeExpiresAt,
        circuitProbeToken: probeToken,
        circuitState: "HALF_OPEN",
      },
      where: {
        id: providerId,
        OR:
          provider.circuitState === "OPEN"
            ? [{ circuitOpenUntil: null }, { circuitOpenUntil: { lte: now } }]
            : [{ circuitProbeExpiresAt: null }, { circuitProbeExpiresAt: { lte: now } }],
        circuitState: provider.circuitState,
        status: "ACTIVE",
      },
    });
    if (claimed.count !== 1) throw circuitOpenError();
    await this.audit("model-provider.circuit.half-open", providerId, {
      probeExpiresAt: probeExpiresAt.toISOString(),
      previousState: provider.circuitState,
    });
    return { probeToken, providerId };
  }

  private async recordSuccess(permit: CircuitPermit): Promise<void> {
    if (permit.probeToken) {
      const closed = await this.prisma.modelProvider.updateMany({
        data: {
          circuitOpenedAt: null,
          circuitOpenUntil: null,
          circuitProbeExpiresAt: null,
          circuitProbeToken: null,
          circuitState: "CLOSED",
          lastRuntimeErrorCode: null,
          runtimeFailureCount: 0,
        },
        where: {
          circuitProbeToken: permit.probeToken,
          circuitState: "HALF_OPEN",
          id: permit.providerId,
        },
      });
      if (closed.count === 1) {
        await this.audit("model-provider.circuit.closed", permit.providerId, {
          reason: "half-open probe succeeded",
        });
      }
      return;
    }
    await this.prisma.modelProvider.updateMany({
      data: { lastRuntimeErrorCode: null, runtimeFailureCount: 0 },
      where: { circuitState: "CLOSED", id: permit.providerId, runtimeFailureCount: { gt: 0 } },
    });
  }

  private async recordFailureSafely(permit: CircuitPermit, error: unknown): Promise<void> {
    try {
      const code = providerErrorCode(error);
      if (!isModelRuntimeFailure(code, true)) {
        // An inconclusive half-open probe returns to cooling without counting a failure.
        if (permit.probeToken)
          await this.prisma.modelProvider.updateMany({
            where: {
              id: permit.providerId,
              circuitState: "HALF_OPEN",
              circuitProbeToken: permit.probeToken,
            },
            data: {
              circuitState: "OPEN",
              circuitOpenUntil: new Date(this.now().getTime() + this.options.cooldownMs),
              circuitProbeToken: null,
              circuitProbeExpiresAt: null,
            },
          });
        return;
      }
      await this.recordFailure(permit, code);
    } catch (circuitError) {
      writeStructuredLog({
        event: "provider-circuit.record-failure.error",
        fields: {
          error: circuitError,
          providerId: permit.providerId,
        },
        level: "error",
        service: "worker",
      });
    }
  }

  private async recordSuccessSafely(permit: CircuitPermit): Promise<void> {
    try {
      await this.recordSuccess(permit);
    } catch (error) {
      writeStructuredLog({
        event: "provider-circuit.record-success.error",
        fields: {
          error,
          providerId: permit.providerId,
        },
        level: "error",
        service: "worker",
      });
    }
  }

  private async recordFailure(permit: CircuitPermit, code: string): Promise<void> {
    const now = this.now();
    const openUntil = new Date(now.getTime() + this.options.cooldownMs);
    if (permit.probeToken) {
      const opened = await this.prisma.modelProvider.updateMany({
        data: {
          circuitOpenedAt: now,
          circuitOpenUntil: openUntil,
          circuitProbeExpiresAt: null,
          circuitProbeToken: null,
          circuitState: "OPEN",
          lastRuntimeErrorCode: code,
          lastRuntimeFailureAt: now,
          runtimeFailureCount: { increment: 1 },
        },
        where: {
          circuitProbeToken: permit.probeToken,
          circuitState: "HALF_OPEN",
          id: permit.providerId,
        },
      });
      if (opened.count === 1) {
        await this.audit("model-provider.circuit.reopened", permit.providerId, {
          errorCode: code,
          openUntil: openUntil.toISOString(),
        });
      }
      return;
    }

    const provider = await this.prisma.modelProvider.update({
      data: {
        lastRuntimeErrorCode: code,
        lastRuntimeFailureAt: now,
        runtimeFailureCount: { increment: 1 },
      },
      select: { circuitState: true, runtimeFailureCount: true },
      where: { id: permit.providerId },
    });
    if (
      provider.circuitState !== "CLOSED" ||
      provider.runtimeFailureCount < this.options.failureThreshold
    ) {
      return;
    }
    const opened = await this.prisma.modelProvider.updateMany({
      data: {
        circuitOpenedAt: now,
        circuitOpenUntil: openUntil,
        circuitProbeExpiresAt: null,
        circuitProbeToken: null,
        circuitState: "OPEN",
      },
      where: {
        circuitState: "CLOSED",
        id: permit.providerId,
        runtimeFailureCount: { gte: this.options.failureThreshold },
      },
    });
    if (opened.count === 1) {
      await this.audit("model-provider.circuit.opened", permit.providerId, {
        errorCode: code,
        failureCount: provider.runtimeFailureCount,
        openUntil: openUntil.toISOString(),
      });
    }
  }

  private audit(action: string, providerId: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: {
        action,
        actorType: "SYSTEM",
        metadata: metadata as Prisma.InputJsonValue,
        resourceId: providerId,
        resourceType: "ModelProvider",
      },
    });
  }
}

function circuitOpenError(): ProviderInvocationError {
  return new ProviderInvocationError(
    "Provider circuit is open while the service cools down",
    "PROVIDER_CIRCUIT_OPEN",
    true,
  );
}

function providerErrorCode(error: unknown): string {
  if (error instanceof ProviderInvocationError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    if (typeof error.code === "string") return error.code.slice(0, 120);
  }
  return "PROVIDER_RUNTIME_FAILURE";
}
