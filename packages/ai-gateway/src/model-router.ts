import { ModelRoutingError, ProviderInvocationError } from "./errors";
import type {
  FrozenRoutingPolicy,
  ImageGenerationOutput,
  ImageGenerationProvider,
  ImageGenerationRequest,
  InvocationAttempt,
  ModelCandidate,
  RoutedGenerationResult,
  RoutingPolicyDefinition,
  TextGenerationOutput,
  TextGenerationProvider,
  TextGenerationRequest,
  ValidatedTextGenerationResult,
} from "./types";

export class ModelRouter {
  private readonly imageProviders: ReadonlyMap<string, ImageGenerationProvider>;
  private readonly textProviders: ReadonlyMap<string, TextGenerationProvider>;

  constructor(
    textProviders: readonly TextGenerationProvider[],
    imageProviders: readonly ImageGenerationProvider[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.textProviders = this.indexProviders(textProviders);
    this.imageProviders = this.indexProviders(imageProviders);
  }

  freezePolicy(definition: RoutingPolicyDefinition): FrozenRoutingPolicy {
    if (!Number.isInteger(definition.maxAttemptsPerModel) || definition.maxAttemptsPerModel < 1) {
      throw new ModelRoutingError("maxAttemptsPerModel must be a positive integer", []);
    }

    const allCandidates = [definition.primaryModel, ...definition.fallbackModels];
    const candidateKeys = new Set(allCandidates.map(this.candidateKey));
    if (candidateKeys.size !== allCandidates.length) {
      throw new ModelRoutingError("Routing policy contains duplicate model candidates", []);
    }

    return Object.freeze({
      ...definition,
      fallbackModels: Object.freeze(
        definition.fallbackModels.map((candidate) => Object.freeze({ ...candidate })),
      ),
      primaryModel: Object.freeze({ ...definition.primaryModel }),
      resolvedAt: this.now().toISOString(),
    });
  }

  async generateText(
    policy: FrozenRoutingPolicy,
    request: TextGenerationRequest,
  ): Promise<RoutedGenerationResult<TextGenerationOutput>> {
    if (policy.kind !== "TEXT") {
      throw new ModelRoutingError(`Expected TEXT policy, received ${policy.kind}`, []);
    }

    const attempts: InvocationAttempt[] = [];
    for (const candidate of this.candidates(policy)) {
      const provider = this.textProviders.get(candidate.providerId);
      if (!provider) {
        attempts.push(this.failedAttempt(candidate, 1, "PROVIDER_NOT_REGISTERED", 0, false));
        continue;
      }

      for (let attempt = 1; attempt <= policy.maxAttemptsPerModel; attempt += 1) {
        const startedAt = Date.now();
        try {
          const output = await provider.generate(candidate.modelId, request);
          attempts.push(this.succeededAttempt(candidate, attempt, Date.now() - startedAt, output));
          return {
            attempts: Object.freeze(attempts),
            modelId: candidate.modelId,
            output,
            policy,
            providerId: candidate.providerId,
          };
        } catch (error) {
          const normalized = this.normalizeError(error);
          attempts.push(
            this.failedAttempt(
              candidate,
              attempt,
              normalized.code,
              Date.now() - startedAt,
              normalized.retryable,
            ),
          );
          if (!normalized.retryable) {
            throw new ModelRoutingError(
              "Text generation failed with a non-retryable error",
              attempts,
            );
          }
        }
      }
    }

    throw new ModelRoutingError("All text model candidates failed", attempts);
  }

  async generateTextValidated<T>(
    policy: FrozenRoutingPolicy,
    request: TextGenerationRequest,
    validate: (output: TextGenerationOutput) => T,
  ): Promise<ValidatedTextGenerationResult<T>> {
    if (policy.kind !== "TEXT") {
      throw new ModelRoutingError(`Expected TEXT policy, received ${policy.kind}`, []);
    }
    const attempts: InvocationAttempt[] = [];
    for (const candidate of this.candidates(policy)) {
      const provider = this.textProviders.get(candidate.providerId);
      if (!provider) {
        attempts.push(this.failedAttempt(candidate, 1, "PROVIDER_NOT_REGISTERED", 0, false));
        continue;
      }
      for (let attempt = 1; attempt <= policy.maxAttemptsPerModel; attempt += 1) {
        const startedAt = Date.now();
        let output: TextGenerationOutput | undefined;
        try {
          output = await provider.generate(candidate.modelId, request);
          const value = validate(output);
          attempts.push(this.succeededAttempt(candidate, attempt, Date.now() - startedAt, output));
          return {
            attempts: Object.freeze(attempts),
            modelId: candidate.modelId,
            output,
            policy,
            providerId: candidate.providerId,
            value,
          };
        } catch (error) {
          const normalized = this.normalizeError(error);
          attempts.push(
            this.failedAttempt(
              candidate,
              attempt,
              normalized.code,
              Date.now() - startedAt,
              normalized.retryable,
              output,
            ),
          );
          if (!normalized.retryable) {
            throw new ModelRoutingError(
              "Validated text generation failed with a non-retryable error",
              attempts,
            );
          }
        }
      }
    }
    throw new ModelRoutingError("All validated text model candidates failed", attempts);
  }

  async generateImage(
    policy: FrozenRoutingPolicy,
    request: ImageGenerationRequest,
  ): Promise<RoutedGenerationResult<ImageGenerationOutput>> {
    if (policy.kind !== "IMAGE") {
      throw new ModelRoutingError(`Expected IMAGE policy, received ${policy.kind}`, []);
    }

    const attempts: InvocationAttempt[] = [];
    for (const candidate of this.candidates(policy)) {
      const provider = this.imageProviders.get(candidate.providerId);
      if (!provider) {
        attempts.push(this.failedAttempt(candidate, 1, "PROVIDER_NOT_REGISTERED", 0, false));
        continue;
      }

      for (let attempt = 1; attempt <= policy.maxAttemptsPerModel; attempt += 1) {
        const startedAt = Date.now();
        try {
          const output = await provider.generate(candidate.modelId, request);
          attempts.push(this.succeededAttempt(candidate, attempt, Date.now() - startedAt, output));
          return {
            attempts: Object.freeze(attempts),
            modelId: candidate.modelId,
            output,
            policy,
            providerId: candidate.providerId,
          };
        } catch (error) {
          const normalized = this.normalizeError(error);
          attempts.push(
            this.failedAttempt(
              candidate,
              attempt,
              normalized.code,
              Date.now() - startedAt,
              normalized.retryable,
            ),
          );
          if (!normalized.retryable) {
            throw new ModelRoutingError(
              "Image generation failed with a non-retryable error",
              attempts,
            );
          }
        }
      }
    }

    throw new ModelRoutingError("All image model candidates failed", attempts);
  }

  private candidates(policy: FrozenRoutingPolicy): readonly Readonly<ModelCandidate>[] {
    return [policy.primaryModel, ...policy.fallbackModels];
  }

  private candidateKey(candidate: ModelCandidate): string {
    return `${candidate.providerId}:${candidate.modelId}`;
  }

  private failedAttempt(
    candidate: Readonly<ModelCandidate>,
    attempt: number,
    errorCode: string,
    latencyMs: number,
    retryable: boolean,
    output?: TextGenerationOutput | ImageGenerationOutput,
  ): InvocationAttempt {
    return {
      attempt,
      estimatedCost: output?.usage.estimatedCost,
      errorCode,
      inputUnits: output?.usage.inputUnits,
      latencyMs,
      modelId: candidate.modelId,
      outputUnits: output?.usage.outputUnits,
      providerId: candidate.providerId,
      providerRequestId: output?.providerRequestId,
      retryable,
      status: "FAILED",
    };
  }

  private indexProviders<T extends { readonly providerId: string }>(
    providers: readonly T[],
  ): ReadonlyMap<string, T> {
    const entries = providers.map((provider) => [provider.providerId, provider] as const);
    if (new Set(entries.map(([providerId]) => providerId)).size !== entries.length) {
      throw new ModelRoutingError("Provider IDs must be unique within each model kind", []);
    }
    return new Map(entries);
  }

  private normalizeError(error: unknown): ProviderInvocationError {
    if (error instanceof ProviderInvocationError) {
      return error;
    }
    return new ProviderInvocationError(
      "Unexpected provider error",
      "UNEXPECTED_PROVIDER_ERROR",
      false,
    );
  }

  private succeededAttempt(
    candidate: Readonly<ModelCandidate>,
    attempt: number,
    latencyMs: number,
    output: TextGenerationOutput | ImageGenerationOutput,
  ): InvocationAttempt {
    return {
      attempt,
      estimatedCost: output.usage.estimatedCost,
      inputUnits: output.usage.inputUnits,
      latencyMs,
      modelId: candidate.modelId,
      outputUnits: output.usage.outputUnits,
      providerId: candidate.providerId,
      providerRequestId: output.providerRequestId,
      status: "SUCCEEDED",
    };
  }
}
