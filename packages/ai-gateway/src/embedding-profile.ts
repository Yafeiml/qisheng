import { createHash } from "node:crypto";

export const QWEN3_RETRIEVAL_INSTRUCTION =
  "Given a content creation request, retrieve relevant brand materials about the specified people, procedures, products, and services.";

export type EmbeddingProfile = Readonly<{
  kind: "GENERIC" | "QWEN3_0_6B";
  dimensions: number | null;
  queryInstruction: string | null;
  pooling: "provider" | "last";
  normalize: boolean;
  maxBatchSize: number;
  version: string;
}>;

type EmbeddingModel = Readonly<{
  externalModelId: string;
  metadata?: unknown;
}>;

export function resolveEmbeddingProfile(model: EmbeddingModel): EmbeddingProfile {
  const metadata = model.metadata;
  const configured =
    typeof metadata === "object" && metadata !== null && "embeddingProfile" in metadata
      ? metadata.embeddingProfile
      : undefined;
  if (configured !== undefined && configured !== "GENERIC" && configured !== "QWEN3_0_6B") {
    throw new Error("Unsupported embedding profile");
  }
  const qwen =
    configured === "QWEN3_0_6B" ||
    (configured === undefined &&
      /qwen3[-_]embedding[-_]0[._]6b(?:$|[-_.:/])/iu.test(model.externalModelId));
  return qwen
    ? {
        kind: "QWEN3_0_6B",
        dimensions: 1024,
        queryInstruction: QWEN3_RETRIEVAL_INSTRUCTION,
        pooling: "last",
        normalize: true,
        // llama.cpp embedding batches must fit the physical batch. Submit one chunk
        // per request instead of packing 64 potentially long Chinese passages.
        maxBatchSize: 1,
        version: "qwen3-0.6b-last-l2-instruct-v1",
      }
    : {
        kind: "GENERIC",
        dimensions: null,
        queryInstruction: null,
        pooling: "provider",
        normalize: false,
        maxBatchSize: 64,
        version: "generic-v1",
      };
}

export function embeddingProfileVersion(
  model: EmbeddingModel &
    Readonly<{
      id: string;
      updatedAt: Date;
      provider?: Readonly<{ baseUrl: string }>;
    }>,
): string {
  const profile = resolveEmbeddingProfile(model);
  if (profile.kind === "GENERIC") return `${model.id}:${model.updatedAt.toISOString()}`;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        id: model.id,
        updatedAt: model.updatedAt.toISOString(),
        externalModelId: model.externalModelId,
        baseUrl: model.provider?.baseUrl ?? null,
        profile,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  // Also fits the 80-character ingestion parserVersion with its reindex prefix.
  return `qwen3-v1:${hash}`;
}

export function prepareEmbeddingInputs(
  texts: readonly string[],
  kind: "QUERY" | "DOCUMENT",
  profile: EmbeddingProfile,
): readonly string[] {
  return kind === "QUERY" && profile.queryInstruction
    ? texts.map((text) => `Instruct: ${profile.queryInstruction}\nQuery:${text}`)
    : texts;
}

export function normalizeEmbeddingVector(vector: number[], profile: EmbeddingProfile): number[] {
  if (profile.dimensions !== null && vector.length !== profile.dimensions)
    throw new Error(`Expected ${profile.dimensions} embedding dimensions`);
  if (!profile.normalize) return vector;
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding vector has invalid norm");
  return vector.map((value) => value / norm);
}
