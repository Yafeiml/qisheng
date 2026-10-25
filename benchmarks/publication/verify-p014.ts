import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PUBLICATION_SCORING_PROFILE_VERSION } from "../../apps/api/src/publication/publication-verification-scoring";
import { parseP014Manifest, parseP014Results, summarizeP014Benchmark } from "./p014-core";

export async function verifyP014Output(outputDirectoryArgument: string) {
  const outputDirectory = resolve(process.cwd(), outputDirectoryArgument);
  const [manifestArtifact, resultsArtifact, reportArtifact, reviewArtifact] = await Promise.all([
    readFile(resolve(outputDirectory, "manifest.json"), "utf8"),
    readFile(resolve(outputDirectory, "results.json"), "utf8"),
    readFile(resolve(outputDirectory, "report.json"), "utf8"),
    readFile(resolve(outputDirectory, "manual-review.json"), "utf8"),
  ]);
  const manifest = parseP014Manifest(JSON.parse(manifestArtifact) as unknown);
  const results = parseP014Results(JSON.parse(resultsArtifact) as unknown, manifest);
  const report = record(JSON.parse(reportArtifact) as unknown, "report");
  const review = record(JSON.parse(reviewArtifact) as unknown, "manual review");
  const summary = summarizeP014Benchmark(manifest, results);
  const reviewResult = verifyManualReview(review, manifest.benchmarkId, results, summary);
  const artifactHashes = record(report.artifactHashes, "report.artifactHashes");
  const productionEligibility = record(
    report.productionEligibility,
    "report.productionEligibility",
  );
  const automatedGate = record(report.automatedGate, "report.automatedGate");
  const provider = record(report.provider, "report.provider");
  const errors = [
    ...(report.schemaVersion === 1 ? [] : ["report.schemaVersion must be 1"]),
    ...(report.synthetic === false ? [] : ["report.synthetic must be false"]),
    ...(report.benchmarkId === manifest.benchmarkId
      ? []
      : ["report benchmarkId does not match manifest"]),
    ...(report.executionMode === "FORMAL" ? [] : ["only a FORMAL P-014 execution can be accepted"]),
    ...(report.scoringProfileVersion === PUBLICATION_SCORING_PROFILE_VERSION
      ? []
      : ["report scoring profile does not match the current production scoring implementation"]),
    ...(artifactHashes.manifestSha256 === sha256(manifestArtifact)
      ? []
      : ["manifest.json SHA-256 does not match report"]),
    ...(artifactHashes.resultsSha256 === sha256(resultsArtifact)
      ? []
      : ["results.json SHA-256 does not match report"]),
    ...(productionEligibility.eligible === true
      ? []
      : ["benchmark report is not production-eligible"]),
    ...providerReportErrors(provider),
    ...(automatedGate.passed === true ? [] : ["recorded automated benchmark gate did not pass"]),
    ...(summary.automatedGatePassed
      ? []
      : summary.automatedGateErrors.map((error) => `recomputed gate: ${error}`)),
    ...reviewResult.errors,
  ];
  const approvedPolicy = manifest.policyCandidates.find(
    ({ policyVersion }) => policyVersion === reviewResult.approvedPolicyVersion,
  );
  const acceptance = {
    accepted: errors.length === 0,
    approvedPolicy: approvedPolicy ?? null,
    automatedGatePassed: summary.automatedGatePassed,
    benchmarkId: manifest.benchmarkId,
    checkedAt: new Date().toISOString(),
    errors,
    evidenceHashes: {
      manifestSha256: sha256(manifestArtifact),
      manualReviewSha256: sha256(reviewArtifact),
      reportSha256: sha256(reportArtifact),
      resultsSha256: sha256(resultsArtifact),
    },
    manualReview: reviewResult,
    provider: {
      declaredName: manifest.providerDeclaration.name,
      endpoint: optionalString(provider.endpoint),
      runtimeCode: optionalString(provider.runtimeCode),
    },
    scoringProfileVersion: PUBLICATION_SCORING_PROFILE_VERSION,
    schemaVersion: 1,
    synthetic: false,
  };
  const acceptancePath = resolve(outputDirectory, "acceptance-report.json");
  await writeFile(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`, { mode: 0o600 });
  return { acceptancePath, ...acceptance };
}

function verifyManualReview(
  review: Record<string, unknown>,
  benchmarkId: string,
  results: readonly Readonly<{ sampleId: string }>[],
  summary: ReturnType<typeof summarizeP014Benchmark>,
) {
  const errors: string[] = [];
  if (review.schemaVersion !== 1) errors.push("manual review schemaVersion must be 1");
  if (review.synthetic !== false) errors.push("manual review synthetic must be false");
  if (review.benchmarkId !== benchmarkId) errors.push("manual review benchmarkId does not match");
  const reviewer = optionalString(review.reviewer);
  if (!reviewer || reviewer.length < 2) errors.push("manual review signer is required");
  if (review.responsibilityAccepted !== true) {
    errors.push("manual review responsibility confirmation is required");
  }
  const reviewedAt = optionalString(review.reviewedAt);
  if (!reviewedAt || Number.isNaN(new Date(reviewedAt).getTime())) {
    errors.push("manual review reviewedAt must be a valid timestamp");
  }
  const approvedPolicyVersion = optionalString(review.approvedPolicyVersion);
  if (!approvedPolicyVersion || !summary.passingPolicyVersions.includes(approvedPolicyVersion)) {
    errors.push("manual review must approve a policy version that passed automated gates");
  }
  const expectedIds = new Set(results.map(({ sampleId }) => sampleId));
  const rawEntries = Array.isArray(review.entries) ? review.entries : [];
  if (rawEntries.length !== expectedIds.size) {
    errors.push("manual review must contain every benchmark sample exactly once");
  }
  const received = new Set<string>();
  let passed = 0;
  let failed = 0;
  for (const [index, rawEntry] of rawEntries.entries()) {
    const entry = record(rawEntry, `manual review entries[${index}]`);
    const sampleId = optionalString(entry.sampleId);
    if (!sampleId || !expectedIds.has(sampleId) || received.has(sampleId)) {
      errors.push(`manual review entry ${index} contains an unknown or duplicate sampleId`);
      continue;
    }
    received.add(sampleId);
    if (entry.decision === "PASS") passed += 1;
    else if (entry.decision === "FAIL") failed += 1;
    else errors.push(`manual review entry ${sampleId} must be PASS or FAIL`);
  }
  if (failed > 0) errors.push("manual review contains failed samples; policy cannot be frozen");
  return {
    accepted: errors.length === 0 && failed === 0 && passed === expectedIds.size,
    approvedPolicyVersion,
    errors,
    failed,
    passed,
    reviewedAt,
    reviewer,
    total: expectedIds.size,
  };
}

function providerReportErrors(provider: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const endpointText = optionalString(provider.endpoint);
  if (!endpointText) return ["report provider endpoint is missing"];
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch {
    return ["report provider endpoint is invalid"];
  }
  if (endpoint.protocol !== "https:") errors.push("accepted provider endpoint must use HTTPS");
  if (isLocalEndpoint(endpoint.hostname)) {
    errors.push("accepted provider endpoint cannot be loopback or .local");
  }
  const runtimeCode = optionalString(provider.runtimeCode);
  if (!runtimeCode) errors.push("report provider runtime code is missing");
  else if (/(?:^|[-_.])(dev|fixture|mock|synthetic|test)(?:$|[-_.])/iu.test(runtimeCode)) {
    errors.push("report provider runtime code identifies a non-production service");
  }
  return errors;
}

function isLocalEndpoint(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".local") ||
    normalized.startsWith("127.")
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function run(): Promise<void> {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error("Usage: pnpm benchmark:p014:verify <benchmark-output-directory>");
  }
  const acceptance = await verifyP014Output(outputDirectory);
  process.stdout.write(`${JSON.stringify(acceptance, null, 2)}\n`);
  if (!acceptance.accepted) process.exitCode = 2;
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "P-014 acceptance failed"}\n`);
    process.exitCode = 1;
  });
}
