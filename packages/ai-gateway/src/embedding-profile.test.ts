import { describe, expect, it, vi } from "vitest";
import {
  embeddingProfileVersion,
  prepareEmbeddingInputs,
  QWEN3_RETRIEVAL_INSTRUCTION,
  resolveEmbeddingProfile,
} from "./embedding-profile";
import { OpenAICompatibleEmbeddingProvider } from "./openai-compatible-provider";

const qwen = resolveEmbeddingProfile({ externalModelId: "Qwen/Qwen3-Embedding-0.6B-Q8_0.gguf" });
const model = {
  id: "a".repeat(36),
  externalModelId: "qwen3-embedding-0.6b",
  updatedAt: new Date("2026-09-10T00:00:00Z"),
  provider: { baseUrl: "https://embedding.example/v1" },
};

describe("Qwen3 embedding profile", () => {
  it("adds the official query wrapper only on the query side", () => {
    const text = "推荐林院长的全飞秒手术";
    expect(prepareEmbeddingInputs([text], "QUERY", qwen)).toEqual([
      `Instruct: ${QWEN3_RETRIEVAL_INSTRUCTION}\nQuery:${text}`,
    ]);
    expect(prepareEmbeddingInputs([text], "DOCUMENT", qwen)).toEqual([text]);
    expect(
      prepareEmbeddingInputs(
        [text],
        "QUERY",
        resolveEmbeddingProfile({ externalModelId: "text-embedding-3-small" }),
      ),
    ).toEqual([text]);
  });
  it("supports explicit aliases and does not apply the 0.6B profile to other Qwen sizes", () => {
    expect(
      resolveEmbeddingProfile({
        externalModelId: "private-alias",
        metadata: { embeddingProfile: "QWEN3_0_6B" },
      }),
    ).toEqual(qwen);
    expect(resolveEmbeddingProfile({ externalModelId: "qwen3-embedding-4b" }).kind).toBe("GENERIC");
    expect(
      resolveEmbeddingProfile({
        externalModelId: model.externalModelId,
        metadata: { embeddingProfile: "GENERIC" },
      }).kind,
    ).toBe("GENERIC");
    expect(() =>
      resolveEmbeddingProfile({ externalModelId: "alias", metadata: { embeddingProfile: "typo" } }),
    ).toThrow();
  });
  it("isolates new vectors from legacy indexes and from changes to the model endpoint", () => {
    const current = embeddingProfileVersion(model);
    expect(current).not.toBe(`${model.id}:${model.updatedAt.toISOString()}`);
    expect(`embedding-reindex:${current}`.length).toBeLessThanOrEqual(80);
    expect(
      embeddingProfileVersion({ ...model, provider: { baseUrl: "https://other.example/v1" } }),
    ).not.toBe(current);
    expect(embeddingProfileVersion({ ...model, externalModelId: "generic" })).toBe(
      `${model.id}:${model.updatedAt.toISOString()}`,
    );
  });
  it("sends float requests, preserves row order and normalizes vectors without truncation", async () => {
    const first = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
    const second = Array.from({ length: 1024 }, (_, i) => (i === 2 ? 2 : 0));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: second },
            { index: 0, embedding: first },
          ],
        }),
      ),
    );
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "local-secret",
      baseUrl: "https://embedding.example/v1",
      providerId: "qwen",
      fetch: fetcher,
    });
    const result = await provider.embed("alias", ["专家资料", "手术资料"], {
      inputKind: "DOCUMENT",
      profile: qwen,
    });
    expect(result.dimensions).toBe(1024);
    expect(result.vectors[0]?.slice(0, 2)).toEqual([0.6, 0.8]);
    expect(result.vectors[1]?.[2]).toBe(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      model: "alias",
      input: ["专家资料", "手术资料"],
      encoding_format: "float",
    });
  });
  it.each([
    { embedding: Array(768).fill(1) },
    { embedding: Array(1024).fill(0) },
    {
      embedding: [
        [1, 2],
        [3, 4],
      ],
    },
  ])("rejects wrong dimensions, zero vectors and unpooled token outputs", async ({ embedding }) => {
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey: "local-secret",
      baseUrl: "https://embedding.example/v1",
      providerId: "qwen",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding }] }))),
    });
    await expect(provider.embed(model.externalModelId, ["资料"])).rejects.toMatchObject({
      code: "INVALID_EMBEDDING_PROFILE",
    });
  });
});
