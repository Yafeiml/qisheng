import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { differenceHash } from "../image-similarity";
import { evaluateRealProviderReview } from "./real-provider-review";

export async function verifyRealProviderOutput(outputDirectoryArgument: string) {
  const outputDirectory = resolve(process.cwd(), outputDirectoryArgument);
  const [rawReport, rawResults, rawReview] = await Promise.all([
    readJson(resolve(outputDirectory, "report.json")),
    readJson(resolve(outputDirectory, "results.json")),
    readJson(resolve(outputDirectory, "manual-review.json")),
  ]);
  const report = recordValue(rawReport);
  const results = recordValue(rawResults);
  const benchmarkId = requiredString(report, "benchmarkId");
  const items = Array.isArray(results.items) ? results.items : [];
  const membershipIds = items.map((item, index) =>
    requiredString(recordValue(item), "employeeMembershipId", `results.items[${index}]`),
  );
  if (new Set(membershipIds).size !== membershipIds.length) {
    throw new Error("results.json contains duplicate employeeMembershipId values");
  }
  const artifactErrors = await verifyImageArtifacts(outputDirectory, items);
  const qualityReview = recordValue(report.qualityReview);
  const minimumPassRate = requiredRate(qualityReview.minimumPassRate, "minimumPassRate");
  const manualReview = evaluateRealProviderReview(
    rawReview,
    benchmarkId,
    membershipIds,
    minimumPassRate,
  );
  const automatedGate = recordValue(report.automatedGate);
  const errors = [
    ...(report.synthetic === false ? [] : ["report.synthetic must be false"]),
    ...(results.synthetic === false ? [] : ["results.synthetic must be false"]),
    ...(results.benchmarkId === benchmarkId ? [] : ["results benchmarkId does not match report"]),
    ...(automatedGate.passed === true ? [] : ["automated benchmark gate did not pass"]),
    ...(report.requested === membershipIds.length
      ? []
      : ["report.requested does not match successful result count"]),
    ...(report.success === membershipIds.length
      ? []
      : ["report.success does not match successful result count"]),
    ...(membershipIds.length >= 100
      ? []
      : ["formal acceptance requires at least 100 successful employee packages"]),
    ...artifactErrors,
    ...manualReview.errors,
    ...(manualReview.accepted || manualReview.errors.length > 0
      ? []
      : ["manual review did not meet the approval, pass-rate or hard-safety gate"]),
  ];
  const acceptance = {
    accepted: errors.length === 0 && manualReview.accepted,
    automatedGatePassed: automatedGate.passed === true,
    benchmarkId,
    checkedAt: new Date().toISOString(),
    errors,
    manualReview,
    schemaVersion: 1,
    synthetic: false,
  };
  const acceptancePath = resolve(outputDirectory, "acceptance-report.json");
  await writeFile(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`);
  return { acceptancePath, ...acceptance };
}

async function verifyImageArtifacts(
  outputDirectory: string,
  items: readonly unknown[],
): Promise<string[]> {
  const recordedChecksums = items.map((rawItem, index) =>
    requiredString(
      recordValue(recordValue(rawItem).image),
      "checksum",
      `results.items[${index}].image`,
    ),
  );
  const recordedPerceptualHashes = items.map((rawItem, index) =>
    requiredString(
      recordValue(recordValue(rawItem).image),
      "perceptualHash",
      `results.items[${index}].image`,
    ),
  );
  const checks = await Promise.all(
    items.map(async (rawItem, index): Promise<string[]> => {
      const item = recordValue(rawItem);
      const image = recordValue(item.image);
      const label = `results.items[${index}].image`;
      const imagePath = requiredString(image, "imagePath", label);
      const expectedChecksum = requiredString(image, "checksum", label);
      const expectedPerceptualHash = requiredString(image, "perceptualHash", label);
      const absolutePath = resolve(outputDirectory, imagePath);
      const relativePath = relative(outputDirectory, absolutePath);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        return [`${label}.imagePath escapes the benchmark output directory`];
      }
      try {
        const bytes = await readFile(absolutePath);
        const actualChecksum = createHash("sha256").update(bytes).digest("hex");
        const actualPerceptualHash = await differenceHash(bytes);
        return [
          ...(actualChecksum === expectedChecksum ? [] : [`${label} checksum does not match file`]),
          ...(actualPerceptualHash === expectedPerceptualHash
            ? []
            : [`${label} perceptual hash does not match file`]),
        ];
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown image read error";
        return [`${label} cannot be verified: ${message}`];
      }
    }),
  );
  return [
    ...(new Set(recordedChecksums).size === recordedChecksums.length
      ? []
      : ["results contain duplicate image checksums"]),
    ...(new Set(recordedPerceptualHashes).size === recordedPerceptualHashes.length
      ? []
      : ["results contain duplicate image perceptual hashes"]),
    ...checks.flat(),
  ];
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown read error";
    throw new Error(`Unable to read benchmark artifact ${path}: ${message}`);
  }
}

function requiredRate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return value;
}

function requiredString(value: Record<string, unknown>, key: string, label = "report"): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return candidate;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function run(): Promise<void> {
  const outputDirectoryArgument = process.argv[2];
  if (!outputDirectoryArgument) {
    throw new Error("Usage: pnpm benchmark:verify-real-provider <benchmark-output-directory>");
  }
  const acceptance = await verifyRealProviderOutput(outputDirectoryArgument);
  process.stdout.write(`${JSON.stringify(acceptance, null, 2)}\n`);
  if (!acceptance.accepted) process.exitCode = 2;
}

if (require.main === module) {
  void run().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Real provider acceptance failed"}\n`,
    );
    process.exitCode = 1;
  });
}
