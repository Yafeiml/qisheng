export const PUBLICATION_SCORING_PROFILE_VERSION =
  "publication-char-bigram-numeric-facts-checksum-dhash64-v2";

export type PublicationVerificationScoringPolicy = Readonly<{
  imageSimilarityThreshold: number;
  manualReviewMargin: number;
  requireImageMatch: boolean;
  textSimilarityThreshold: number;
}>;

export type ExpectedPublicationContent = Readonly<{
  body: string;
  hashtags: readonly string[];
  images: readonly Readonly<{
    checksum: string;
    imageUrl: string;
    perceptualHash: string | null;
  }>[];
  title: string;
}>;

export type ActualPublicationContent = Readonly<{
  body: string;
  hashtags: readonly string[];
  images: readonly Readonly<{
    checksum: string | null;
    perceptualHash: string | null;
    url: string | null;
  }>[];
  title: string;
}>;

export type PublicationEvidenceEvaluation = Readonly<{
  decision: "INVALID" | "MANUAL_REVIEW" | "VALID";
  factScore: number | null;
  failureReason: string | null;
  imageScore: number | null;
  overallScore: number;
  textScore: number;
}>;

export function evaluatePublicationEvidence(input: {
  actual: ActualPublicationContent;
  expected: ExpectedPublicationContent;
  policy: PublicationVerificationScoringPolicy;
}): PublicationEvidenceEvaluation {
  const expectedText = publicationText(input.expected);
  const actualText = publicationText(input.actual);
  const textScore = contentSimilarity(expectedText, actualText);
  const imageScore = imageSimilarity(input.expected.images, input.actual.images);
  const factScore = factMatchSimilarity(expectedText, actualText);
  const textPassed = textScore >= input.policy.textSimilarityThreshold;
  const imagePassed =
    !input.policy.requireImageMatch ||
    (imageScore !== null && imageScore >= input.policy.imageSimilarityThreshold);
  const factPassed = factScore === null || factScore === 1;
  const overallScore = combinedScore(textScore, imageScore, factScore);
  if (textPassed && imagePassed && factPassed) {
    return {
      decision: "VALID",
      factScore,
      failureReason: null,
      imageScore,
      overallScore,
      textScore,
    };
  }

  const margin = input.policy.manualReviewMargin;
  const textNearThreshold = textScore >= Math.max(0, input.policy.textSimilarityThreshold - margin);
  const imageNearThreshold =
    imageScore === null ||
    imageScore >= Math.max(0, input.policy.imageSimilarityThreshold - margin);
  const factNearThreshold = factScore === null || factScore >= 0.5;
  if (textNearThreshold && imageNearThreshold && factNearThreshold) {
    return {
      decision: "MANUAL_REVIEW",
      factScore,
      failureReason: !factPassed
        ? "公开正文中的数字事实与员工专属文案不完全一致，需要人工核实"
        : imageScore === null
          ? "公开正文接近自动通过阈值，但暂时没有足够图片指纹，需要人工核实"
          : "公开图文处于自动判定灰区，需要人工核实",
      imageScore,
      overallScore,
      textScore,
    };
  }

  return {
    decision: "INVALID",
    factScore,
    failureReason: !textPassed
      ? `公开正文相似度 ${textScore.toFixed(3)} 低于策略阈值 ${input.policy.textSimilarityThreshold.toFixed(3)}`
      : !imagePassed
        ? `公开图片相似度 ${(imageScore ?? 0).toFixed(3)} 低于策略阈值 ${input.policy.imageSimilarityThreshold.toFixed(3)}`
        : `公开正文数字事实匹配率 ${(factScore ?? 0).toFixed(3)} 未达到完整一致`,
    imageScore,
    overallScore,
    textScore,
  };
}

function publicationText(content: Pick<ExpectedPublicationContent, "body" | "hashtags" | "title">) {
  return `${content.title}\n${content.body}\n${content.hashtags.join(" ")}`;
}

function contentSimilarity(expected: string, actual: string): number {
  const left = normalizeContent(expected);
  const right = normalizeContent(actual);
  if (!left || !right) return 0;
  // A matching title or fragment does not prove the employee's complete post was published.
  // The Dice score penalizes both missing expected copy and unrelated appended copy.
  const leftPairs = bigramCounts(left);
  const rightPairs = bigramCounts(right);
  let intersection = 0;
  for (const [pair, leftCount] of leftPairs) {
    intersection += Math.min(leftCount, rightPairs.get(pair) ?? 0);
  }
  const leftTotal = [...leftPairs.values()].reduce((sum, value) => sum + value, 0);
  const rightTotal = [...rightPairs.values()].reduce((sum, value) => sum + value, 0);
  return leftTotal + rightTotal === 0 ? 0 : (2 * intersection) / (leftTotal + rightTotal);
}

function normalizeContent(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .slice(0, 20_000);
}

function bigramCounts(value: string): Map<string, number> {
  const result = new Map<string, number>();
  if (value.length === 1) return new Map([[value, 1]]);
  for (let index = 0; index < value.length - 1; index += 1) {
    const pair = value.slice(index, index + 2);
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
}

function imageSimilarity(
  expected: ExpectedPublicationContent["images"],
  actual: ActualPublicationContent["images"],
): number | null {
  let best: number | null = null;
  for (const left of expected) {
    for (const right of actual) {
      let score: number | null = null;
      if (right.url && right.url === left.imageUrl) score = 1;
      if (right.checksum && right.checksum.toLowerCase() === left.checksum.toLowerCase()) score = 1;
      if (left.perceptualHash && right.perceptualHash) {
        const perceptual = perceptualHashSimilarity(left.perceptualHash, right.perceptualHash);
        score = score === null ? perceptual : Math.max(score, perceptual);
      }
      if (score !== null) best = best === null ? score : Math.max(best, score);
    }
  }
  return best;
}

function perceptualHashSimilarity(left: string, right: string): number {
  const leftBits = hexBits(left);
  const rightBits = hexBits(right);
  if (leftBits.length !== rightBits.length || leftBits.length === 0) return 0;
  let different = 0;
  for (let index = 0; index < leftBits.length; index += 1) {
    if (leftBits[index] !== rightBits[index]) different += 1;
  }
  return 1 - different / leftBits.length;
}

function hexBits(value: string): string {
  if (!/^[0-9a-f]+$/iu.test(value)) return "";
  return [...value.toLowerCase()]
    .map((character) => Number.parseInt(character, 16).toString(2).padStart(4, "0"))
    .join("");
}

function factMatchSimilarity(expected: string, actual: string): number | null {
  const expectedFacts = extractNumericFacts(expected);
  if (expectedFacts.size === 0) return null;
  const actualFacts = extractNumericFacts(actual);
  let matched = 0;
  for (const fact of expectedFacts) {
    if (actualFacts.has(fact)) matched += 1;
  }
  return matched / expectedFacts.size;
}

function extractNumericFacts(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const matches = normalized.matchAll(
    /\d+(?:\.\d+)?\s*(?:%|岁|年|月|天|小时|分钟|秒|次|例|台|级|毫米|厘米|mm|cm|nm)?/giu,
  );
  return new Set([...matches].map(({ 0: fact }) => fact.replace(/\s+/gu, "")));
}

function combinedScore(
  textScore: number,
  imageScore: number | null,
  factScore: number | null,
): number {
  if (factScore === null)
    return imageScore === null ? textScore : textScore * 0.7 + imageScore * 0.3;
  return imageScore === null
    ? textScore * 0.9 + factScore * 0.1
    : textScore * 0.6 + imageScore * 0.3 + factScore * 0.1;
}
