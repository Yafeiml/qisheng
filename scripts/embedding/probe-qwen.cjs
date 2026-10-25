// Exercise the same profile and provider adapter used by API queries and Worker indexing.
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  OpenAICompatibleEmbeddingProvider,
  QWEN3_RETRIEVAL_INSTRUCTION,
  resolveEmbeddingProfile,
} = require("../../packages/ai-gateway/dist/index.js");

async function main() {
  const root = resolve(__dirname, "../..");
  const apiKey = readFileSync(resolve(root, ".artifacts/qwen-embedding/api-key"), "utf8").trim();
  const port = process.env.QWEN_EMBEDDING_PORT || "8092";
  if (!/^\d+$/.test(port)) throw new Error("Invalid port");
  const model = "qwen3-embedding-0.6b";
  const profile = resolveEmbeddingProfile({ externalModelId: model });
  const provider = new OpenAICompatibleEmbeddingProvider({
    apiKey,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    providerId: "local-qwen",
    timeoutMs: 60000,
  });
  const texts = [
    "高院长的专家介绍，介绍其专业背景和服务流程。",
    "全飞秒手术项目资料：术前评估、操作流程和个体差异。",
    "高院长的专家介绍照片，可用于人物介绍配图。",
    "办公室纸张、打印机和桌椅的库存管理。",
  ];
  const vectors = [];
  for (const text of texts)
    vectors.push(
      (await provider.embed(model, [text], { inputKind: "DOCUMENT", profile })).vectors[0],
    );
  const started = performance.now();
  const query = (
    await provider.embed(model, ["推荐高院长的全飞秒手术"], { inputKind: "QUERY", profile })
  ).vectors[0];
  const queryLatencyMs = Math.round(performance.now() - started);
  const all = [...vectors, query];
  if (all.some((vector) => vector.length !== 1024 || Math.abs(Math.hypot(...vector) - 1) > 0.00001))
    throw new Error("Vector dimensions or normalization failed");
  const ranked = vectors
    .map((vector, index) => ({
      index,
      text: texts[index],
      score: vector.reduce((sum, value, dimension) => sum + value * query[dimension], 0),
    }))
    .sort((a, b) => b.score - a.score);
  if (ranked.at(-1).index !== 3)
    throw new Error("Smoke test did not rank unrelated office inventory last");
  const result = {
    model,
    profile,
    queryInstruction: QWEN3_RETRIEVAL_INSTRUCTION,
    dimensions: 1024,
    maxNormError: Math.max(...all.map((vector) => Math.abs(Math.hypot(...vector) - 1))),
    queryLatencyMs,
    ranked,
    note: "Four-document functional smoke test; not a retrieval-quality benchmark.",
  };
  mkdirSync(resolve(root, ".artifacts/qwen-embedding"), { recursive: true });
  writeFileSync(
    resolve(root, ".artifacts/qwen-embedding/probe.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
