export type ModelKind = "EMBEDDING" | "IMAGE" | "TEXT" | "VISION";

export type ModelTaskKind =
  | "CAMPAIGN_BLUEPRINT"
  | "EMPLOYEE_COPY"
  | "EMPLOYEE_IMAGE"
  | "IMAGE_MATCH"
  | "TEXT_EMBEDDING";

export type RoutingScopeType = "ENTERPRISE" | "PLAN" | "PLATFORM" | "TENANT";

export interface ModelCandidate {
  modelId: string;
  providerId: string;
}

export interface RoutingPolicyDefinition {
  fallbackModels: readonly ModelCandidate[];
  id: string;
  kind: ModelKind;
  maxAttemptsPerModel: number;
  primaryModel: ModelCandidate;
  scopeId?: string;
  scopeType: RoutingScopeType;
  taskKind: ModelTaskKind;
  version: number;
}

export interface FrozenRoutingPolicy extends RoutingPolicyDefinition {
  fallbackModels: readonly Readonly<ModelCandidate>[];
  primaryModel: Readonly<ModelCandidate>;
  resolvedAt: string;
}

export interface InvocationContext {
  campaignId?: string;
  enterpriseId?: string;
  generationRunId: string;
  tenantId: string;
}

export interface GenerationUsage {
  estimatedCost: number;
  inputUnits?: number;
  outputUnits?: number;
}

export interface TextGenerationRequest {
  context: InvocationContext;
  images?: readonly Readonly<{
    bytes: Uint8Array;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
  }>[];
  maxOutputCharacters?: number;
  prompt: string;
  temperature?: number;
}

export interface TextGenerationOutput {
  finishReason: string;
  providerRequestId: string;
  text: string;
  usage: GenerationUsage;
}

export interface ImageGenerationRequest {
  referenceImages?: readonly { bytes: Uint8Array; mimeType: string; description: string }[];
  context: InvocationContext;
  height: number;
  prompt: string;
  seed: string;
  width: number;
}

export interface ImageGenerationOutput {
  bytes: Uint8Array;
  height: number;
  mimeType: string;
  providerRequestId: string;
  usage: GenerationUsage;
  width: number;
}

export interface TextGenerationProvider {
  readonly providerId: string;
  generate(modelId: string, request: TextGenerationRequest): Promise<TextGenerationOutput>;
}

export interface ImageGenerationProvider {
  readonly providerId: string;
  generate(modelId: string, request: ImageGenerationRequest): Promise<ImageGenerationOutput>;
}

export interface TextEmbeddingOutput {
  dimensions: number;
  providerRequestId: string;
  usage: GenerationUsage;
  vectors: readonly (readonly number[])[];
}

export interface TextEmbeddingProvider {
  readonly providerId: string;
  embed(
    modelId: string,
    texts: readonly string[],
    options?: TextEmbeddingOptions,
  ): Promise<TextEmbeddingOutput>;
}

export interface TextEmbeddingOptions {
  inputKind: "QUERY" | "DOCUMENT";
  profile?: import("./embedding-profile").EmbeddingProfile;
}

export interface InvocationAttempt {
  attempt: number;
  estimatedCost?: number;
  errorCode?: string;
  inputUnits?: number;
  latencyMs: number;
  modelId: string;
  outputUnits?: number;
  providerId: string;
  providerRequestId?: string;
  retryable?: boolean;
  status: "FAILED" | "SUCCEEDED";
}

export interface RoutedGenerationResult<T> {
  attempts: readonly InvocationAttempt[];
  modelId: string;
  output: T;
  policy: FrozenRoutingPolicy;
  providerId: string;
}

export interface ValidatedTextGenerationResult<T>
  extends RoutedGenerationResult<TextGenerationOutput> {
  value: T;
}
