import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, RuntimePolicy } from "@xhs-agentic/database";
import { withPublicHttpResponse } from "@xhs-agentic/network-security";
import { PrismaService } from "../database/prisma.service";
import { ModelCredentialService } from "./model-credential.service";
import { PLATFORM_RUNTIME_POLICY_ID } from "./runtime-policy.constants";

type Provider = Prisma.ModelProviderGetPayload<{ include: { activeCredential: true } }>;
type HealthResult = Readonly<{
  checkedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  healthy: boolean;
  httpStatus: number | null;
  id: string;
  latencyMs: number;
  providerId: string;
  status: "HEALTHY" | "UNHEALTHY";
}>;

// Singleton: request-scoped callers share in-flight probes, without sharing access contexts.
@Injectable()
export class ModelProviderHealthService {
  private readonly pending = new Map<string, Promise<HealthResult>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelCredentialService) private readonly credentials: ModelCredentialService,
  ) {}

  async refreshConfigured() {
    const [policy, routes] = await Promise.all([
      this.prisma.runtimePolicy.findUnique({ where: { id: PLATFORM_RUNTIME_POLICY_ID } }),
      this.prisma.modelRoute.findMany({
        select: {
          textModelId: true,
          imageModelId: true,
          textFallbackModelIds: true,
          imageFallbackModelIds: true,
        },
      }),
    ]);
    if (!policy) return [];
    const modelIds = routes.flatMap((route) => [
      route.textModelId,
      route.imageModelId,
      ...route.textFallbackModelIds,
      ...route.imageFallbackModelIds,
    ]);
    if (policy.embeddingModelId) modelIds.push(policy.embeddingModelId);
    if (policy.materialAnalysisModelId) modelIds.push(policy.materialAnalysisModelId);
    await this.refreshModels(modelIds, policy);
    return modelIds;
  }

  async refreshModels(
    modelIds: readonly string[],
    policy: Pick<RuntimePolicy, "providerHealthMaxAgeSeconds">,
  ) {
    if (!modelIds.length) return;
    const models = await this.prisma.modelDefinition.findMany({
      select: { providerId: true },
      where: { id: { in: [...new Set(modelIds)] }, status: "ACTIVE", synthetic: false },
    });
    await this.ensureFresh(
      models.map((model) => model.providerId),
      policy,
    );
  }

  async ensureFresh(
    providerIds: readonly string[],
    policy: Pick<RuntimePolicy, "providerHealthMaxAgeSeconds">,
  ) {
    if (!providerIds.length) return;
    const providers = await this.prisma.modelProvider.findMany({
      include: { activeCredential: true },
      where: { id: { in: [...new Set(providerIds)] }, status: "ACTIVE", synthetic: false },
    });
    const due = providers.filter((provider) => {
      if (provider.activeCredential?.status !== "ACTIVE") return false;
      if (provider.healthStatus === "UNKNOWN" || !provider.lastHealthCheckedAt) return true;
      // Recheck failures after a short cooldown; successful checks use the configured cache.
      const seconds =
        provider.healthStatus === "HEALTHY"
          ? policy.providerHealthMaxAgeSeconds
          : Math.min(60, policy.providerHealthMaxAgeSeconds);
      return Date.now() - provider.lastHealthCheckedAt.getTime() >= seconds * 1_000;
    });
    // Bound fan-out when a platform has many tenant-specific routes.
    for (let offset = 0; offset < due.length; offset += 4) {
      await Promise.all(
        due.slice(offset, offset + 4).map((provider) => this.sharedProbe(provider)),
      );
    }
  }

  async testConnection(providerId: string, checkedBy: string): Promise<HealthResult> {
    const provider = await this.prisma.modelProvider.findUnique({
      include: { activeCredential: true },
      where: { id: providerId },
    });
    if (!provider) throw new NotFoundException("Model provider was not found");
    const result = await this.sharedProbe(provider, checkedBy);
    await this.prisma.auditLog.create({
      data: {
        action: "model-provider.connection-test",
        actorType: "USER",
        actorUserId: checkedBy,
        resourceId: providerId,
        resourceType: "ModelProvider",
        stateAfter: {
          errorCode: result.errorCode,
          healthy: result.healthy,
          httpStatus: result.httpStatus,
          latencyMs: result.latencyMs,
        },
      },
    });
    return result;
  }

  private sharedProbe(
    provider: Provider,
    checkedBy = "system:connection-refresh",
  ): Promise<HealthResult> {
    const key = `${provider.id}:${provider.updatedAt.toISOString()}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = this.probe(provider, checkedBy).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async probe(provider: Provider, checkedBy: string): Promise<HealthResult> {
    if (!provider.synthetic && provider.activeCredential?.status !== "ACTIVE") {
      throw new ConflictException("Model provider has no active credential");
    }
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (!provider.synthetic && provider.activeCredential) {
      try {
        const apiKey = this.credentials.decrypt(provider.activeCredential);
        const response = await withPublicHttpResponse(
          `${provider.baseUrl.replace(/\/+$/u, "")}/models`,
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            method: "GET",
            signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 10_000)),
          },
          {
            allowHttp: process.env.NODE_ENV !== "production",
            allowPrivate: process.env.NODE_ENV !== "production",
          },
          async (result) => ({ ok: result.ok, status: result.status }),
        );
        httpStatus = response.status;
        if (!response.ok) {
          errorCode = healthErrorCode(response.status);
          errorMessage = healthErrorMessage(response.status);
        }
      } catch (error) {
        errorCode =
          error instanceof DOMException && error.name === "TimeoutError"
            ? "TIMEOUT"
            : "NETWORK_ERROR";
        errorMessage =
          errorCode === "TIMEOUT" ? "Provider connection timed out" : "Provider connection failed";
      }
    }
    const result: HealthResult = {
      checkedAt: new Date(),
      errorCode,
      errorMessage,
      healthy: errorCode === null,
      httpStatus,
      id: randomUUID(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      providerId: provider.id,
      status: errorCode ? "UNHEALTHY" : "HEALTHY",
    };
    await this.prisma.$transaction(async (transaction) => {
      // A probe started with an old URL/key must never validate the replacement configuration.
      const updated = await transaction.modelProvider.updateMany({
        where: { id: provider.id, updatedAt: provider.updatedAt },
        data: {
          consecutiveHealthFailures: result.healthy ? 0 : { increment: 1 },
          healthStatus: result.status,
          lastHealthCheckedAt: result.checkedAt,
          lastHealthErrorCode: errorCode,
          lastHealthLatencyMs: result.latencyMs,
        },
      });
      if (!updated.count) {
        throw new ConflictException("供应商配置或连接状态已更新，请刷新查看最新结果");
      }
      await transaction.modelProviderHealthCheck.create({
        data: {
          checkedBy,
          createdAt: result.checkedAt,
          errorCode,
          errorMessage,
          httpStatus,
          id: result.id,
          latencyMs: result.latencyMs,
          providerId: provider.id,
          status: result.status,
        },
      });
    });
    return result;
  }
}

function healthErrorCode(status: number): string {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) return "AUTHORIZATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_ERROR";
  return "UNEXPECTED_RESPONSE";
}

function healthErrorMessage(status: number): string {
  if (status === 401) return "Provider rejected the configured credential";
  if (status === 403) return "Provider credential lacks required access";
  if (status === 429) return "Provider rate limit prevented the connection test";
  if (status >= 500) return "Provider returned a server error";
  return `Provider returned HTTP ${status}`;
}
