// A platform repair can make these deterministic task/service failures recoverable.
// File format, content limits, missing originals and checksum failures stay excluded.
export const ADMIN_RECOVERABLE_QUARANTINED_CODES = [
  "RUNTIME_POLICY_MISSING",
  "STORAGE_ACCESS_DENIED",
  "ARTIFACT_NOT_LOADED",
  "EMPTY_EMBEDDING_INPUT",
  "BUNDLE_MATERIAL_TYPE_UNSUPPORTED",
  "BUNDLE_ARTIFACT_COUNT_INVALID",
  "MATERIAL_CHUNKS_MISSING",
  "MATERIAL_INGESTION_UNEXPECTED",
  "LINK_HTTP_429",
  "LINK_FETCH_NETWORK",
  "LINK_DNS_EMPTY",
  "LINK_FETCH_TIMEOUT",
] as const;

export function canRetryQuarantinedMaterial(code: string | null): boolean {
  return (
    code !== null &&
    (/^(MATERIAL_ANALYSIS|EMBEDDING)_/u.test(code) ||
      /^LINK_HTTP_5\d{2}$/u.test(code) ||
      (ADMIN_RECOVERABLE_QUARANTINED_CODES as readonly string[]).includes(code))
  );
}
