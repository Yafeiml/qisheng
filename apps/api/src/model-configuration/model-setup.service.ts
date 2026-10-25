import { createHash } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type ModelCapability, Prisma } from "@xhs-agentic/database";
import { withPublicHttpResponse } from "@xhs-agentic/network-security";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { ModelConfigurationService } from "./model-configuration.service";
import { ModelCredentialService } from "./model-credential.service";
import type {
  AvailableModelDto,
  ModelSelectionDto,
  SaveModelSetupDto,
  SaveProviderConnectionDto,
} from "./model-setup.dto";
import { RuntimePolicyService } from "./runtime-policy.service";

@Injectable()
export class ModelSetupService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
    @Inject(ModelCredentialService) private readonly credentials: ModelCredentialService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(RuntimePolicyService) private readonly policy: RuntimePolicyService,
  ) {}

  async availableModels(providerId: string) {
    this.requirePlatform();
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id: providerId },
      include: { activeCredential: true },
    });
    if (!provider) throw new NotFoundException("供应商不存在");
    if (
      provider.status !== "ACTIVE" ||
      provider.synthetic ||
      provider.activeCredential?.status !== "ACTIVE"
    )
      throw new ConflictException("请先启用供应商并配置 API Key");
    const apiKey = this.credentials.decrypt(provider.activeCredential);
    const models = new Map<string, AvailableModelDto>();
    let after: string | undefined;
    const signal = AbortSignal.timeout(Math.min(provider.timeoutMs, 30_000));
    for (let page = 0; page < 10; page++) {
      // Pagination always stays on the configured endpoint; never follow upstream URLs.
      const url = new URL(`${provider.baseUrl.replace(/\/+$/u, "")}/models`);
      if (after) url.searchParams.set("after", after);
      let payload: unknown;
      try {
        payload = await withPublicHttpResponse(
          url,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal,
          },
          {
            allowHttp: process.env.NODE_ENV !== "production",
            allowPrivate: process.env.NODE_ENV !== "production",
          },
          async (response) => {
            if (!response.ok) {
              const message =
                response.status === 401 || response.status === 403
                  ? "读取模型列表失败，请检查 API Key 和访问权限"
                  : response.status === 404 || response.status === 405
                    ? "供应商未提供模型列表，可在本页手动填写模型 ID"
                    : `读取模型列表失败（HTTP ${response.status}），可重试或手动填写模型 ID`;
              await response.body?.cancel();
              throw new ConflictException(message);
            }
            const reader = response.body?.getReader();
            if (!reader) throw new ConflictException("供应商返回了空模型列表");
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 4 * 1024 * 1024)
                  throw new ConflictException("供应商模型列表过大，请手动填写模型 ID");
                chunks.push(value);
              }
            } finally {
              await reader.cancel();
            }
            return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          },
        );
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new ConflictException(
          "无法读取供应商模型列表，请检查连接后重试；也可以手动填写模型 ID",
        );
      }
      const result = parseAvailableModels(payload);
      for (const model of result.models) models.set(model.externalModelId, model);
      if (models.size > 5000) throw new ConflictException("供应商模型数量过多，请手动填写模型 ID");
      if (!result.hasMore)
        return {
          providerId,
          models: [...models.values()].sort((a, b) =>
            a.externalModelId.localeCompare(b.externalModelId),
          ),
        };
      if (!result.lastId || result.lastId === after) break;
      after = result.lastId;
    }
    throw new ConflictException("供应商模型列表分页不完整，请重试或手动填写模型 ID");
  }

  async save(input: SaveModelSetupDto) {
    const principal = this.requirePlatform();
    return this.prisma.$transaction(
      async (transaction) => {
        const before = await this.policy.current(transaction);
        const previousRoute = await transaction.modelRoute.findUnique({
          where: { scopeType_scopeId: { scopeType: "PLATFORM", scopeId: "platform" } },
        });
        const followText =
          input.materialAnalysisModel === null ||
          (input.materialAnalysisModel === undefined && before.materialAnalysisModelId === null);
        const text = await this.selectModel(
          transaction,
          input.textModel,
          followText ? ["TEXT", "VISION"] : ["TEXT"],
          principal.userId,
        );
        const image = await this.selectModel(
          transaction,
          input.imageModel,
          ["IMAGE"],
          principal.userId,
        );
        const embedding = input.embeddingModel
          ? await this.selectModel(
              transaction,
              input.embeddingModel,
              ["EMBEDDING"],
              principal.userId,
            )
          : null;
        const analysis = input.materialAnalysisModel
          ? await this.selectModel(
              transaction,
              input.materialAnalysisModel,
              ["TEXT", "VISION"],
              principal.userId,
            )
          : null;
        // Keep custom scope routes and advanced defaults intact. Switching primaries removes
        // only a duplicate fallback; ordinary route validation still checks all fallbacks.
        const route = await this.configuration.configureRoute(
          {
            scopeType: "PLATFORM",
            scopeId: "platform",
            textModelId: text.id,
            imageModelId: image.id,
            textFallbackModelIds: (previousRoute?.textFallbackModelIds ?? []).filter(
              (id) => id !== text.id,
            ),
            imageFallbackModelIds: (previousRoute?.imageFallbackModelIds ?? []).filter(
              (id) => id !== image.id,
            ),
            maxAttemptsPerModel: previousRoute?.maxAttemptsPerModel ?? 2,
          },
          transaction,
        );
        const runtimePolicy = await this.policy.update(
          {
            embeddingModelId:
              input.embeddingModel === undefined
                ? before.embeddingModelId
                : (embedding?.id ?? null),
            materialAnalysisModelId:
              input.materialAnalysisModel === undefined
                ? before.materialAnalysisModelId
                : (analysis?.id ?? null),
            reason: "在模型配置页统一保存文案、生图、Embedding 和资料理解模型",
          },
          transaction,
        );
        return { route, runtimePolicy };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async saveConnection(providerId: string, input: SaveProviderConnectionDto) {
    this.requirePlatform();
    return this.prisma.$transaction(async (transaction) => {
      const provider = await this.configuration.updateProvider(providerId, input, transaction);
      return input.apiKey
        ? this.configuration.rotateCredential(
            providerId,
            { apiKey: input.apiKey, reason: input.reason },
            transaction,
          )
        : provider;
    });
  }

  private async selectModel(
    transaction: Prisma.TransactionClient,
    selection: ModelSelectionDto,
    capabilities: ModelCapability[],
    actorUserId: string,
  ) {
    const provider = await transaction.modelProvider.findUnique({
      where: { id: selection.providerId },
      include: { activeCredential: { select: { status: true } } },
    });
    if (
      provider?.status !== "ACTIVE" ||
      (!provider.synthetic && provider.activeCredential?.status !== "ACTIVE")
    )
      throw new ConflictException("所选供应商未启用或缺少有效 API Key");
    if (provider.synthetic && capabilities.includes("EMBEDDING"))
      throw new ConflictException("Embedding 需要选择真实模型服务");
    const existing = await transaction.modelDefinition.findFirst({
      where: { providerId: selection.providerId, externalModelId: selection.externalModelId },
      orderBy: { createdAt: "asc" },
    });
    if (existing?.status === "DISABLED")
      throw new ConflictException(`模型 ${existing.displayName} 已停用，请先启用或选择其他模型`);
    // Selecting a use declares the capabilities required for that use. The page explains
    // that the default text model also needs image input when understanding follows it.
    const combined = [...new Set([...(existing?.capabilities ?? []), ...capabilities])];
    if (existing && combined.every((capability) => existing.capabilities.includes(capability)))
      return existing;
    const model = existing
      ? await transaction.modelDefinition.update({
          where: { id: existing.id },
          data: { capabilities: combined },
        })
      : await transaction.modelDefinition.create({
          data: {
            code: `AUTO_${createHash("sha256").update(selection.externalModelId).digest("hex").slice(0, 40).toUpperCase()}`,
            displayName: selection.externalModelId.slice(0, 160),
            externalModelId: selection.externalModelId,
            providerId: selection.providerId,
            capabilities: combined,
            synthetic: provider.synthetic,
          },
        });
    await transaction.auditLog.create({
      data: {
        action: existing ? "model-definition.configure-uses" : "model-definition.create",
        actorType: "USER",
        actorUserId,
        resourceId: model.id,
        resourceType: "ModelDefinition",
        stateBefore: existing ? { capabilities: existing.capabilities } : undefined,
        stateAfter: {
          capabilities: combined,
          providerId: selection.providerId,
          externalModelId: selection.externalModelId,
        },
      },
    });
    return model;
  }

  private requirePlatform() {
    const principal = this.access.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") throw new ForbiddenException("需要平台模型管理权限");
    return principal;
  }
}

export function parseAvailableModels(value: unknown): {
  models: AvailableModelDto[];
  hasMore: boolean;
  lastId?: string;
} {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data))
    throw new ConflictException("供应商返回的模型列表格式不受支持，可手动填写模型 ID");
  const models: AvailableModelDto[] = [];
  for (const row of value.data) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      !row.id.trim() ||
      row.id.length > 200
    )
      continue;
    const id = row.id.trim();
    const capabilities: string[] = [];
    const declared = Array.isArray(row.capabilities)
      ? row.capabilities
          .filter((c: unknown): c is string => typeof c === "string")
          .map((c: string) => c.toUpperCase())
      : [];
    for (const capability of ["TEXT", "IMAGE", "EMBEDDING", "VISION", "MULTIMODAL"])
      if (declared.includes(capability)) capabilities.push(capability);
    if (!capabilities.length) {
      if (/embedding|(?:^|\/)bge-(?!reranker)|(?:^|\/)e5-/iu.test(id))
        capabilities.push("EMBEDDING");
      else if (/dall-e|gpt-image|flux|stable-diffusion|(?:^|[-/])sdxl|seedream|imagen/iu.test(id))
        capabilities.push("IMAGE");
      else if (
        /gpt|claude|deepseek|qwen|gemini|llama|mistral|glm|doubao/iu.test(id) &&
        !/rerank|tts|audio|video|whisper/iu.test(id)
      )
        capabilities.push("TEXT");
    }
    models.push({ externalModelId: id, displayName: id, suggestedCapabilities: capabilities });
  }
  return {
    models,
    hasMore: "has_more" in value && value.has_more === true,
    lastId:
      "last_id" in value && typeof value.last_id === "string"
        ? value.last_id
        : models.at(-1)?.externalModelId,
  };
}
