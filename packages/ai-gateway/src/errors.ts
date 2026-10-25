export class ProviderInvocationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: Readonly<{
      httpStatus?: number;
      requestPath?: string;
      requestId?: string;
      upstreamStage?: string;
    }>,
  ) {
    super(message);
    this.name = "ProviderInvocationError";
  }
}

export class ModelRoutingError extends Error {
  constructor(
    message: string,
    readonly attempts: readonly {
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
    }[],
  ) {
    super(message);
    this.name = "ModelRoutingError";
  }
}
