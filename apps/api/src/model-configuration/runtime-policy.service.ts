import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { PLATFORM_RUNTIME_POLICY_ID } from "./runtime-policy.constants";
import type { UpdateRuntimePolicyDto } from "./runtime-policy.dto";

type RuntimePolicyClient = Pick<PrismaService, "runtimePolicy"> | Prisma.TransactionClient;

@Injectable()
export class RuntimePolicyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  async platformCurrent() {
    this.accessContext.requireSaasAdmin();
    return runtimePolicyResponse(await this.current());
  }

  async current(client: RuntimePolicyClient = this.prisma) {
    const policy = await client.runtimePolicy.findUnique({
      where: { id: PLATFORM_RUNTIME_POLICY_ID },
    });
    if (!policy) {
      throw new ConflictException({
        code: "RUNTIME_POLICY_MISSING",
        message: "Platform runtime policy is not initialized",
      });
    }
    return policy;
  }

  async update(input: UpdateRuntimePolicyDto, client?: Prisma.TransactionClient) {
    const database = client ?? this.prisma;
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ConflictException("Runtime policy requires platform scope");
    }
    if (input.embeddingModelId) {
      const embeddingModel = await database.modelDefinition.findFirst({
        select: { id: true },
        where: {
          capabilities: { has: "EMBEDDING" },
          id: input.embeddingModelId,
          provider: { status: "ACTIVE", synthetic: false },
          status: "ACTIVE",
          synthetic: false,
        },
      });
      if (!embeddingModel) {
        throw new ConflictException("Embedding model must be an active real platform model");
      }
    }
    if (input.materialAnalysisModelId) {
      const model = await database.modelDefinition.findFirst({
        where: {
          id: input.materialAnalysisModelId,
          status: "ACTIVE",
          synthetic: false,
          OR: [
            { capabilities: { has: "MULTIMODAL" } },
            { capabilities: { hasEvery: ["TEXT", "VISION"] } },
          ],
          provider: { status: "ACTIVE", synthetic: false, protocol: "OPENAI_COMPATIBLE" },
        },
      });
      if (!model) throw new ConflictException("资料理解需要已启用且支持文本和视觉的真实模型");
    }
    const changes = {
      materialAnalysisModelId: input.materialAnalysisModelId,
      costCurrency: input.costCurrency,
      costWarningThreshold:
        input.costWarningThreshold === undefined
          ? undefined
          : new Prisma.Decimal(input.costWarningThreshold),
      embeddingModelId: input.embeddingModelId,
      materialChunkOverlapCharacters: input.materialChunkOverlapCharacters,
      materialChunkSizeCharacters: input.materialChunkSizeCharacters,
      maxActiveGenerationJobs: input.maxActiveGenerationJobs,
      maxProviderConcurrentInvocations: input.maxProviderConcurrentInvocations,
      maxQueueBacklog: input.maxQueueBacklog,
      minimumGenerationWorkers: input.minimumGenerationWorkers,
      providerHealthMaxAgeSeconds: input.providerHealthMaxAgeSeconds,
      retrievalMaxContextCharacters: input.retrievalMaxContextCharacters,
      retrievalStrategyVersion: input.retrievalStrategyVersion,
      retrievalTopK: input.retrievalTopK,
      routeQualificationMaxAgeSeconds: input.routeQualificationMaxAgeSeconds,
    };
    if (Object.values(changes).every((value) => value === undefined)) {
      throw new ConflictException("At least one runtime policy setting must be changed");
    }
    const update = async (transaction: Prisma.TransactionClient) => {
      const before = await this.current(transaction);
      const effectiveChunkSize =
        input.materialChunkSizeCharacters ?? before.materialChunkSizeCharacters;
      const effectiveOverlap =
        input.materialChunkOverlapCharacters ?? before.materialChunkOverlapCharacters;
      if (effectiveOverlap >= effectiveChunkSize) {
        throw new ConflictException("Material chunk overlap must be smaller than chunk size");
      }
      const updated = await transaction.runtimePolicy.update({
        data: { ...changes, updatedBy: principal.userId },
        where: { id: PLATFORM_RUNTIME_POLICY_ID },
      });
      await transaction.auditLog.create({
        data: {
          action: "runtime-policy.update",
          actorType: "USER",
          actorUserId: principal.userId,
          reason: input.reason,
          resourceId: PLATFORM_RUNTIME_POLICY_ID,
          resourceType: "RuntimePolicy",
          stateAfter: runtimePolicyState(updated),
          stateBefore: runtimePolicyState(before),
        },
      });
      return runtimePolicyResponse(updated);
    };
    return client ? update(client) : this.prisma.$transaction(update);
  }
}

function runtimePolicyResponse<T extends { costWarningThreshold: Prisma.Decimal }>(policy: T) {
  return { ...policy, costWarningThreshold: Number(policy.costWarningThreshold) };
}

function runtimePolicyState(policy: {
  costCurrency: string;
  costWarningThreshold: Prisma.Decimal;
  embeddingModelId: string | null;
  materialAnalysisModelId: string | null;
  materialChunkOverlapCharacters: number;
  materialChunkSizeCharacters: number;
  maxActiveGenerationJobs: number;
  maxProviderConcurrentInvocations: number;
  maxQueueBacklog: number;
  minimumGenerationWorkers: number;
  providerHealthMaxAgeSeconds: number;
  retrievalMaxContextCharacters: number;
  retrievalStrategyVersion: string;
  retrievalTopK: number;
  routeQualificationMaxAgeSeconds: number;
}): Prisma.InputJsonValue {
  return {
    costCurrency: policy.costCurrency,
    costWarningThreshold: Number(policy.costWarningThreshold),
    embeddingModelId: policy.embeddingModelId,
    materialAnalysisModelId: policy.materialAnalysisModelId,
    materialChunkOverlapCharacters: policy.materialChunkOverlapCharacters,
    materialChunkSizeCharacters: policy.materialChunkSizeCharacters,
    maxActiveGenerationJobs: policy.maxActiveGenerationJobs,
    maxProviderConcurrentInvocations: policy.maxProviderConcurrentInvocations,
    maxQueueBacklog: policy.maxQueueBacklog,
    minimumGenerationWorkers: policy.minimumGenerationWorkers,
    providerHealthMaxAgeSeconds: policy.providerHealthMaxAgeSeconds,
    retrievalMaxContextCharacters: policy.retrievalMaxContextCharacters,
    retrievalStrategyVersion: policy.retrievalStrategyVersion,
    retrievalTopK: policy.retrievalTopK,
    routeQualificationMaxAgeSeconds: policy.routeQualificationMaxAgeSeconds,
  };
}
