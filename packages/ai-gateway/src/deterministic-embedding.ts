const DEFAULT_DIMENSIONS = 64;

export function deterministicEmbedding(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  if (!Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 4096) {
    throw new Error("Embedding dimensions must be between 8 and 4096");
  }
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  const vector = Array.from({ length: dimensions }, () => 0);
  const units = [...normalized];
  for (let index = 0; index < units.length; index += 1) {
    for (let size = 1; size <= 3 && index + size <= units.length; size += 1) {
      const token = units.slice(index, index + size).join("");
      const hash = fnv1a(token);
      const slot = hash % dimensions;
      vector[slot] = (vector[slot] ?? 0) + (hash & 1 ? 1 : -1) / size;
    }
  }
  return normalizeVector(vector);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}
