import {
  createRuntimeProviderWithApiKey,
  type ImageGenerationRequest,
  ModelCredentialCipher,
  type ModelPricing,
  ModelRouter,
  modelCredentialAssociatedData,
  RoutedGenerationAdapter,
  type TextGenerationRequest,
} from "@xhs-agentic/ai-gateway";
import type { Prisma, PrismaClient } from "@xhs-agentic/database";
import { ProviderCircuitBreaker } from "./provider-circuit-breaker";
import { ProviderInvocationLimiter } from "./provider-invocation-limiter";
export type InvocationObserver = <T>(
  input: {
    kind: "TEXT" | "IMAGE";
    modelId: string;
    providerId: string;
    pricing: ModelPricing;
    request: TextGenerationRequest | ImageGenerationRequest;
  },
  execute: () => Promise<T>,
) => Promise<T>;
export type FrozenModel = {
  externalModelId: string;
  modelId: string;
  providerCode: string;
  providerId: string;
};

export type FrozenRoute = {
  image: { fallbacks: FrozenModel[]; primary: FrozenModel };
  maxAttemptsPerModel: number;
  routeId: string;
  scopeId: string;
  scopeType: "ENTERPRISE" | "PLAN" | "PLATFORM" | "TENANT";
  synthetic: boolean;
  text: { fallbacks: FrozenModel[]; primary: FrozenModel };
};
export async function createRoutedAdapter(
  prisma: PrismaClient,
  generationRunId: string,
  route: FrozenRoute,
  observer?: InvocationObserver,
  circuitBreaker = new ProviderCircuitBreaker(prisma, {
    cooldownMs: 60000,
    failureThreshold: 5,
    probeLeaseMs: 120000,
  }),
  invocationLimiter = new ProviderInvocationLimiter(prisma),
  imageRequired = true,
) {
  const snapshots = [
    route.text.primary,
    ...route.text.fallbacks,
    ...(imageRequired ? [route.image.primary, ...route.image.fallbacks] : []),
  ];
  const providerIds = [...new Set(snapshots.map((snapshot) => snapshot.providerId))];
  const modelIds = [...new Set(snapshots.map((snapshot) => snapshot.modelId))];
  const [providers, models] = await Promise.all([
    prisma.modelProvider.findMany({
      include: { activeCredential: true },
      where: { id: { in: providerIds }, status: "ACTIVE", synthetic: false },
    }),
    prisma.modelDefinition.findMany({
      where: { id: { in: modelIds }, status: "ACTIVE", synthetic: false },
    }),
  ]);
  if (providers.length !== providerIds.length || models.length !== modelIds.length) {
    throw new Error("One or more frozen model providers are unavailable");
  }
  const snapshotByModelId = new Map(snapshots.map((snapshot) => [snapshot.modelId, snapshot]));
  for (const model of models) {
    const snapshot = snapshotByModelId.get(model.id);
    if (
      !snapshot ||
      snapshot.providerId !== model.providerId ||
      snapshot.externalModelId !== model.externalModelId
    ) {
      throw new Error("A frozen model no longer matches its model directory identity");
    }
  }
  const credentialCipher = ModelCredentialCipher.fromEnvironment();
  const runtimeProviders = await Promise.all(
    providers.map(async (provider) => {
      const credential = provider.activeCredential;
      if (credential?.status !== "ACTIVE") {
        throw new Error("A frozen model provider has no active platform credential");
      }
      const apiKey = credentialCipher.decrypt(
        {
          authenticationTag: credential.authenticationTag,
          ciphertext: credential.ciphertext,
          initializationVector: credential.initializationVector,
          keyVersion: credential.keyVersion,
        },
        modelCredentialAssociatedData(provider.id, credential.id),
      );
      const runtimeProvider = await createRuntimeProviderWithApiKey(
        {
          baseUrl: provider.baseUrl,
          id: provider.id,
          modelPricing: Object.fromEntries(
            models
              .filter((model) => model.providerId === provider.id)
              .map((model) => [model.externalModelId, modelPricing(model.metadata)]),
          ),
          protocol: provider.protocol,
          synthetic: provider.synthetic,
          timeoutMs: provider.timeoutMs,
        },
        apiKey,
      );
      const protectedProvider = circuitBreaker.wrap(runtimeProvider);
      const observe = <T>(
        kind: "TEXT" | "IMAGE",
        modelId: string,
        request: TextGenerationRequest | ImageGenerationRequest,
        execute: () => Promise<T>,
      ) =>
        observer
          ? observer(
              {
                kind,
                modelId,
                providerId: provider.id,
                pricing: modelPricing(
                  models.find((m) => m.providerId === provider.id && m.externalModelId === modelId)
                    ?.metadata ?? null,
                ),
                request,
              },
              execute,
            )
          : execute();
      return {
        image: {
          generate: (modelId: string, request: ImageGenerationRequest) =>
            invocationLimiter.withLease(provider.id, "IMAGE", provider.timeoutMs, () =>
              observe("IMAGE", modelId, request, () =>
                protectedProvider.image.generate(modelId, request),
              ),
            ),
          providerId: protectedProvider.image.providerId,
        },
        text: {
          generate: (modelId: string, request: TextGenerationRequest) =>
            invocationLimiter.withLease(provider.id, "TEXT", provider.timeoutMs, () =>
              observe("TEXT", modelId, request, () =>
                protectedProvider.text.generate(modelId, request),
              ),
            ),
          providerId: protectedProvider.text.providerId,
        },
      };
    }),
  );
  const router = new ModelRouter(
    runtimeProviders.map((provider) => provider.text),
    runtimeProviders.map((provider) => provider.image),
  );
  const textBase = {
    fallbackModels: route.text.fallbacks.map(modelCandidate),
    kind: "TEXT" as const,
    maxAttemptsPerModel: route.maxAttemptsPerModel,
    primaryModel: modelCandidate(route.text.primary),
    scopeId: route.scopeId,
    scopeType: route.scopeType,
    version: 1,
  };
  const adapter = new RoutedGenerationAdapter(router, {
    blueprint: router.freezePolicy({
      ...textBase,
      id: `${generationRunId}:blueprint`,
      taskKind: "CAMPAIGN_BLUEPRINT",
    }),
    employeeCopy: router.freezePolicy({
      ...textBase,
      id: `${generationRunId}:employee-copy`,
      taskKind: "EMPLOYEE_COPY",
    }),
    employeeImage: router.freezePolicy({
      fallbackModels: route.image.fallbacks.map(modelCandidate),
      id: `${generationRunId}:employee-image`,
      kind: "IMAGE",
      maxAttemptsPerModel: route.maxAttemptsPerModel,
      primaryModel: modelCandidate(route.image.primary),
      scopeId: route.scopeId,
      scopeType: route.scopeType,
      taskKind: "EMPLOYEE_IMAGE",
      version: 1,
    }),
  });
  return {
    adapter,
    providerCodes: new Map(providers.map((provider) => [provider.id, provider.code])),
  };
}
function modelCandidate(model: FrozenModel) {
  return { modelId: model.externalModelId, providerId: model.providerId };
}

export function modelPricing(metadata: Prisma.JsonValue | null): ModelPricing {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {};
  return {
    imageCost: nonNegativeNumber(metadata.imageCost),
    inputCostPerMillionUnits: nonNegativeNumber(metadata.inputCostPerMillionUnits),
    outputCostPerMillionUnits: nonNegativeNumber(metadata.outputCostPerMillionUnits),
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
