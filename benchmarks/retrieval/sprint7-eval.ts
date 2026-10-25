import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  cosineSimilarity,
  deterministicEmbedding,
} from "../../packages/ai-gateway/src/deterministic-embedding";

type Dataset = Readonly<{
  baseline: Readonly<{
    maximumContextCharacters: number;
    maximumWrongCitationRate: number;
    minimumRecallAtK: number;
    topK: number;
  }>;
  corpus: readonly Readonly<{ id: string; tags: readonly string[]; text: string; title: string }>[];
  queries: readonly Readonly<{ query: string; relevant: readonly string[] }>[];
}>;

async function main(): Promise<void> {
  const dataset = JSON.parse(
    await readFile(resolve(__dirname, "sprint7-eval.json"), "utf8"),
  ) as Dataset;

  let recalled = 0;
  let expected = 0;
  let wrong = 0;
  let returned = 0;
  let maximumContextCharacters = 0;
  const rows = dataset.queries.map((sample) => {
    const queryVector = deterministicEmbedding(sample.query);
    const ranked = dataset.corpus
      .map((document) => {
        const vectorScore =
          (cosineSimilarity(queryVector, deterministicEmbedding(document.text)) + 1) / 2;
        const tagScore =
          document.tags.filter((tag) => sample.query.includes(tag)).length /
          Math.max(1, document.tags.length);
        const lexicalScore = lexicalOverlap(
          sample.query,
          `${document.title} ${document.tags.join(" ")} ${document.text}`,
        );
        return { document, score: vectorScore * 0.4 + lexicalScore * 0.45 + tagScore * 0.15 };
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.document.id.localeCompare(right.document.id),
      )
      .slice(0, dataset.baseline.topK);
    const ids = ranked.map(({ document }) => document.id);
    const relevant = new Set(sample.relevant);
    const hits = ids.filter((id) => relevant.has(id)).length;
    recalled += hits;
    expected += sample.relevant.length;
    wrong += ids.length - hits;
    returned += ids.length;
    const contextCharacters = ranked.reduce((sum, row) => sum + row.document.text.length, 0);
    maximumContextCharacters = Math.max(maximumContextCharacters, contextCharacters);
    return { hits, query: sample.query, returned: ids };
  });

  const recallAtK = expected === 0 ? 1 : recalled / expected;
  const wrongCitationRate = returned === 0 ? 0 : wrong / returned;
  const result = {
    baseline: dataset.baseline,
    metrics: { maximumContextCharacters, recallAtK, wrongCitationRate },
    passed:
      recallAtK >= dataset.baseline.minimumRecallAtK &&
      wrongCitationRate <= dataset.baseline.maximumWrongCitationRate &&
      maximumContextCharacters <= dataset.baseline.maximumContextCharacters,
    rows,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

void main();

function lexicalOverlap(query: string, document: string): number {
  const queryTerms = terms(query);
  const documentTerms = new Set(terms(document));
  if (queryTerms.length === 0) return 0;
  return queryTerms.filter((term) => documentTerms.has(term)).length / queryTerms.length;
}

function terms(value: string): string[] {
  const normalized = [...value.normalize("NFKC").toLocaleLowerCase()].filter(
    (char) => !/\s|\p{P}/u.test(char),
  );
  const terms = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    for (let size = 1; size <= 3 && index + size <= normalized.length; size += 1) {
      terms.add(normalized.slice(index, index + size).join(""));
    }
  }
  return [...terms];
}
