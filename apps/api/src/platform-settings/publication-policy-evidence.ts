import { createHash } from "node:crypto";
import { normalizePublicHttpUrl } from "@xhs-agentic/network-security";

export const MAX_PUBLICATION_POLICY_EVIDENCE_BYTES = 128 * 1024;

export type ParsedPublicationPolicyEvidence = Readonly<{
  acceptanceReportSha256: string;
  benchmarkId: string;
  imageSimilarityThreshold: number;
  manualReviewMargin: number;
  policyVersion: string;
  providerCode: string;
  providerEndpoint: string;
  report: Record<string, unknown>;
  reportCheckedAt: Date;
  requireImageMatch: true;
  reviewer: string;
  sampleCount: number;
  scoringProfileVersion: string;
  textSimilarityThreshold: number;
}>;

export function parsePublicationPolicyEvidence(
  acceptanceReportJson: string,
): ParsedPublicationPolicyEvidence {
  if (Buffer.byteLength(acceptanceReportJson, "utf8") > MAX_PUBLICATION_POLICY_EVIDENCE_BYTES) {
    throw new Error("P-014 acceptance report exceeds the 128 KiB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(acceptanceReportJson) as unknown;
  } catch {
    throw new Error("P-014 acceptance report is not valid JSON");
  }
  const report = record(parsed, "acceptance report");
  if (report.schemaVersion !== 1) throw new Error("P-014 acceptance schemaVersion must be 1");
  if (report.accepted !== true) throw new Error("P-014 acceptance report has not been accepted");
  if (report.synthetic !== false) throw new Error("Synthetic P-014 evidence cannot be registered");
  if (report.automatedGatePassed !== true) {
    throw new Error("P-014 automated quality gates have not passed");
  }
  const errors = array(report.errors, "acceptance report errors");
  if (errors.length > 0) throw new Error("P-014 acceptance report contains errors");

  const benchmarkId = requiredString(report.benchmarkId, "benchmarkId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/u.test(benchmarkId)) {
    throw new Error("P-014 benchmarkId is invalid");
  }
  const scoringProfileVersion = requiredString(
    report.scoringProfileVersion,
    "scoringProfileVersion",
  );
  const approvedPolicy = record(report.approvedPolicy, "approvedPolicy");
  const policyVersion = requiredString(
    approvedPolicy.policyVersion,
    "approvedPolicy.policyVersion",
  );
  const textSimilarityThreshold = score(
    approvedPolicy.textSimilarityThreshold,
    "approvedPolicy.textSimilarityThreshold",
  );
  const imageSimilarityThreshold = score(
    approvedPolicy.imageSimilarityThreshold,
    "approvedPolicy.imageSimilarityThreshold",
  );
  const manualReviewMargin = score(
    approvedPolicy.manualReviewMargin,
    "approvedPolicy.manualReviewMargin",
  );
  if (manualReviewMargin > 0.5) {
    throw new Error("P-014 manual review margin cannot exceed 0.5");
  }
  if (approvedPolicy.requireImageMatch !== true) {
    throw new Error("Production P-014 evidence must require the employee-specific image to match");
  }

  const manualReview = record(report.manualReview, "manualReview");
  if (manualReview.accepted !== true) throw new Error("P-014 manual review was not accepted");
  if (manualReview.approvedPolicyVersion !== policyVersion) {
    throw new Error("P-014 manual review does not approve the reported policy version");
  }
  const sampleCount = positiveInteger(manualReview.total, "manualReview.total");
  const passed = nonNegativeInteger(manualReview.passed, "manualReview.passed");
  const failed = nonNegativeInteger(manualReview.failed, "manualReview.failed");
  if (sampleCount < 30 || passed !== sampleCount || failed !== 0) {
    throw new Error("P-014 manual review must pass every one of at least 30 real samples");
  }
  const reviewer = requiredString(manualReview.reviewer, "manualReview.reviewer");

  const provider = record(report.provider, "provider");
  const providerCode = requiredString(provider.runtimeCode, "provider.runtimeCode");
  if (/(?:^|[-_.])(dev|fixture|mock|synthetic|test)(?:$|[-_.])/iu.test(providerCode)) {
    throw new Error("P-014 provider code identifies a non-production service");
  }
  const providerEndpoint = productionHttpsUrl(
    requiredString(provider.endpoint, "provider.endpoint"),
    "provider.endpoint",
  );
  const evidenceHashes = record(report.evidenceHashes, "evidenceHashes");
  for (const name of ["manifestSha256", "manualReviewSha256", "reportSha256", "resultsSha256"]) {
    const value = evidenceHashes[name];
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
      throw new Error(`P-014 evidence hash ${name} is invalid`);
    }
  }

  const reportCheckedAt = timestamp(report.checkedAt, "checkedAt");
  if (reportCheckedAt.getTime() > Date.now() + 5 * 60_000) {
    throw new Error("P-014 acceptance report timestamp is in the future");
  }

  return {
    acceptanceReportSha256: createHash("sha256").update(acceptanceReportJson, "utf8").digest("hex"),
    benchmarkId,
    imageSimilarityThreshold,
    manualReviewMargin,
    policyVersion,
    providerCode,
    providerEndpoint,
    report,
    reportCheckedAt,
    requireImageMatch: true,
    reviewer,
    sampleCount,
    scoringProfileVersion,
    textSimilarityThreshold,
  };
}

export function normalizeProductionEndpoint(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}

export function isProductionHttpsEndpoint(value: string): boolean {
  try {
    productionHttpsUrl(value, "endpoint");
    return true;
  } catch {
    return false;
  }
}

function productionHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = normalizePublicHttpUrl(value);
  } catch {
    throw new Error(`P-014 ${label} is invalid`);
  }
  if (url.search) {
    throw new Error(`P-014 ${label} must be a public credential-free HTTPS URL`);
  }
  return normalizeProductionEndpoint(url.toString());
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`P-014 ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`P-014 ${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`P-014 ${label} is required`);
  }
  return value.trim();
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`P-014 ${label} must be between 0 and 1`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`P-014 ${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`P-014 ${label} must be a non-negative integer`);
  }
  return value;
}

function timestamp(value: unknown, label: string): Date {
  const parsed = new Date(requiredString(value, label));
  if (Number.isNaN(parsed.getTime())) throw new Error(`P-014 ${label} is invalid`);
  return parsed;
}
