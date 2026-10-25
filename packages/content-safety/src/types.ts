export type ContentSafetyDecision = "BLOCK" | "PASS" | "REVIEW";

export type ContentSafetyCategory = Readonly<{
  code: string;
  decision: ContentSafetyDecision;
  message?: string;
  score?: number;
}>;

export type ContentSafetyImage = Readonly<{
  bytes: Uint8Array;
  checksum: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sequence: number;
}>;

export type ContentSafetyText = Readonly<{
  body: string;
  hashtags: readonly string[];
  title: string;
}>;

export type ContentSafetyScanInput = Readonly<{
  publishingContext?: ContentSafetyPublishingContext;
  sourceFacts?: string;
  images: readonly ContentSafetyImage[];
  requestId: string;
  text: ContentSafetyText;
}>;

export type ContentSafetyPublishingContext = Readonly<{
  schemaVersion: "medical-publishing-v1";
  category: "ORDINARY" | "UNKNOWN" | "MEDICAL_KOS" | "INSTITUTION";
  verified: boolean;
  role: string | null;
  allowBrandAttribution: boolean;
  allowPlatformConsultation: boolean;
  conversionPath: "NONE" | "OFFICIAL_PROFILE" | "PLATFORM_CONSULTATION";
}>;

export type ContentSafetyScanResult = Readonly<{
  usage?: { inputUnits?: number; outputUnits?: number };
  categories: readonly ContentSafetyCategory[];
  checkedAt: string;
  decision: ContentSafetyDecision;
  latencyMs: number;
  model?: string;
  provider: string;
  providerRequestId: string;
}>;

export interface ContentSafetyScanner {
  scan(input: ContentSafetyScanInput): Promise<ContentSafetyScanResult>;
}

export class ContentSafetyInvocationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly context?: Readonly<{
      httpStatus?: number;
      model?: string;
      provider: string;
      providerRequestId?: string;
      probeStage?: "neutral" | "image-risk";
      decision?: ContentSafetyDecision;
    }>,
  ) {
    super(message);
    this.name = "ContentSafetyInvocationError";
  }
}
