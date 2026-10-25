import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { isProductionHttpsEndpoint } from "../platform-settings/publication-policy-evidence";
import type {
  ConfigureModelRouteDto,
  CreateModelDefinitionDto,
  CreateModelProviderDto,
  ResetModelProviderCircuitDto,
  RevokeModelProviderCredentialDto,
  RotateModelProviderCredentialDto,
  UpdateModelDefinitionDto,
  UpdateModelProviderDto,
} from "./model-configuration.dto";
import { ModelCredentialService } from "./model-credential.service";
import { ModelProviderHealthService } from "./model-provider-health.service";
import { ModelQualificationService } from "./model-qualification.service";

const PUBLIC_CREDENTIAL_SELECT = {
  createdAt: true,
  id: true,
  keyVersion: true,
  lastFour: true,
  status: true,
} as const satisfies Prisma.ModelProviderCredentialSelect;

const PROVIDER_RESPONSE_INCLUDE = {
  activeCredential: { select: PUBLIC_CREDENTIAL_SELECT },
  models: { orderBy: { createdAt: "asc" } },
} as const satisfies Prisma.ModelProviderInclude;

const ROUTE_INCLUDE = {
  imageModel: { include: { provider: { include: { activeCredential: true } } } },
  textModel: { include: { provider: { include: { activeCredential: true } } } },
} as const satisfies Prisma.ModelRouteInclude;

export type ResolvedModelRoute = Prisma.ModelRouteGetPayload<{ include: typeof ROUTE_INCLUDE }>;

export type FrozenGenerationRoute = Readonly<{
  requiresImage?: boolean;
  frozenAt: string;
  image: Readonly<{
    fallbacks: readonly GenerationModelSnapshot[];
    primary: GenerationModelSnapshot;
  }>;
  maxAttemptsPerModel: number;
  routeId: string;
  routeUpdatedAt: string;
  scopeId: string;
  scopeType: string;
  synthetic: boolean;
  text: Readonly<{
    fallbacks: readonly GenerationModelSnapshot[];
    primary: GenerationModelSnapshot;
  }>;
}>;

export type GenerationModelSnapshot = Readonly<{
  externalModelId: string;
  modelId: string;
  modelUpdatedAt: string;
  providerCode: string;
  providerId: string;
  providerProtocol: string;
  providerUpdatedAt: string;
  synthetic: boolean;
  tier: string;
}>;

@Injectable()
export class ModelConfigurationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(ModelCredentialService) private readonly credentials: ModelCredentialService,
    @Inject(ModelQualificationService)
    private readonly qualifications: ModelQualificationService,
    @Inject(ModelProviderHealthService) private readonly providerHealth: ModelProviderHealthService,
  ) {}

  async catalog() {
    this.requirePlatform();
    await this.providerHealth.refreshConfigured();
    const [providers, routes] = await Promise.all([
      this.prisma.modelProvider.findMany({
        include: PROVIDER_RESPONSE_INCLUDE,
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.modelRoute.findMany({
        include: ROUTE_INCLUDE,
        orderBy: { updatedAt: "desc" },
      }),
    ]);
    const qualificationByRoute = await this.qualifications.latestForRoutes(
      routes.map(({ id }) => id),
    );
    const runtimeHealthByRoute = await this.qualifications.runtimeHealthForRoutes(
      routes.map(({ id }) => id),
    );
    return {
      providers: providers.map(safeProvider),
      routes: routes.map((route) => ({
        ...safeRoute(route),
        qualification: qualificationByRoute.get(route.id) ?? null,
        runtimeHealth: runtimeHealthByRoute.get(route.id) ?? null,
      })),
    };
  }

  async createProvider(input: CreateModelProviderDto) {
    const principal = this.requirePlatform();
    const protocol = validateProviderConfiguration(input);
    const providerId = randomUUID();
    const credentialId = input.synthetic ? null : randomUUID();
    const encrypted =
      credentialId && input.apiKey
        ? this.credentials.encrypt(input.apiKey, providerId, credentialId)
        : null;
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.modelProvider.create({
          data: {
            baseUrl: input.baseUrl,
            code: input.code,
            id: providerId,
            name: input.name,
            protocol,
            synthetic: input.synthetic,
            timeoutMs: input.timeoutMs,
          },
        });
        if (credentialId && encrypted) {
          await transaction.modelProviderCredential.create({
            data: {
              authenticationTag: Buffer.from(encrypted.authenticationTag),
              ciphertext: Buffer.from(encrypted.ciphertext),
              createdBy: principal.userId,
              id: credentialId,
              initializationVector: Buffer.from(encrypted.initializationVector),
              keyVersion: encrypted.keyVersion,
              lastFour: encrypted.lastFour,
              providerId,
            },
          });
          await transaction.modelProvider.update({
            data: { activeCredentialId: credentialId },
            where: { id: providerId },
          });
        }
        await transaction.auditLog.create({
          data: {
            action: "model-provider.create",
            actorType: "USER",
            actorUserId: principal.userId,
            resourceId: providerId,
            resourceType: "ModelProvider",
            stateAfter: {
              code: input.code,
              credentialConfigured: Boolean(credentialId),
              protocol,
              synthetic: input.synthetic,
            },
          },
        });
        const provider = await transaction.modelProvider.findUniqueOrThrow({
          include: PROVIDER_RESPONSE_INCLUDE,
          where: { id: providerId },
        });
        return safeProvider(provider);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Model provider code already exists");
      }
      throw error;
    }
  }

  async rotateCredential(
    providerId: string,
    input: RotateModelProviderCredentialDto,
    client?: Prisma.TransactionClient,
  ) {
    const principal = this.requirePlatform();
    const credentialId = randomUUID();
    const encrypted = this.credentials.encrypt(input.apiKey, providerId, credentialId);
    const operation = async (transaction: Prisma.TransactionClient) => {
      const provider = await transaction.modelProvider.findUnique({
        select: { activeCredentialId: true, id: true, synthetic: true },
        where: { id: providerId },
      });
      if (!provider) throw new NotFoundException("Model provider was not found");
      if (provider.synthetic) {
        throw new ConflictException("Synthetic model providers do not use API credentials");
      }
      await transaction.modelProviderCredential.create({
        data: {
          authenticationTag: Buffer.from(encrypted.authenticationTag),
          ciphertext: Buffer.from(encrypted.ciphertext),
          createdBy: principal.userId,
          id: credentialId,
          initializationVector: Buffer.from(encrypted.initializationVector),
          keyVersion: encrypted.keyVersion,
          lastFour: encrypted.lastFour,
          providerId,
        },
      });
      await transaction.modelProvider.update({
        data: {
          activeCredentialId: credentialId,
          consecutiveHealthFailures: 0,
          healthStatus: "UNKNOWN",
          lastHealthErrorCode: null,
        },
        where: { id: providerId },
      });
      if (provider.activeCredentialId) {
        await transaction.modelProviderCredential.update({
          data: {
            revokeReason: input.reason,
            revokedAt: new Date(),
            revokedBy: principal.userId,
            status: "REVOKED",
          },
          where: { id: provider.activeCredentialId },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: "model-provider.credential.rotate",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceId: providerId,
          resourceType: "ModelProvider",
          stateAfter: {
            credentialId,
            keyVersion: encrypted.keyVersion,
            replacedCredentialId: provider.activeCredentialId,
          },
        },
      });
      return safeProvider(
        await transaction.modelProvider.findUniqueOrThrow({
          include: PROVIDER_RESPONSE_INCLUDE,
          where: { id: providerId },
        }),
      );
    };
    return client ? operation(client) : this.prisma.$transaction(operation);
  }

  async updateProvider(
    providerId: string,
    input: UpdateModelProviderDto,
    client?: Prisma.TransactionClient,
  ) {
    const principal = this.requirePlatform();
    if (!input.name && !input.baseUrl && !input.timeoutMs && !input.status) {
      throw new ConflictException("At least one provider setting must be changed");
    }
    const operation = async (transaction: Prisma.TransactionClient) => {
      const provider = await transaction.modelProvider.findUnique({
        include: { activeCredential: true, models: { select: { id: true } } },
        where: { id: providerId },
      });
      if (!provider) throw new NotFoundException("Model provider was not found");
      if (input.baseUrl) validateProviderBaseUrl(input.baseUrl, provider.synthetic);
      if (
        input.status === "ACTIVE" &&
        !provider.synthetic &&
        provider.activeCredential?.status !== "ACTIVE"
      ) {
        throw new ConflictException("A real provider cannot be enabled without credentials");
      }
      if (input.status === "DISABLED" && provider.status !== "DISABLED") {
        const modelIds = provider.models.map(({ id }) => id);
        const activeRouteCount = await transaction.modelRoute.count({
          where: {
            OR: [{ imageModelId: { in: modelIds } }, { textModelId: { in: modelIds } }],
          },
        });
        if (activeRouteCount > 0 && !input.emergency) {
          throw new ConflictException(
            "Provider is referenced by active routes; use emergency disable or replace the routes first",
          );
        }
      }
      await transaction.modelProvider.update({
        data: {
          baseUrl: input.baseUrl,
          healthStatus: input.baseUrl ? "UNKNOWN" : undefined,
          name: input.name,
          status: input.status,
          timeoutMs: input.timeoutMs,
        },
        where: { id: providerId },
      });
      await transaction.auditLog.create({
        data: {
          action: "model-provider.settings.update",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceId: providerId,
          resourceType: "ModelProvider",
          stateAfter: {
            baseUrlChanged: Boolean(input.baseUrl),
            emergency: input.emergency,
            name: input.name,
            reason: input.reason,
            status: input.status,
            timeoutMs: input.timeoutMs,
          },
        },
      });
      return safeProvider(
        await transaction.modelProvider.findUniqueOrThrow({
          include: PROVIDER_RESPONSE_INCLUDE,
          where: { id: providerId },
        }),
      );
    };
    return client ? operation(client) : this.prisma.$transaction(operation);
  }

  async revokeCredential(providerId: string, input: RevokeModelProviderCredentialDto) {
    const principal = this.requirePlatform();
    return this.prisma.$transaction(async (transaction) => {
      const provider = await transaction.modelProvider.findUnique({
        select: { activeCredentialId: true, id: true, synthetic: true },
        where: { id: providerId },
      });
      if (!provider) throw new NotFoundException("Model provider was not found");
      if (provider.synthetic) {
        throw new ConflictException("Synthetic model providers do not use API credentials");
      }
      if (!provider.activeCredentialId) {
        throw new ConflictException("Model provider has no active credential to revoke");
      }
      await transaction.modelProvider.update({
        data: {
          activeCredentialId: null,
          healthStatus: "UNKNOWN",
          lastHealthErrorCode: "CREDENTIAL_REVOKED",
        },
        where: { id: providerId },
      });
      await transaction.modelProviderCredential.update({
        data: {
          revokeReason: input.reason,
          revokedAt: new Date(),
          revokedBy: principal.userId,
          status: "REVOKED",
        },
        where: { id: provider.activeCredentialId },
      });
      await transaction.auditLog.create({
        data: {
          action: "model-provider.credential.revoke",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceId: providerId,
          resourceType: "ModelProvider",
          stateAfter: { credentialConfigured: false },
        },
      });
      return safeProvider(
        await transaction.modelProvider.findUniqueOrThrow({
          include: PROVIDER_RESPONSE_INCLUDE,
          where: { id: providerId },
        }),
      );
    });
  }

  async resetProviderCircuit(providerId: string, input: ResetModelProviderCircuitDto) {
    const principal = this.requirePlatform();
    return this.prisma.$transaction(async (transaction) => {
      const provider = await transaction.modelProvider.findUnique({
        include: PROVIDER_RESPONSE_INCLUDE,
        where: { id: providerId },
      });
      if (!provider) throw new NotFoundException("Model provider was not found");
      await transaction.modelProvider.update({
        data: {
          circuitOpenedAt: null,
          circuitOpenUntil: null,
          circuitProbeExpiresAt: null,
          circuitProbeToken: null,
          circuitState: "CLOSED",
          lastRuntimeErrorCode: null,
          runtimeFailureCount: 0,
        },
        where: { id: providerId },
      });
      await transaction.auditLog.create({
        data: {
          action: "model-provider.circuit.manual-reset",
          actorType: "USER",
          actorUserId: principal.userId,
          reason: input.reason,
          resourceId: providerId,
          resourceType: "ModelProvider",
          stateBefore: {
            circuitOpenUntil: provider.circuitOpenUntil?.toISOString() ?? null,
            circuitState: provider.circuitState,
            runtimeFailureCount: provider.runtimeFailureCount,
          },
          stateAfter: { circuitState: "CLOSED", runtimeFailureCount: 0 },
        },
      });
      return safeProvider(
        await transaction.modelProvider.findUniqueOrThrow({
          include: PROVIDER_RESPONSE_INCLUDE,
          where: { id: providerId },
        }),
      );
    });
  }

  async testConnection(providerId: string) {
    const principal = this.requirePlatform();
    return this.providerHealth.testConnection(providerId, principal.userId);
  }

  async createModel(providerId: string, input: CreateModelDefinitionDto) {
    const principal = this.requirePlatform();
    const capabilities = [...new Set(input.capabilities)];
    const metadata = validateModelMetadata(input.metadata);
    if (metadata.embeddingProfile !== undefined && !capabilities.includes("EMBEDDING")) {
      throw new ConflictException("向量模型适配只能用于声明了 EMBEDDING 能力的模型");
    }
    if (capabilities.length === 0) {
      throw new ConflictException("At least one model capability is required");
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const provider = await transaction.modelProvider.findFirst({
          select: { id: true, synthetic: true },
          where: { id: providerId, status: "ACTIVE" },
        });
        if (!provider) throw new NotFoundException("Active model provider was not found");
        if (input.synthetic !== provider.synthetic) {
          throw new ConflictException("Model and provider synthetic flags must match");
        }
        const model = await transaction.modelDefinition.create({
          data: {
            capabilities,
            code: input.code,
            displayName: input.displayName,
            externalModelId: input.externalModelId,
            metadata: metadata as Prisma.InputJsonValue,
            providerId,
            synthetic: input.synthetic,
            tier: input.tier,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: "model-definition.create",
            actorType: "USER",
            actorUserId: principal.userId,
            resourceId: model.id,
            resourceType: "ModelDefinition",
            stateAfter: { capabilities, code: model.code, providerId, tier: model.tier },
          },
        });
        return model;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Model code already exists for this provider");
      }
      throw error;
    }
  }

  async updateModel(modelId: string, input: UpdateModelDefinitionDto) {
    const principal = this.requirePlatform();
    if (!input.displayName && !input.status) {
      throw new ConflictException("At least one model setting must be changed");
    }
    return this.prisma.$transaction(async (transaction) => {
      const model = await transaction.modelDefinition.findUnique({
        include: { provider: { include: { activeCredential: true } } },
        where: { id: modelId },
      });
      if (!model) throw new NotFoundException("Model definition was not found");
      if (input.status === "ACTIVE") {
        if (model.provider.status !== "ACTIVE") {
          throw new ConflictException("A model cannot be enabled while its provider is disabled");
        }
        if (!model.provider.synthetic && model.provider.activeCredential?.status !== "ACTIVE") {
          throw new ConflictException("A model cannot be enabled without provider credentials");
        }
      }
      if (input.status === "DISABLED" && model.status !== "DISABLED") {
        const activeRouteCount = await transaction.modelRoute.count({
          where: { OR: [{ imageModelId: modelId }, { textModelId: modelId }] },
        });
        if (activeRouteCount > 0 && !input.emergency) {
          throw new ConflictException(
            "Model is referenced by active routes; use emergency disable or replace the routes first",
          );
        }
      }
      const updated = await transaction.modelDefinition.update({
        data: { displayName: input.displayName, status: input.status },
        where: { id: modelId },
      });
      await transaction.auditLog.create({
        data: {
          action: "model-definition.settings.update",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceId: modelId,
          resourceType: "ModelDefinition",
          stateAfter: {
            displayName: input.displayName,
            emergency: input.emergency,
            reason: input.reason,
            status: input.status,
          },
        },
      });
      return updated;
    });
  }

  async configureRoute(input: ConfigureModelRouteDto, client?: Prisma.TransactionClient) {
    const principal = this.requirePlatform();
    validateScopeShape(input);
    const configure = async (transaction: Prisma.TransactionClient) => {
      await requireScopeTarget(transaction, input);
      const [textModel, imageModel] = await Promise.all([
        transaction.modelDefinition.findFirst({
          include: { provider: true },
          where: { id: input.textModelId, provider: { status: "ACTIVE" }, status: "ACTIVE" },
        }),
        transaction.modelDefinition.findFirst({
          include: { provider: true },
          where: { id: input.imageModelId, provider: { status: "ACTIVE" }, status: "ACTIVE" },
        }),
      ]);
      if (!textModel || !supports(textModel.capabilities, "TEXT")) {
        throw new ConflictException("Selected text model is inactive or lacks TEXT capability");
      }
      if (!imageModel || !supports(imageModel.capabilities, "IMAGE")) {
        throw new ConflictException("Selected image model is inactive or lacks IMAGE capability");
      }
      const textFallbackModelIds = normalizeFallbackIds(
        input.textFallbackModelIds,
        textModel.id,
        "text",
      );
      const imageFallbackModelIds = normalizeFallbackIds(
        input.imageFallbackModelIds,
        imageModel.id,
        "image",
      );
      const fallbackModels = await transaction.modelDefinition.findMany({
        include: { provider: true },
        where: {
          id: { in: [...textFallbackModelIds, ...imageFallbackModelIds] },
          provider: { status: "ACTIVE" },
          status: "ACTIVE",
        },
      });
      if (fallbackModels.length !== textFallbackModelIds.length + imageFallbackModelIds.length) {
        throw new ConflictException("One or more fallback models are inactive or unavailable");
      }
      const fallbackById = new Map(fallbackModels.map((model) => [model.id, model]));
      if (
        textFallbackModelIds.some(
          (id) => !supports(fallbackById.get(id)?.capabilities ?? [], "TEXT"),
        )
      ) {
        throw new ConflictException("A text fallback model lacks TEXT capability");
      }
      if (
        imageFallbackModelIds.some(
          (id) => !supports(fallbackById.get(id)?.capabilities ?? [], "IMAGE"),
        )
      ) {
        throw new ConflictException("An image fallback model lacks IMAGE capability");
      }
      const selectedModels = [textModel, imageModel, ...fallbackModels];
      if (selectedModels.some((model) => model.synthetic !== model.provider.synthetic)) {
        throw new ConflictException("Model and provider synthetic flags are inconsistent");
      }
      const syntheticKinds = new Set(selectedModels.map((model) => model.synthetic));
      if (syntheticKinds.size !== 1) {
        throw new ConflictException("A model route cannot mix synthetic and real models");
      }
      const route = await transaction.modelRoute.upsert({
        create: {
          createdBy: principal.userId,
          enterpriseId: input.enterpriseId,
          imageModelId: imageModel.id,
          imageFallbackModelIds,
          maxAttemptsPerModel: input.maxAttemptsPerModel,
          scopeId: input.scopeId,
          scopeType: input.scopeType,
          tenantId: input.tenantId,
          textModelId: textModel.id,
          textFallbackModelIds,
        },
        update: {
          enterpriseId: input.enterpriseId,
          imageModelId: imageModel.id,
          imageFallbackModelIds,
          maxAttemptsPerModel: input.maxAttemptsPerModel,
          tenantId: input.tenantId,
          textModelId: textModel.id,
          textFallbackModelIds,
        },
        where: {
          scopeType_scopeId: { scopeId: input.scopeId, scopeType: input.scopeType },
        },
        include: ROUTE_INCLUDE,
      });
      await transaction.auditLog.create({
        data: {
          action: "model-route.configure",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: input.enterpriseId,
          resourceId: route.id,
          resourceType: "ModelRoute",
          stateAfter: {
            imageModelId: imageModel.id,
            imageFallbackModelIds,
            maxAttemptsPerModel: route.maxAttemptsPerModel,
            scopeId: route.scopeId,
            scopeType: route.scopeType,
            textModelId: textModel.id,
            textFallbackModelIds,
          },
          tenantId: input.tenantId,
        },
      });
      return safeRoute(route);
    };
    return client ? configure(client) : this.prisma.$transaction(configure);
  }

  async resolveRoute(
    tenantId: string,
    enterpriseId: string,
    requiresImage = true,
  ): Promise<ResolvedModelRoute> {
    const routes = await this.prisma.modelRoute.findMany({
      include: ROUTE_INCLUDE,
      where: {
        OR: [
          { enterpriseId, scopeId: enterpriseId, scopeType: "ENTERPRISE", tenantId },
          {
            enterpriseId: null,
            scopeId: tenantId,
            scopeType: "TENANT",
            tenantId,
          },
          {
            enterpriseId: null,
            scopeId: "platform",
            scopeType: "PLATFORM",
            tenantId: null,
          },
        ],
      },
    });
    const route =
      routes.find(({ scopeType }) => scopeType === "ENTERPRISE") ??
      routes.find(({ scopeType }) => scopeType === "TENANT") ??
      routes.find(({ scopeType }) => scopeType === "PLATFORM");
    if (!route) {
      throw new ConflictException("No model route is configured for this enterprise");
    }
    if (
      route.textModel.status !== "ACTIVE" ||
      (requiresImage && route.imageModel.status !== "ACTIVE") ||
      route.textModel.provider.status !== "ACTIVE" ||
      (requiresImage && route.imageModel.provider.status !== "ACTIVE")
    ) {
      throw new ConflictException("Resolved model route contains a disabled model resource");
    }
    for (const provider of requiresImage
      ? [route.textModel.provider, route.imageModel.provider]
      : [route.textModel.provider]) {
      if (!provider.synthetic && provider.activeCredential?.status !== "ACTIVE") {
        throw new ConflictException("Resolved model route contains a provider without credentials");
      }
    }
    return route;
  }

  async freezeGenerationRoute(
    tenantId: string,
    enterpriseId: string,
    requiresImage = true,
  ): Promise<FrozenGenerationRoute> {
    const route = await this.resolveRoute(tenantId, enterpriseId, requiresImage);
    const fallbackIds = [
      ...route.textFallbackModelIds,
      ...(requiresImage ? route.imageFallbackModelIds : []),
    ];
    const fallbackModels = await this.prisma.modelDefinition.findMany({
      include: { provider: { include: { activeCredential: true } } },
      where: {
        id: { in: fallbackIds },
        provider: { status: "ACTIVE" },
        status: "ACTIVE",
      },
    });
    if (fallbackModels.length !== fallbackIds.length) {
      throw new ConflictException("Resolved model route contains an unavailable fallback model");
    }
    const byId = new Map(fallbackModels.map((model) => [model.id, model]));
    const textFallbacks = route.textFallbackModelIds.map((id) => {
      const model = byId.get(id);
      if (!model || !supports(model.capabilities, "TEXT")) {
        throw new ConflictException("Resolved text fallback lacks TEXT capability");
      }
      return modelSnapshot(model);
    });
    const imageFallbacks = (requiresImage ? route.imageFallbackModelIds : []).map((id) => {
      const model = byId.get(id);
      if (!model || !supports(model.capabilities, "IMAGE")) {
        throw new ConflictException("Resolved image fallback lacks IMAGE capability");
      }
      return modelSnapshot(model);
    });
    const textPrimary = modelSnapshot(route.textModel);
    const imagePrimary = modelSnapshot(route.imageModel);
    const allModels = [
      textPrimary,
      ...textFallbacks,
      ...(requiresImage ? [imagePrimary, ...imageFallbacks] : []),
    ];
    const synthetic = allModels.every((model) => model.synthetic);
    if (!synthetic && allModels.some((model) => model.synthetic)) {
      throw new ConflictException("A generation route cannot mix synthetic and real models");
    }
    return Object.freeze({
      frozenAt: new Date().toISOString(),
      requiresImage,
      image: Object.freeze({
        fallbacks: Object.freeze(imageFallbacks),
        primary: imagePrimary,
      }),
      maxAttemptsPerModel: route.maxAttemptsPerModel,
      routeId: route.id,
      routeUpdatedAt: route.updatedAt.toISOString(),
      scopeId: route.scopeId,
      scopeType: route.scopeType,
      synthetic,
      text: Object.freeze({
        fallbacks: Object.freeze(textFallbacks),
        primary: textPrimary,
      }),
    });
  }

  private requirePlatform() {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ForbiddenException("Model configuration requires platform scope");
    }
    return principal;
  }
}

function validateScopeShape(input: ConfigureModelRouteDto): void {
  const valid =
    (input.scopeType === "PLATFORM" &&
      input.scopeId === "platform" &&
      !input.tenantId &&
      !input.enterpriseId) ||
    (input.scopeType === "TENANT" &&
      input.scopeId === input.tenantId &&
      Boolean(input.tenantId) &&
      !input.enterpriseId) ||
    (input.scopeType === "ENTERPRISE" &&
      input.scopeId === input.enterpriseId &&
      Boolean(input.tenantId) &&
      Boolean(input.enterpriseId));
  if (!valid) throw new ConflictException("Model route scope fields are inconsistent");
}

async function requireScopeTarget(
  transaction: Prisma.TransactionClient,
  input: ConfigureModelRouteDto,
): Promise<void> {
  if (input.scopeType === "PLATFORM") return;
  if (input.scopeType === "TENANT") {
    const tenant = await transaction.tenant.findUnique({ where: { id: input.tenantId } });
    if (!tenant) throw new NotFoundException("Model route tenant was not found");
    return;
  }
  const enterprise = await transaction.enterprise.findFirst({
    where: { id: input.enterpriseId, tenantId: input.tenantId },
  });
  if (!enterprise)
    throw new NotFoundException("Model route enterprise was not found in the tenant");
}

function supports(capabilities: readonly string[], capability: "TEXT" | "IMAGE"): boolean {
  return capabilities.includes(capability) || capabilities.includes("MULTIMODAL");
}

function normalizeFallbackIds(
  values: readonly string[],
  primaryId: string,
  label: string,
): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length || new Set(normalized).size !== normalized.length) {
    throw new ConflictException(`${label} fallback model IDs must be non-empty and unique`);
  }
  if (normalized.includes(primaryId)) {
    throw new ConflictException(`${label} primary model cannot also be a fallback model`);
  }
  return normalized;
}

function validateProviderConfiguration(
  input: CreateModelProviderDto,
): "OPENAI_COMPATIBLE" | "SYNTHETIC" {
  const protocol = input.protocol ?? (input.synthetic ? "SYNTHETIC" : "OPENAI_COMPATIBLE");
  if (input.synthetic !== (protocol === "SYNTHETIC")) {
    throw new ConflictException("Provider protocol and synthetic flag are inconsistent");
  }
  if (input.synthetic && input.apiKey) {
    throw new ConflictException("Synthetic model providers do not accept API credentials");
  }
  if (!input.synthetic && !input.apiKey) {
    throw new ConflictException("A platform-managed API key is required for a real provider");
  }
  validateProviderBaseUrl(input.baseUrl, input.synthetic);
  return protocol;
}

function validateProviderBaseUrl(value: string, synthetic: boolean): void {
  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new ConflictException("Model provider Base URL must be absolute");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new ConflictException("Model provider Base URL cannot contain credentials or query data");
  }
  if (synthetic) {
    if (baseUrl.protocol !== "synthetic:") {
      throw new ConflictException("Synthetic model providers must use a synthetic:// Base URL");
    }
  } else if (
    (process.env.NODE_ENV === "production" && !isProductionHttpsEndpoint(value)) ||
    (process.env.NODE_ENV !== "production" &&
      baseUrl.protocol !== "https:" &&
      baseUrl.protocol !== "http:")
  ) {
    throw new ConflictException(
      process.env.NODE_ENV === "production"
        ? "Real model provider Base URL must use public HTTPS"
        : "Real model provider Base URL must use HTTP or HTTPS",
    );
  }
}

function safeRoute(route: ResolvedModelRoute) {
  return {
    ...route,
    imageModel: {
      ...route.imageModel,
      provider: safeProvider(route.imageModel.provider),
    },
    textModel: {
      ...route.textModel,
      provider: safeProvider(route.textModel.provider),
    },
  };
}

function safeProvider<
  T extends {
    activeCredential: {
      createdAt: Date;
      keyVersion: string;
      lastFour: string;
      status: string;
    } | null;
    activeCredentialId: string | null;
    circuitProbeExpiresAt: Date | null;
    circuitProbeToken: string | null;
    lastHealthCheckedAt: Date | null;
    lastHealthErrorCode: string | null;
    lastHealthLatencyMs: number | null;
    synthetic: boolean;
  },
>(provider: T) {
  const {
    activeCredential,
    activeCredentialId: _activeCredentialId,
    circuitProbeExpiresAt: _circuitProbeExpiresAt,
    circuitProbeToken: _circuitProbeToken,
    ...safe
  } = provider;
  const credentialConfigured = provider.synthetic || Boolean(activeCredential?.status === "ACTIVE");
  return {
    ...safe,
    credentialConfigured,
    credentialHint: provider.synthetic
      ? "无需凭据"
      : activeCredential
        ? `•••• ${activeCredential.lastFour}`
        : undefined,
    credentialKeyVersion: activeCredential?.keyVersion,
    credentialRequired: !provider.synthetic,
    credentialRotatedAt: activeCredential?.createdAt,
    lastHealthCheckedAt: provider.lastHealthCheckedAt ?? undefined,
    lastHealthErrorCode: provider.lastHealthErrorCode ?? undefined,
    lastHealthLatencyMs: provider.lastHealthLatencyMs ?? undefined,
  };
}

function modelSnapshot(model: ResolvedModelRoute["textModel"]): GenerationModelSnapshot {
  const synthetic = model.synthetic && model.provider.synthetic;
  if (model.synthetic !== model.provider.synthetic) {
    throw new ConflictException("Model and provider synthetic flags are inconsistent");
  }
  return Object.freeze({
    externalModelId: model.externalModelId,
    modelId: model.id,
    modelUpdatedAt: model.updatedAt.toISOString(),
    providerCode: model.provider.code,
    providerId: model.provider.id,
    providerProtocol: model.provider.protocol,
    providerUpdatedAt: model.provider.updatedAt.toISOString(),
    synthetic,
    tier: model.tier,
  });
}

function validateModelMetadata(metadata: Record<string, unknown> | undefined) {
  const result: Record<string, number | string> = {};
  if (metadata?.embeddingProfile !== undefined) {
    if (metadata.embeddingProfile !== "GENERIC" && metadata.embeddingProfile !== "QWEN3_0_6B") {
      throw new ConflictException("Unsupported embedding profile");
    }
    result.embeddingProfile = metadata.embeddingProfile;
  }
  for (const key of [
    "imageCost",
    "inputCostPerMillionUnits",
    "outputCostPerMillionUnits",
  ] as const) {
    const value = metadata?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ConflictException(`Model metadata ${key} must be a non-negative number`);
    }
    result[key] = value;
  }
  return result;
}
