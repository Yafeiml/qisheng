import type { CredentialResolver } from "./credential-resolver";
import {
  type ModelPricing,
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleImageProvider,
  type OpenAICompatibleProviderOptions,
  OpenAICompatibleTextProvider,
} from "./openai-compatible-provider";
import type {
  ImageGenerationProvider,
  TextEmbeddingProvider,
  TextGenerationProvider,
} from "./types";

export type ProviderProtocol = "OPENAI_COMPATIBLE" | "SYNTHETIC";

export interface RuntimeProviderDefinition {
  baseUrl: string;
  credentialRef: string;
  id: string;
  metadata?: Readonly<Record<string, unknown>>;
  modelPricing?: Readonly<Record<string, ModelPricing>>;
  protocol: ProviderProtocol;
  synthetic: boolean;
  timeoutMs: number;
}

export interface RuntimeProviderPair {
  embedding?: TextEmbeddingProvider;
  image: ImageGenerationProvider;
  text: TextGenerationProvider;
}

export async function createRuntimeProvider(
  definition: RuntimeProviderDefinition,
  credentials: CredentialResolver,
  fetcher?: typeof fetch,
): Promise<RuntimeProviderPair> {
  return createRuntimeProviderWithApiKey(
    definition,
    await credentials.resolve(definition.credentialRef),
    fetcher,
  );
}

export async function createRuntimeProviderWithApiKey(
  definition: Omit<RuntimeProviderDefinition, "credentialRef">,
  apiKey: string,
  fetcher?: typeof fetch,
): Promise<RuntimeProviderPair> {
  if (definition.synthetic || definition.protocol === "SYNTHETIC") {
    throw new Error("Synthetic providers must be registered through the development adapter");
  }
  if (definition.protocol !== "OPENAI_COMPATIBLE") {
    throw new Error(`Unsupported model provider protocol: ${definition.protocol}`);
  }
  const options: OpenAICompatibleProviderOptions = {
    apiKey,
    baseUrl: definition.baseUrl,
    fetch: fetcher,
    imageCost: numericMetadata(definition.metadata, "imageCost"),
    inputCostPerMillionUnits: numericMetadata(definition.metadata, "inputCostPerMillionUnits"),
    modelPricing: definition.modelPricing,
    outputCostPerMillionUnits: numericMetadata(definition.metadata, "outputCostPerMillionUnits"),
    providerId: definition.id,
    timeoutMs: definition.timeoutMs,
  };
  return {
    embedding: new OpenAICompatibleEmbeddingProvider(options),
    image: new OpenAICompatibleImageProvider(options),
    text: new OpenAICompatibleTextProvider(options),
  };
}

function numericMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Provider metadata ${key} must be a non-negative number`);
  }
  return value;
}
