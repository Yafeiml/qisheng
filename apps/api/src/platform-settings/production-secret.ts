const DEVELOPMENT_VALUE_PATTERN =
  /(?:dev(?:elopment)?[-_ ]?only|replace[-_ ]?before[-_ ]?production|changeme|example|fixture|mock|synthetic|placeholder)/iu;

export function isProductionCredential(value: string | null | undefined, minimumBytes: number) {
  return Boolean(
    value &&
      Buffer.byteLength(value, "utf8") >= minimumBytes &&
      !DEVELOPMENT_VALUE_PATTERN.test(value),
  );
}

export function isProductionRandomSecret(
  value: string | null | undefined,
  minimumBytes: number,
  minimumDistinctBytes = 12,
): boolean {
  return Boolean(
    value &&
      isProductionCredential(value, minimumBytes) &&
      hasMinimumByteDiversity(Buffer.from(value, "utf8"), minimumDistinctBytes),
  );
}

export function hasMinimumByteDiversity(value: Uint8Array, minimumDistinctBytes = 12): boolean {
  return new Set(value).size >= minimumDistinctBytes;
}
