/** Versioned attachment annotations. Original object keys never leave the server. */
export type ImageUsage = "REFERENCE" | "LOGO";

export function assetRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function imageAssetDetails(metadata: unknown) {
  const value = assetRecord(metadata);
  return {
    description: typeof value.description === "string" ? value.description : "",
    usage: value.usage === "LOGO" ? ("LOGO" as const) : ("REFERENCE" as const),
    analysis: assetRecord(value.analysis),
    usabilityStatus:
      value.usabilityStatus === "USABLE" || value.usabilityStatus === "NEEDS_INPUT"
        ? value.usabilityStatus
        : ("PENDING" as const),
  };
}

export interface FrozenImageAsset {
  artifactId: string;
  materialId: string;
  objectKey: string;
  checksum: string;
  mimeType: string;
  description: string;
  usage: ImageUsage;
  privacyConfirmed?: boolean;
  authorizationConfirmed?: boolean;
}
