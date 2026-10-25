import type { GeneratedImageObjectKeyInput, MaterialArtifactObjectKeyInput } from "./types";

export function generatedImageObjectKey(input: GeneratedImageObjectKeyInput): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error("Generated image sequence must be a positive integer");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.checksum)) {
    throw new Error("Generated image checksum must be a lowercase SHA-256 digest");
  }
  const extension = extensionFor(input.mimeType);
  return [
    "tenants",
    safeSegment(input.tenantId),
    "campaigns",
    safeSegment(input.campaignId),
    "contents",
    safeSegment(input.employeeContentId),
    `${input.sequence}-${input.checksum.slice(0, 16)}.${extension}`,
  ].join("/");
}

export function materialArtifactObjectKey(input: MaterialArtifactObjectKeyInput): string {
  const extension = safeExtension(input.fileName);
  return [
    "tenants",
    safeSegment(input.tenantId),
    "materials",
    safeSegment(input.materialId),
    `${safeSegment(input.artifactId)}.${extension}`,
  ].join("/");
}

function extensionFor(mimeType: GeneratedImageObjectKeyInput["mimeType"]): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("Object key identifier contains unsupported characters");
  }
  return value;
}

function safeExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/u.exec(fileName.trim());
  if (!match) return "bin";
  return match[1]?.toLowerCase() ?? "bin";
}
