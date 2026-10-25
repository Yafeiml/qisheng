import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  HttpPublicationVerificationAdapter,
  PublicationVerificationInvocationError,
} from "../../apps/api/src/platform-settings/publication-verification-adapter";
import { normalizePublicationUrl } from "../../apps/api/src/publication/publication-url";
import {
  evaluatePublicationEvidence,
  PUBLICATION_SCORING_PROFILE_VERSION,
} from "../../apps/api/src/publication/publication-verification-scoring";
import {
  type P014Manifest,
  type P014Sample,
  type P014SampleResult,
  p014CoverageErrors,
  parseP014Manifest,
  summarizeP014Benchmark,
} from "./p014-core";
import { createP014ReviewHtml } from "./p014-review-page";

type Configuration = Readonly<{
  allowHttp: boolean;
  allowSmall: boolean;
  apiKey: string;
  concurrency: number;
  endpoint: string;
  outputDirectory: string;
  preflightOnly: boolean;
  provider: string;
  timeoutMs: number;
}>;

async function main(): Promise<void> {
  const manifestArgument = process.argv[2];
  if (!manifestArgument) {
    throw new Error("Usage: pnpm benchmark:p014 <real-sample-manifest.json>");
  }
  const manifestPath = resolve(process.cwd(), manifestArgument);
  const manifest = parseP014Manifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const configuration = configurationFromEnvironment(manifest);
  const inputRows = manifest.samples.map((sample) => ({
    normalized: normalizeSampleInput(sample),
    sample,
  }));
  const coverageErrors = p014CoverageErrors(manifest);
  const productionEligibilityErrors = productionEligibility(configuration, manifest);
  const preflight = {
    benchmarkId: manifest.benchmarkId,
    configuration: {
      allowHttp: configuration.allowHttp,
      allowSmall: configuration.allowSmall,
      concurrency: configuration.concurrency,
      endpoint: redactedEndpoint(configuration.endpoint),
      outputDirectory: configuration.outputDirectory,
      provider: configuration.provider,
      timeoutMs: configuration.timeoutMs,
    },
    coverageErrors,
    inputClassifications: countBy(inputRows, ({ normalized }) => normalized.classification),
    productionEligibilityErrors,
    readyForFormalExecution:
      coverageErrors.length === 0 && productionEligibilityErrors.length === 0,
    sampleCount: manifest.samples.length,
    synthetic: false,
  };
  if (configuration.preflightOnly) {
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    if (!preflight.readyForFormalExecution) process.exitCode = 2;
    return;
  }
  const preRunErrors = [...coverageErrors, ...productionEligibilityErrors];
  if (preRunErrors.length > 0 && !configuration.allowSmall) {
    throw new Error(
      `P-014 configuration is not eligible for a paid provider run:\n- ${preRunErrors.join("\n- ")}\nUse P014_BENCHMARK_ALLOW_SMALL=true only for a non-acceptance smoke run.`,
    );
  }
  await assertArtifactDirectoryIsNew(configuration.outputDirectory);
  await mkdir(configuration.outputDirectory, { recursive: true });

  const adapter = new HttpPublicationVerificationAdapter({
    allowHttp: configuration.allowHttp,
    apiKey: configuration.apiKey,
    endpoint: configuration.endpoint,
    provider: configuration.provider,
    timeoutMs: configuration.timeoutMs,
  });
  const startedAt = new Date();
  const results = await parallelMap(
    inputRows,
    configuration.concurrency,
    ({ normalized, sample }) => evaluateSample(adapter, manifest, sample, normalized),
  );
  const summary = summarizeP014Benchmark(manifest, results);
  const manifestArtifact = `${JSON.stringify(manifest, null, 2)}\n`;
  const resultsArtifact = `${JSON.stringify(
    {
      benchmarkId: manifest.benchmarkId,
      samples: results,
      schemaVersion: 1,
      synthetic: false,
    },
    null,
    2,
  )}\n`;
  const report = {
    accepted: false,
    artifactHashes: {
      manifestSha256: sha256(manifestArtifact),
      resultsSha256: sha256(resultsArtifact),
    },
    automatedGate: {
      errors: summary.automatedGateErrors,
      passed: summary.automatedGatePassed,
    },
    benchmarkId: manifest.benchmarkId,
    executionMode:
      preRunErrors.length === 0 && !configuration.allowSmall ? "FORMAL" : "NON_ACCEPTANCE_SMOKE",
    finishedAt: new Date().toISOString(),
    manualReviewRequired: true,
    productionEligibility: {
      eligible: productionEligibilityErrors.length === 0,
      errors: productionEligibilityErrors,
    },
    provider: {
      declaredName: manifest.providerDeclaration.name,
      endpoint: redactedEndpoint(configuration.endpoint),
      runtimeCode: configuration.provider,
    },
    schemaVersion: 1,
    scoringProfileVersion: PUBLICATION_SCORING_PROFILE_VERSION,
    startedAt: startedAt.toISOString(),
    summary,
    synthetic: false,
    warning:
      "AUTOMATED_GATES_DO_NOT_FREEZE_PRODUCTION_POLICY_UNTIL_MANUAL_REVIEW_AND_ACCEPTANCE_VERIFICATION_PASS",
  };
  const reportArtifact = `${JSON.stringify(report, null, 2)}\n`;
  const reviewTemplate = {
    approvedPolicyVersion: summary.recommendedPolicyVersion,
    benchmarkId: manifest.benchmarkId,
    conclusionNotes: "",
    entries: results.map(({ sampleId }) => ({
      decision: "PENDING",
      issue: "",
      notes: "",
      sampleId,
    })),
    responsibilityAccepted: false,
    reviewedAt: null,
    reviewer: "",
    schemaVersion: 1,
    synthetic: false,
  };
  await Promise.all([
    writeFile(resolve(configuration.outputDirectory, "manifest.json"), manifestArtifact, {
      mode: 0o600,
    }),
    writeFile(resolve(configuration.outputDirectory, "results.json"), resultsArtifact, {
      mode: 0o600,
    }),
    writeFile(resolve(configuration.outputDirectory, "report.json"), reportArtifact, {
      mode: 0o600,
    }),
    writeFile(
      resolve(configuration.outputDirectory, "manual-review.template.json"),
      `${JSON.stringify(reviewTemplate, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      resolve(configuration.outputDirectory, "review.html"),
      createP014ReviewHtml(manifest, results, summary),
      { mode: 0o600 },
    ),
  ]);
  process.stdout.write(
    `${JSON.stringify(
      {
        automatedGatePassed: summary.automatedGatePassed,
        benchmarkId: manifest.benchmarkId,
        outputDirectory: configuration.outputDirectory,
        productionEligible: productionEligibilityErrors.length === 0,
        recommendedPolicyVersion: summary.recommendedPolicyVersion,
        reviewCommand: `node scripts/dev/serve-review.mjs ${configuration.outputDirectory}`,
        synthetic: false,
        verifyCommand: `pnpm benchmark:p014:verify ${configuration.outputDirectory}`,
      },
      null,
      2,
    )}\n`,
  );
  if (!summary.automatedGatePassed || productionEligibilityErrors.length > 0) process.exitCode = 2;
}

async function evaluateSample(
  adapter: HttpPublicationVerificationAdapter,
  manifest: P014Manifest,
  sample: P014Sample,
  normalized: ReturnType<typeof normalizeSampleInput>,
): Promise<P014SampleResult> {
  const startedAt = performance.now();
  try {
    const resolution = await adapter.resolve(
      normalized.normalizedUrl,
      `p014:${manifest.benchmarkId}:${sample.id}`,
    );
    const latencyMs = performance.now() - startedAt;
    if (!resolution.available) {
      return {
        adapterStatus: "UNAVAILABLE",
        canonicalGroup: sample.canonicalGroup,
        canonicalKey: null,
        canonicalUrl: null,
        error: null,
        evidence: null,
        inputClassification: normalized.classification,
        inputNormalizedUrl: normalized.normalizedUrl,
        label: sample.label,
        latencyMs,
        policyEvaluations: [],
        sampleId: sample.id,
        scenarios: sample.scenarios,
      };
    }
    const evidence = resolution.evidence;
    return {
      adapterStatus: "AVAILABLE",
      canonicalGroup: sample.canonicalGroup,
      canonicalKey: evidence.canonicalKey,
      canonicalUrl: evidence.canonicalUrl,
      error: null,
      evidence: {
        adapterModel: evidence.adapterModel,
        adapterReference: evidence.adapterReference,
        adapterRequestId: evidence.adapterRequestId,
        body: evidence.body,
        externalPublishedAt: evidence.externalPublishedAt,
        hashtags: evidence.hashtags,
        images: evidence.images,
        provider: evidence.provider,
        title: evidence.title,
      },
      inputClassification: normalized.classification,
      inputNormalizedUrl: normalized.normalizedUrl,
      label: sample.label,
      latencyMs,
      policyEvaluations: manifest.policyCandidates.map((policy) => ({
        ...evaluatePublicationEvidence({
          actual: evidence,
          expected: sample.expectedContent,
          policy,
        }),
        policyVersion: policy.policyVersion,
      })),
      sampleId: sample.id,
      scenarios: sample.scenarios,
    };
  } catch (error) {
    const invocation =
      error instanceof PublicationVerificationInvocationError
        ? error
        : new PublicationVerificationInvocationError(
            "P-014 provider invocation failed",
            "P014_UNEXPECTED_INVOCATION_ERROR",
            false,
          );
    return {
      adapterStatus: "ERROR",
      canonicalGroup: sample.canonicalGroup,
      canonicalKey: null,
      canonicalUrl: null,
      error: {
        code: invocation.code,
        message: invocation.message,
        retryable: invocation.retryable,
      },
      evidence: null,
      inputClassification: normalized.classification,
      inputNormalizedUrl: normalized.normalizedUrl,
      label: sample.label,
      latencyMs: performance.now() - startedAt,
      policyEvaluations: [],
      sampleId: sample.id,
      scenarios: sample.scenarios,
    };
  }
}

function normalizeSampleInput(sample: P014Sample): Readonly<{
  classification: "XHS_NOTE" | "XHS_SHORT";
  normalizedUrl: string;
}> {
  const normalized = normalizePublicationUrl(sample.input);
  if (normalized.classification !== "XHS_NOTE" && normalized.classification !== "XHS_SHORT") {
    throw new Error(`P-014 sample ${sample.id} is not a real Xiaohongshu long or short link`);
  }
  return { classification: normalized.classification, normalizedUrl: normalized.normalizedUrl };
}

function configurationFromEnvironment(manifest: P014Manifest): Configuration {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/gu, "")
    .slice(0, 14);
  return {
    allowHttp: booleanEnvironment("P014_BENCHMARK_ALLOW_HTTP"),
    allowSmall: booleanEnvironment("P014_BENCHMARK_ALLOW_SMALL"),
    apiKey: requiredEnvironment("P014_BENCHMARK_API_KEY"),
    concurrency: positiveIntegerEnvironment("P014_BENCHMARK_CONCURRENCY", 3),
    endpoint: requiredEnvironment("P014_BENCHMARK_ENDPOINT"),
    outputDirectory: resolve(
      process.cwd(),
      process.env.P014_BENCHMARK_OUTPUT_DIR ??
        `.artifacts/p014-${manifest.benchmarkId}-${timestamp}`,
    ),
    preflightOnly: booleanEnvironment("P014_BENCHMARK_PREFLIGHT_ONLY"),
    provider: requiredEnvironment("P014_BENCHMARK_PROVIDER"),
    timeoutMs: positiveIntegerEnvironment("P014_BENCHMARK_TIMEOUT_MS", 15_000),
  };
}

function productionEligibility(configuration: Configuration, manifest: P014Manifest): string[] {
  const endpoint = new URL(configuration.endpoint);
  const providerLooksSynthetic = /(?:^|[-_.])(dev|fixture|mock|synthetic|test)(?:$|[-_.])/iu.test(
    configuration.provider,
  );
  return [
    ...(endpoint.protocol === "https:" ? [] : ["formal acceptance requires an HTTPS endpoint"]),
    ...(isLocalEndpoint(endpoint.hostname)
      ? ["formal acceptance cannot use a loopback or .local provider endpoint"]
      : []),
    ...(providerLooksSynthetic
      ? ["provider runtime code appears to identify a synthetic, fixture, mock or test service"]
      : []),
    ...(manifest.providerDeclaration.productionService
      ? []
      : ["provider declaration does not identify a production service"]),
    ...(manifest.providerDeclaration.dataTermsReviewed
      ? []
      : ["provider data terms have not been reviewed"]),
    ...(configuration.allowSmall
      ? ["P014_BENCHMARK_ALLOW_SMALL runs are never production-eligible"]
      : []),
  ];
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

async function assertArtifactDirectoryIsNew(directory: string): Promise<void> {
  try {
    await stat(resolve(directory, "report.json"));
    throw new Error(`P-014 output directory already contains report.json: ${directory}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("P-014 output directory")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function parallelMap<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await mapper(item);
      }
    }),
  );
  return results;
}

function requiredEnvironment(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required and is never written to benchmark artifacts`);
  return value;
}

function booleanEnvironment(key: string): boolean {
  return process.env[key]?.trim().toLocaleLowerCase() === "true";
}

function positiveIntegerEnvironment(key: string, fallback: number): number {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function redactedEndpoint(value: string): string {
  const endpoint = new URL(value);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "P-014 benchmark failed"}\n`);
  process.exitCode = 1;
});
