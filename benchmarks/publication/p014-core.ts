export const P014_SCENARIOS = [
  "LONG_LINK",
  "SHORT_LINK",
  "QUERY_VARIANT",
  "SHARE_TEXT",
  "REWRITTEN_TEXT",
  "IMAGE_COMPRESSED",
  "IMAGE_CROPPED",
  "IMAGE_WATERMARKED",
  "UNRELATED_CONTENT",
  "UNAVAILABLE_CONTENT",
  "DIFFERENT_ACCOUNT",
] as const;

export type P014Scenario = (typeof P014_SCENARIOS)[number];
export type P014Label = "MATCH" | "MISMATCH" | "UNAVAILABLE";
export type P014Decision = "INVALID" | "MANUAL_REVIEW" | "VALID";

export type P014PolicyCandidate = Readonly<{
  imageSimilarityThreshold: number;
  manualReviewMargin: number;
  policyVersion: string;
  requireImageMatch: boolean;
  textSimilarityThreshold: number;
}>;

export type P014QualityGates = Readonly<{
  maximumFalseAcceptRate: number;
  maximumFalseRejectRate: number;
  maximumManualReviewRate: number;
  maximumP95LatencyMs: number;
  minimumCanonicalConsistencyRate: number;
  minimumExpectedAvailableResolutionRate: number;
  minimumMatchAutoPassRate: number;
  minimumUnavailableRecognitionRate: number;
}>;

export type P014ExpectedContent = Readonly<{
  body: string;
  hashtags: readonly string[];
  images: readonly Readonly<{
    checksum: string;
    imageUrl: string;
    perceptualHash: string | null;
  }>[];
  title: string;
}>;

export type P014Sample = Readonly<{
  canonicalGroup: string | null;
  expectedContent: P014ExpectedContent;
  id: string;
  input: string;
  label: P014Label;
  notes: string | null;
  scenarios: readonly P014Scenario[];
}>;

export type P014Manifest = Readonly<{
  benchmarkId: string;
  policyCandidates: readonly P014PolicyCandidate[];
  providerDeclaration: Readonly<{
    dataTermsReviewed: boolean;
    name: string;
    productionService: boolean;
  }>;
  qualityGates: P014QualityGates;
  samples: readonly P014Sample[];
  schemaVersion: 1;
  synthetic: false;
}>;

export type P014PolicyEvaluation = Readonly<{
  decision: P014Decision;
  factScore: number | null;
  failureReason: string | null;
  imageScore: number | null;
  overallScore: number;
  policyVersion: string;
  textScore: number;
}>;

export type P014SampleResult = Readonly<{
  adapterStatus: "AVAILABLE" | "ERROR" | "UNAVAILABLE";
  canonicalGroup: string | null;
  canonicalKey: string | null;
  canonicalUrl: string | null;
  error: Readonly<{ code: string; message: string; retryable: boolean }> | null;
  evidence: Readonly<{
    adapterModel: string | null;
    adapterReference: string | null;
    adapterRequestId: string;
    body: string;
    externalPublishedAt: string | null;
    hashtags: readonly string[];
    images: readonly Readonly<{
      checksum: string | null;
      perceptualHash: string | null;
      url: string | null;
    }>[];
    provider: string;
    title: string;
  }> | null;
  inputClassification: "XHS_NOTE" | "XHS_SHORT";
  inputNormalizedUrl: string;
  label: P014Label;
  latencyMs: number;
  policyEvaluations: readonly P014PolicyEvaluation[];
  sampleId: string;
  scenarios: readonly P014Scenario[];
}>;

export type P014PolicyMetrics = Readonly<{
  errors: readonly string[];
  falseAcceptRate: number;
  falseRejectRate: number;
  manualReviewRate: number;
  matchAutoPassRate: number;
  mismatchCount: number;
  mismatchInvalidCount: number;
  mismatchManualReviewCount: number;
  mismatchValidCount: number;
  passed: boolean;
  policyVersion: string;
  resolvedAvailableCount: number;
  trueMatchCount: number;
  trueMatchInvalidCount: number;
  trueMatchManualReviewCount: number;
  trueMatchValidCount: number;
}>;

export const P014_PROJECT_MINIMUM_GATES: P014QualityGates = {
  maximumFalseAcceptRate: 0,
  maximumFalseRejectRate: 0.1,
  maximumManualReviewRate: 0.3,
  maximumP95LatencyMs: 30_000,
  minimumCanonicalConsistencyRate: 1,
  minimumExpectedAvailableResolutionRate: 0.9,
  minimumMatchAutoPassRate: 0.8,
  minimumUnavailableRecognitionRate: 0.8,
};

const REQUIRED_SCENARIOS: readonly P014Scenario[] = [
  "LONG_LINK",
  "SHORT_LINK",
  "QUERY_VARIANT",
  "SHARE_TEXT",
  "REWRITTEN_TEXT",
  "IMAGE_COMPRESSED",
  "IMAGE_CROPPED",
  "IMAGE_WATERMARKED",
  "UNRELATED_CONTENT",
  "UNAVAILABLE_CONTENT",
  "DIFFERENT_ACCOUNT",
];

export function parseP014Manifest(value: unknown): P014Manifest {
  const root = record(value, "manifest");
  if (root.schemaVersion !== 1) throw new Error("manifest.schemaVersion must be 1");
  if (root.synthetic !== false) {
    throw new Error("manifest.synthetic must be false; synthetic fixtures cannot satisfy P-014");
  }
  const benchmarkId = requiredString(root.benchmarkId, "manifest.benchmarkId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,127}$/u.test(benchmarkId)) {
    throw new Error("manifest.benchmarkId contains unsupported characters or is too short");
  }
  const provider = record(root.providerDeclaration, "manifest.providerDeclaration");
  const providerDeclaration = {
    dataTermsReviewed: requiredBoolean(
      provider.dataTermsReviewed,
      "manifest.providerDeclaration.dataTermsReviewed",
    ),
    name: requiredString(provider.name, "manifest.providerDeclaration.name"),
    productionService: requiredBoolean(
      provider.productionService,
      "manifest.providerDeclaration.productionService",
    ),
  };
  const policyCandidates = array(root.policyCandidates, "manifest.policyCandidates").map(
    (raw, index) => parsePolicy(raw, index),
  );
  if (policyCandidates.length < 2) {
    throw new Error("manifest.policyCandidates must contain at least two threshold candidates");
  }
  const versions = policyCandidates.map(({ policyVersion }) => policyVersion);
  if (new Set(versions).size !== versions.length) {
    throw new Error("manifest.policyCandidates contains duplicate policyVersion values");
  }
  const qualityGates = parseQualityGates(root.qualityGates);
  const samples = array(root.samples, "manifest.samples").map((raw, index) =>
    parseSample(raw, index),
  );
  if (samples.length === 0) throw new Error("manifest.samples must not be empty");
  const ids = samples.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("manifest.samples contains duplicate IDs");
  return {
    benchmarkId,
    policyCandidates,
    providerDeclaration,
    qualityGates,
    samples,
    schemaVersion: 1,
    synthetic: false,
  };
}

export function p014CoverageErrors(manifest: P014Manifest): string[] {
  const errors: string[] = [];
  const labelCounts = countBy(manifest.samples, ({ label }) => label);
  if (manifest.samples.length < 30)
    errors.push("formal P-014 acceptance requires at least 30 samples");
  if ((labelCounts.MATCH ?? 0) < 10)
    errors.push("formal P-014 acceptance requires at least 10 MATCH samples");
  if ((labelCounts.MISMATCH ?? 0) < 10) {
    errors.push("formal P-014 acceptance requires at least 10 MISMATCH samples");
  }
  if ((labelCounts.UNAVAILABLE ?? 0) < 3) {
    errors.push("formal P-014 acceptance requires at least 3 UNAVAILABLE samples");
  }
  const covered = new Set(manifest.samples.flatMap(({ scenarios }) => scenarios));
  for (const scenario of REQUIRED_SCENARIOS) {
    if (!covered.has(scenario))
      errors.push(`required real-sample scenario is missing: ${scenario}`);
  }
  const canonicalGroups = groupedCanonicalSamples(manifest.samples);
  if (canonicalGroups.length === 0) {
    errors.push("at least one canonicalGroup with two URL variants is required");
  }
  if (
    !canonicalGroups.some((samples) => {
      const scenarios = new Set(samples.flatMap(({ scenarios }) => scenarios));
      return (
        scenarios.has("SHORT_LINK") &&
        (scenarios.has("LONG_LINK") || scenarios.has("QUERY_VARIANT"))
      );
    })
  ) {
    errors.push("a canonicalGroup must compare a SHORT_LINK with a long or query URL variant");
  }
  if (!manifest.providerDeclaration.productionService) {
    errors.push("providerDeclaration.productionService must be true for formal acceptance");
  }
  if (!manifest.providerDeclaration.dataTermsReviewed) {
    errors.push("providerDeclaration.dataTermsReviewed must be true for formal acceptance");
  }
  errors.push(...qualityGateStrengthErrors(manifest.qualityGates));
  return errors;
}

export function parseP014Results(value: unknown, manifest: P014Manifest): P014SampleResult[] {
  const root = record(value, "results");
  if (root.schemaVersion !== 1) throw new Error("results.schemaVersion must be 1");
  if (root.synthetic !== false) throw new Error("results.synthetic must be false");
  if (root.benchmarkId !== manifest.benchmarkId) {
    throw new Error("results.benchmarkId does not match manifest");
  }
  const sampleById = new Map(manifest.samples.map((sample) => [sample.id, sample]));
  return array(root.samples, "results.samples").map((raw, index) => {
    const label = `results.samples[${index}]`;
    const row = record(raw, label);
    const sampleId = requiredString(row.sampleId, `${label}.sampleId`);
    const sample = sampleById.get(sampleId);
    if (!sample) throw new Error(`${label}.sampleId is not present in the manifest`);
    if (row.label !== sample.label) throw new Error(`${label}.label does not match the manifest`);
    if (optionalString(row.canonicalGroup) !== sample.canonicalGroup) {
      throw new Error(`${label}.canonicalGroup does not match the manifest`);
    }
    const scenarios = stringArray(row.scenarios, `${label}.scenarios`);
    if (JSON.stringify(scenarios) !== JSON.stringify(sample.scenarios)) {
      throw new Error(`${label}.scenarios do not match the manifest`);
    }
    const adapterStatus = enumValue(
      row.adapterStatus,
      ["AVAILABLE", "ERROR", "UNAVAILABLE"],
      `${label}.adapterStatus`,
    );
    const evidence = row.evidence === null ? null : parseResultEvidence(row.evidence, label);
    const error = row.error === null ? null : parseResultError(row.error, label);
    if (adapterStatus === "AVAILABLE" && !evidence) {
      throw new Error(`${label}.evidence is required when adapterStatus is AVAILABLE`);
    }
    if (adapterStatus !== "AVAILABLE" && evidence) {
      throw new Error(`${label}.evidence must be null unless adapterStatus is AVAILABLE`);
    }
    if (adapterStatus === "ERROR" && !error) {
      throw new Error(`${label}.error is required when adapterStatus is ERROR`);
    }
    if (adapterStatus !== "ERROR" && error) {
      throw new Error(`${label}.error must be null unless adapterStatus is ERROR`);
    }
    const policyEvaluations = array(row.policyEvaluations, `${label}.policyEvaluations`).map(
      (rawEvaluation, evaluationIndex) =>
        parseResultEvaluation(rawEvaluation, `${label}.policyEvaluations[${evaluationIndex}]`),
    );
    const policyVersions = policyEvaluations.map(({ policyVersion }) => policyVersion);
    if (new Set(policyVersions).size !== policyVersions.length) {
      throw new Error(`${label}.policyEvaluations contains duplicate versions`);
    }
    const candidateVersions = new Set(
      manifest.policyCandidates.map(({ policyVersion }) => policyVersion),
    );
    if (policyVersions.some((version) => !candidateVersions.has(version))) {
      throw new Error(`${label}.policyEvaluations contains an unknown policy version`);
    }
    return {
      adapterStatus,
      canonicalGroup: sample.canonicalGroup,
      canonicalKey: optionalString(row.canonicalKey),
      canonicalUrl: optionalString(row.canonicalUrl),
      error,
      evidence,
      inputClassification: enumValue(
        row.inputClassification,
        ["XHS_NOTE", "XHS_SHORT"],
        `${label}.inputClassification`,
      ),
      inputNormalizedUrl: requiredString(row.inputNormalizedUrl, `${label}.inputNormalizedUrl`),
      label: sample.label,
      latencyMs: nonNegativeNumber(row.latencyMs, `${label}.latencyMs`),
      policyEvaluations,
      sampleId,
      scenarios: sample.scenarios,
    };
  });
}

export function summarizeP014Benchmark(
  manifest: P014Manifest,
  results: readonly P014SampleResult[],
): Readonly<{
  automatedGateErrors: readonly string[];
  automatedGatePassed: boolean;
  canonicalConsistencyRate: number;
  canonicalGroups: Readonly<{
    canonicalGroup: string;
    canonicalKeys: readonly string[];
    consistent: boolean;
    sampleIds: readonly string[];
  }>[];
  expectedAvailableResolutionRate: number;
  expectedAvailableTotal: number;
  expectedUnavailableTotal: number;
  invocationErrorCount: number;
  latencyMs: Readonly<{ p50: number; p95: number }>;
  passingPolicyVersions: readonly string[];
  policyMetrics: readonly P014PolicyMetrics[];
  recommendedPolicyVersion: string | null;
  unavailableRecognitionRate: number;
}> {
  const sampleIds = new Set(manifest.samples.map(({ id }) => id));
  const resultErrors = [
    ...(results.length === manifest.samples.length
      ? []
      : ["result count does not match manifest sample count"]),
    ...results.flatMap(({ sampleId }) =>
      sampleIds.has(sampleId) ? [] : [`result contains unknown sample: ${sampleId}`],
    ),
    ...(new Set(results.map(({ sampleId }) => sampleId)).size === results.length
      ? []
      : ["results contain duplicate sample IDs"]),
  ];
  const expectedAvailable = results.filter(({ label }) => label !== "UNAVAILABLE");
  const expectedUnavailable = results.filter(({ label }) => label === "UNAVAILABLE");
  const expectedAvailableResolutionRate = rate(
    expectedAvailable.filter(({ adapterStatus }) => adapterStatus === "AVAILABLE").length,
    expectedAvailable.length,
  );
  const unavailableRecognitionRate = rate(
    expectedUnavailable.filter(({ adapterStatus }) => adapterStatus === "UNAVAILABLE").length,
    expectedUnavailable.length,
  );
  const canonicalGroups = summarizeCanonicalGroups(manifest, results);
  const canonicalConsistencyRate = rate(
    canonicalGroups.filter(({ consistent }) => consistent).length,
    canonicalGroups.length,
  );
  const latencies = results.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
  const latencyMs = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) };
  const policyMetrics = manifest.policyCandidates.map((policy) =>
    summarizePolicy(policy, manifest.qualityGates, results),
  );
  const passingPolicyVersions = policyMetrics
    .filter(({ passed }) => passed)
    .map(({ policyVersion }) => policyVersion);
  const recommendedPolicyVersion =
    [...policyMetrics]
      .filter(({ passed }) => passed)
      .sort(
        (left, right) =>
          left.falseAcceptRate - right.falseAcceptRate ||
          right.matchAutoPassRate - left.matchAutoPassRate ||
          left.manualReviewRate - right.manualReviewRate ||
          left.policyVersion.localeCompare(right.policyVersion),
      )[0]?.policyVersion ?? null;
  const automatedGateErrors = [
    ...p014CoverageErrors(manifest),
    ...resultErrors,
    ...(expectedAvailableResolutionRate >=
    manifest.qualityGates.minimumExpectedAvailableResolutionRate
      ? []
      : [
          `expected available resolution rate ${expectedAvailableResolutionRate.toFixed(4)} is below ${manifest.qualityGates.minimumExpectedAvailableResolutionRate.toFixed(4)}`,
        ]),
    ...(unavailableRecognitionRate >= manifest.qualityGates.minimumUnavailableRecognitionRate
      ? []
      : [
          `unavailable recognition rate ${unavailableRecognitionRate.toFixed(4)} is below ${manifest.qualityGates.minimumUnavailableRecognitionRate.toFixed(4)}`,
        ]),
    ...(canonicalConsistencyRate >= manifest.qualityGates.minimumCanonicalConsistencyRate
      ? []
      : [
          `canonical consistency rate ${canonicalConsistencyRate.toFixed(4)} is below ${manifest.qualityGates.minimumCanonicalConsistencyRate.toFixed(4)}`,
        ]),
    ...(latencyMs.p95 <= manifest.qualityGates.maximumP95LatencyMs
      ? []
      : [
          `provider p95 latency ${latencyMs.p95.toFixed(2)}ms exceeds ${manifest.qualityGates.maximumP95LatencyMs}ms`,
        ]),
    ...(results.some(({ adapterStatus }) => adapterStatus === "ERROR")
      ? ["provider invocation errors must be zero for formal acceptance"]
      : []),
    ...(passingPolicyVersions.length > 0
      ? []
      : ["no policy candidate passed the production quality gates"]),
  ];
  return {
    automatedGateErrors,
    automatedGatePassed: automatedGateErrors.length === 0,
    canonicalConsistencyRate,
    canonicalGroups,
    expectedAvailableResolutionRate,
    expectedAvailableTotal: expectedAvailable.length,
    expectedUnavailableTotal: expectedUnavailable.length,
    invocationErrorCount: results.filter(({ adapterStatus }) => adapterStatus === "ERROR").length,
    latencyMs,
    passingPolicyVersions,
    policyMetrics,
    recommendedPolicyVersion,
    unavailableRecognitionRate,
  };
}

function summarizePolicy(
  policy: P014PolicyCandidate,
  gates: P014QualityGates,
  results: readonly P014SampleResult[],
): P014PolicyMetrics {
  const available = results.filter(
    ({ adapterStatus, label }) => adapterStatus === "AVAILABLE" && label !== "UNAVAILABLE",
  );
  const evaluationFor = (result: P014SampleResult) =>
    result.policyEvaluations.find(({ policyVersion }) => policyVersion === policy.policyVersion);
  const trueMatches = available.filter(({ label }) => label === "MATCH");
  const mismatches = available.filter(({ label }) => label === "MISMATCH");
  const decisions = (rows: readonly P014SampleResult[], decision: P014Decision) =>
    rows.filter((row) => evaluationFor(row)?.decision === decision).length;
  const trueMatchValidCount = decisions(trueMatches, "VALID");
  const trueMatchManualReviewCount = decisions(trueMatches, "MANUAL_REVIEW");
  const trueMatchInvalidCount = decisions(trueMatches, "INVALID");
  const mismatchValidCount = decisions(mismatches, "VALID");
  const mismatchManualReviewCount = decisions(mismatches, "MANUAL_REVIEW");
  const mismatchInvalidCount = decisions(mismatches, "INVALID");
  const falseAcceptRate = rate(mismatchValidCount, mismatches.length);
  const falseRejectRate = rate(trueMatchInvalidCount, trueMatches.length);
  const manualReviewRate = rate(
    trueMatchManualReviewCount + mismatchManualReviewCount,
    available.length,
  );
  const matchAutoPassRate = rate(trueMatchValidCount, trueMatches.length);
  const errors = [
    ...(policy.requireImageMatch ? [] : ["production policy must require an employee image match"]),
    ...(falseAcceptRate <= gates.maximumFalseAcceptRate
      ? []
      : [
          `false accept rate ${falseAcceptRate.toFixed(4)} exceeds ${gates.maximumFalseAcceptRate.toFixed(4)}`,
        ]),
    ...(falseRejectRate <= gates.maximumFalseRejectRate
      ? []
      : [
          `false reject rate ${falseRejectRate.toFixed(4)} exceeds ${gates.maximumFalseRejectRate.toFixed(4)}`,
        ]),
    ...(manualReviewRate <= gates.maximumManualReviewRate
      ? []
      : [
          `manual review rate ${manualReviewRate.toFixed(4)} exceeds ${gates.maximumManualReviewRate.toFixed(4)}`,
        ]),
    ...(matchAutoPassRate >= gates.minimumMatchAutoPassRate
      ? []
      : [
          `match auto-pass rate ${matchAutoPassRate.toFixed(4)} is below ${gates.minimumMatchAutoPassRate.toFixed(4)}`,
        ]),
    ...(available.every((row) => evaluationFor(row))
      ? []
      : ["one or more available samples are missing this policy evaluation"]),
  ];
  return {
    errors,
    falseAcceptRate,
    falseRejectRate,
    manualReviewRate,
    matchAutoPassRate,
    mismatchCount: mismatches.length,
    mismatchInvalidCount,
    mismatchManualReviewCount,
    mismatchValidCount,
    passed: errors.length === 0,
    policyVersion: policy.policyVersion,
    resolvedAvailableCount: available.length,
    trueMatchCount: trueMatches.length,
    trueMatchInvalidCount,
    trueMatchManualReviewCount,
    trueMatchValidCount,
  };
}

function summarizeCanonicalGroups(manifest: P014Manifest, results: readonly P014SampleResult[]) {
  const resultById = new Map(results.map((result) => [result.sampleId, result]));
  return groupedCanonicalSamples(manifest.samples).map((samples) => {
    const rows = samples.flatMap((sample) => {
      const result = resultById.get(sample.id);
      return result ? [result] : [];
    });
    const canonicalKeys = rows.flatMap(({ canonicalKey }) => (canonicalKey ? [canonicalKey] : []));
    return {
      canonicalGroup: samples[0]?.canonicalGroup ?? "",
      canonicalKeys,
      consistent:
        rows.length === samples.length &&
        rows.every(({ adapterStatus }) => adapterStatus === "AVAILABLE") &&
        canonicalKeys.length === samples.length &&
        new Set(canonicalKeys).size === 1,
      sampleIds: samples.map(({ id }) => id),
    };
  });
}

function groupedCanonicalSamples(samples: readonly P014Sample[]): P014Sample[][] {
  const groups = new Map<string, P014Sample[]>();
  for (const sample of samples) {
    if (!sample.canonicalGroup) continue;
    const group = groups.get(sample.canonicalGroup) ?? [];
    group.push(sample);
    groups.set(sample.canonicalGroup, group);
  }
  return [...groups.values()].filter((group) => group.length >= 2);
}

function qualityGateStrengthErrors(gates: P014QualityGates): string[] {
  return [
    ...(gates.maximumFalseAcceptRate <= P014_PROJECT_MINIMUM_GATES.maximumFalseAcceptRate
      ? []
      : ["maximumFalseAcceptRate is weaker than the project minimum"]),
    ...(gates.maximumFalseRejectRate <= P014_PROJECT_MINIMUM_GATES.maximumFalseRejectRate
      ? []
      : ["maximumFalseRejectRate is weaker than the project minimum"]),
    ...(gates.maximumManualReviewRate <= P014_PROJECT_MINIMUM_GATES.maximumManualReviewRate
      ? []
      : ["maximumManualReviewRate is weaker than the project minimum"]),
    ...(gates.maximumP95LatencyMs <= P014_PROJECT_MINIMUM_GATES.maximumP95LatencyMs
      ? []
      : ["maximumP95LatencyMs is weaker than the project minimum"]),
    ...(gates.minimumCanonicalConsistencyRate >=
    P014_PROJECT_MINIMUM_GATES.minimumCanonicalConsistencyRate
      ? []
      : ["minimumCanonicalConsistencyRate is weaker than the project minimum"]),
    ...(gates.minimumExpectedAvailableResolutionRate >=
    P014_PROJECT_MINIMUM_GATES.minimumExpectedAvailableResolutionRate
      ? []
      : ["minimumExpectedAvailableResolutionRate is weaker than the project minimum"]),
    ...(gates.minimumMatchAutoPassRate >= P014_PROJECT_MINIMUM_GATES.minimumMatchAutoPassRate
      ? []
      : ["minimumMatchAutoPassRate is weaker than the project minimum"]),
    ...(gates.minimumUnavailableRecognitionRate >=
    P014_PROJECT_MINIMUM_GATES.minimumUnavailableRecognitionRate
      ? []
      : ["minimumUnavailableRecognitionRate is weaker than the project minimum"]),
  ];
}

function parsePolicy(value: unknown, index: number): P014PolicyCandidate {
  const row = record(value, `manifest.policyCandidates[${index}]`);
  return {
    imageSimilarityThreshold: score(
      row.imageSimilarityThreshold,
      `manifest.policyCandidates[${index}].imageSimilarityThreshold`,
    ),
    manualReviewMargin: score(
      row.manualReviewMargin,
      `manifest.policyCandidates[${index}].manualReviewMargin`,
    ),
    policyVersion: requiredString(
      row.policyVersion,
      `manifest.policyCandidates[${index}].policyVersion`,
    ),
    requireImageMatch: requiredBoolean(
      row.requireImageMatch,
      `manifest.policyCandidates[${index}].requireImageMatch`,
    ),
    textSimilarityThreshold: score(
      row.textSimilarityThreshold,
      `manifest.policyCandidates[${index}].textSimilarityThreshold`,
    ),
  };
}

function parseQualityGates(value: unknown): P014QualityGates {
  const row = record(value, "manifest.qualityGates");
  return {
    maximumFalseAcceptRate: score(
      row.maximumFalseAcceptRate,
      "manifest.qualityGates.maximumFalseAcceptRate",
    ),
    maximumFalseRejectRate: score(
      row.maximumFalseRejectRate,
      "manifest.qualityGates.maximumFalseRejectRate",
    ),
    maximumManualReviewRate: score(
      row.maximumManualReviewRate,
      "manifest.qualityGates.maximumManualReviewRate",
    ),
    maximumP95LatencyMs: positiveNumber(
      row.maximumP95LatencyMs,
      "manifest.qualityGates.maximumP95LatencyMs",
    ),
    minimumCanonicalConsistencyRate: score(
      row.minimumCanonicalConsistencyRate,
      "manifest.qualityGates.minimumCanonicalConsistencyRate",
    ),
    minimumExpectedAvailableResolutionRate: score(
      row.minimumExpectedAvailableResolutionRate,
      "manifest.qualityGates.minimumExpectedAvailableResolutionRate",
    ),
    minimumMatchAutoPassRate: score(
      row.minimumMatchAutoPassRate,
      "manifest.qualityGates.minimumMatchAutoPassRate",
    ),
    minimumUnavailableRecognitionRate: score(
      row.minimumUnavailableRecognitionRate,
      "manifest.qualityGates.minimumUnavailableRecognitionRate",
    ),
  };
}

function parseSample(value: unknown, index: number): P014Sample {
  const label = `manifest.samples[${index}]`;
  const row = record(value, label);
  const sampleLabel = enumValue(row.label, ["MATCH", "MISMATCH", "UNAVAILABLE"], `${label}.label`);
  const scenarios = array(row.scenarios, `${label}.scenarios`).map((scenario, scenarioIndex) =>
    enumValue(scenario, P014_SCENARIOS, `${label}.scenarios[${scenarioIndex}]`),
  );
  if (scenarios.length === 0) throw new Error(`${label}.scenarios must not be empty`);
  if (new Set(scenarios).size !== scenarios.length) {
    throw new Error(`${label}.scenarios contains duplicates`);
  }
  if (sampleLabel === "UNAVAILABLE" && !scenarios.includes("UNAVAILABLE_CONTENT")) {
    throw new Error(`${label} with UNAVAILABLE label must include UNAVAILABLE_CONTENT`);
  }
  const content = record(row.expectedContent, `${label}.expectedContent`);
  const images = array(content.images, `${label}.expectedContent.images`).map(
    (rawImage, imageIndex) => {
      const image = record(rawImage, `${label}.expectedContent.images[${imageIndex}]`);
      const checksum = requiredString(
        image.checksum,
        `${label}.expectedContent.images[${imageIndex}].checksum`,
      ).toLowerCase();
      if (!/^[0-9a-f]{64}$/u.test(checksum)) {
        throw new Error(`${label}.expectedContent.images[${imageIndex}].checksum is invalid`);
      }
      const perceptualHash = optionalString(image.perceptualHash);
      if (perceptualHash && !/^[0-9a-f]{16,256}$/iu.test(perceptualHash)) {
        throw new Error(`${label}.expectedContent.images[${imageIndex}].perceptualHash is invalid`);
      }
      const imageUrl = requiredString(
        image.imageUrl,
        `${label}.expectedContent.images[${imageIndex}].imageUrl`,
      );
      validHttpUrl(imageUrl, `${label}.expectedContent.images[${imageIndex}].imageUrl`);
      return { checksum, imageUrl, perceptualHash };
    },
  );
  if (images.length === 0) throw new Error(`${label}.expectedContent.images must not be empty`);
  return {
    canonicalGroup: optionalString(row.canonicalGroup),
    expectedContent: {
      body: requiredString(content.body, `${label}.expectedContent.body`),
      hashtags: stringArray(content.hashtags, `${label}.expectedContent.hashtags`),
      images,
      title: requiredString(content.title, `${label}.expectedContent.title`),
    },
    id: requiredString(row.id, `${label}.id`),
    input: requiredString(row.input, `${label}.input`),
    label: sampleLabel,
    notes: optionalString(row.notes),
    scenarios,
  };
}

function parseResultEvidence(value: unknown, parentLabel: string): P014SampleResult["evidence"] {
  const label = `${parentLabel}.evidence`;
  const row = record(value, label);
  return {
    adapterModel: optionalString(row.adapterModel),
    adapterReference: optionalString(row.adapterReference),
    adapterRequestId: requiredString(row.adapterRequestId, `${label}.adapterRequestId`),
    body: requiredString(row.body, `${label}.body`),
    externalPublishedAt: optionalString(row.externalPublishedAt),
    hashtags: stringArray(row.hashtags, `${label}.hashtags`),
    images: array(row.images, `${label}.images`).map((rawImage, index) => {
      const imageLabel = `${label}.images[${index}]`;
      const image = record(rawImage, imageLabel);
      return {
        checksum: optionalString(image.checksum),
        perceptualHash: optionalString(image.perceptualHash),
        url: optionalString(image.url),
      };
    }),
    provider: requiredString(row.provider, `${label}.provider`),
    title: requiredString(row.title, `${label}.title`),
  };
}

function parseResultError(
  value: unknown,
  parentLabel: string,
): NonNullable<P014SampleResult["error"]> {
  const label = `${parentLabel}.error`;
  const row = record(value, label);
  return {
    code: requiredString(row.code, `${label}.code`),
    message: requiredString(row.message, `${label}.message`),
    retryable: requiredBoolean(row.retryable, `${label}.retryable`),
  };
}

function parseResultEvaluation(value: unknown, label: string): P014PolicyEvaluation {
  const row = record(value, label);
  return {
    decision: enumValue(row.decision, ["INVALID", "MANUAL_REVIEW", "VALID"], `${label}.decision`),
    factScore: nullableScore(row.factScore, `${label}.factScore`),
    failureReason: optionalString(row.failureReason),
    imageScore: nullableScore(row.imageScore, `${label}.imageScore`),
    overallScore: score(row.overallScore, `${label}.overallScore`),
    policyVersion: requiredString(row.policyVersion, `${label}.policyVersion`),
    textScore: score(row.textScore, `${label}.textScore`),
  };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function nullableScore(value: unknown, label: string): number | null {
  return value === null ? null : score(value, label);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringArray(value: unknown, label: string): string[] {
  const values = array(value, label);
  if (values.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  return values.map((item) => (item as string).trim());
}

function validHttpUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
}
