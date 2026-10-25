import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { differenceHash, hashSimilarity } from "../image-similarity";

interface ManifestEntry {
  cost?: number;
  employeeMembershipId: string;
  imagePath: string;
  latencyMs?: number;
  model: string;
  provider: string;
}

interface ImageManifest {
  benchmarkId: string;
  entries: ManifestEntry[];
  synthetic?: boolean;
}

function percentile(values: number[], target: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * target) - 1);
  return sorted[index] ?? null;
}

async function run(): Promise<void> {
  const manifestArgument = process.argv[2];
  if (!manifestArgument) {
    throw new Error("Usage: pnpm benchmark:images <manifest.json>");
  }

  const manifestPath = resolve(process.cwd(), manifestArgument);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageManifest;
  if (!manifest.benchmarkId || !Array.isArray(manifest.entries) || manifest.entries.length < 2) {
    throw new Error("Image benchmark manifest requires benchmarkId and at least two entries");
  }

  const manifestDirectory = dirname(manifestPath);
  const hashes = await Promise.all(
    manifest.entries.map(async (entry) => ({
      entry,
      hash: await differenceHash(resolve(manifestDirectory, entry.imagePath)),
    })),
  );

  let maximumSimilarity = 0;
  let closestPair: [string, string] | null = null;
  for (let first = 0; first < hashes.length; first += 1) {
    for (let second = first + 1; second < hashes.length; second += 1) {
      const firstEntry = hashes[first];
      const secondEntry = hashes[second];
      if (!firstEntry || !secondEntry) {
        continue;
      }
      const similarity = hashSimilarity(firstEntry.hash, secondEntry.hash);
      if (similarity > maximumSimilarity) {
        maximumSimilarity = similarity;
        closestPair = [
          firstEntry.entry.employeeMembershipId,
          secondEntry.entry.employeeMembershipId,
        ];
      }
    }
  }

  const latencyValues = manifest.entries.flatMap((entry) =>
    entry.latencyMs === undefined ? [] : [entry.latencyMs],
  );
  const totalCost = manifest.entries.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmarkId: manifest.benchmarkId,
        closestPair,
        imageCount: manifest.entries.length,
        maximumPerceptualSimilarity: maximumSimilarity,
        p50LatencyMs: percentile(latencyValues, 0.5),
        p95LatencyMs: percentile(latencyValues, 0.95),
        synthetic: manifest.synthetic ?? false,
        totalCost,
      },
      null,
      2,
    )}\n`,
  );
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown image benchmark error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
