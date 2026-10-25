import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { differenceHash } from "../image-similarity";
import { REAL_PROVIDER_REVIEW_CRITERIA_VERSION } from "./real-provider-review";
import { verifyRealProviderOutput } from "./verify-real-provider";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("real provider acceptance verifier", () => {
  it("re-reads 100 unique images and accepts a complete approved review", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "xhs-real-provider-acceptance-"));
    temporaryDirectories.push(directory);
    const items = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const employeeMembershipId = `membership-${(index + 1).toString().padStart(3, "0")}`;
        const imagePath = `./${employeeMembershipId}.png`;
        const bytes = await uniquePng(BigInt(index + 1));
        await writeFile(resolve(directory, imagePath), bytes);
        return {
          employeeMembershipId,
          image: {
            checksum: createHash("sha256").update(bytes).digest("hex"),
            imagePath,
            perceptualHash: await differenceHash(bytes),
          },
        };
      }),
    );
    const benchmarkId = "real-provider-test-100";
    await Promise.all([
      writeJson(resolve(directory, "report.json"), {
        automatedGate: { errors: [], passed: true },
        benchmarkId,
        qualityReview: { minimumPassRate: 0.9 },
        requested: 100,
        success: 100,
        synthetic: false,
      }),
      writeJson(resolve(directory, "results.json"), {
        benchmarkId,
        items,
        synthetic: false,
      }),
      writeJson(resolve(directory, "manual-review.json"), {
        benchmarkId,
        conclusion: { decision: "APPROVED", notes: "通过试点复核" },
        criteriaVersion: REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
        entries: items.map((item) => ({
          decision: "PASS",
          employeeMembershipId: item.employeeMembershipId,
          issues: [],
          notes: "",
        })),
        reviewedAt: "2026-08-28T12:00:00.000Z",
        reviewer: "质量复核员",
        schemaVersion: 1,
        synthetic: false,
      }),
    ]);

    const acceptance = await verifyRealProviderOutput(directory);

    expect(acceptance).toMatchObject({
      accepted: true,
      automatedGatePassed: true,
      benchmarkId,
      errors: [],
      synthetic: false,
    });
    const saved = JSON.parse(
      await readFile(resolve(directory, "acceptance-report.json"), "utf8"),
    ) as { accepted: boolean };
    expect(saved.accepted).toBe(true);
  });

  it("rejects an image whose bytes no longer match its recorded checksum", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "xhs-real-provider-tamper-"));
    temporaryDirectories.push(directory);
    const sourceDirectory = await mkdtemp(resolve(tmpdir(), "xhs-real-provider-source-"));
    temporaryDirectories.push(sourceDirectory);
    const items = await createFixture(sourceDirectory);
    await Promise.all(
      items.map(async (item) => {
        const bytes = await readFile(resolve(sourceDirectory, item.image.imagePath));
        await writeFile(resolve(directory, item.image.imagePath), bytes);
      }),
    );
    const benchmarkId = "real-provider-tamper-test";
    await writeAcceptanceArtifacts(directory, benchmarkId, items);
    const firstItem = items[0];
    if (!firstItem) throw new Error("Acceptance fixture is empty");
    await writeFile(resolve(directory, firstItem.image.imagePath), await uniquePng(999n));

    const acceptance = await verifyRealProviderOutput(directory);

    expect(acceptance.accepted).toBe(false);
    expect(acceptance.errors).toContain("results.items[0].image checksum does not match file");
  });
});

async function createFixture(directory: string) {
  return Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      const employeeMembershipId = `membership-${(index + 1).toString().padStart(3, "0")}`;
      const imagePath = `./${employeeMembershipId}.png`;
      const bytes = await uniquePng(BigInt(index + 1));
      await writeFile(resolve(directory, imagePath), bytes);
      return {
        employeeMembershipId,
        image: {
          checksum: createHash("sha256").update(bytes).digest("hex"),
          imagePath,
          perceptualHash: await differenceHash(bytes),
        },
      };
    }),
  );
}

async function writeAcceptanceArtifacts(
  directory: string,
  benchmarkId: string,
  items: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  await Promise.all([
    writeJson(resolve(directory, "report.json"), {
      automatedGate: { errors: [], passed: true },
      benchmarkId,
      qualityReview: { minimumPassRate: 0.9 },
      requested: 100,
      success: 100,
      synthetic: false,
    }),
    writeJson(resolve(directory, "results.json"), { benchmarkId, items, synthetic: false }),
    writeJson(resolve(directory, "manual-review.json"), {
      benchmarkId,
      conclusion: { decision: "APPROVED", notes: "通过试点复核" },
      criteriaVersion: REAL_PROVIDER_REVIEW_CRITERIA_VERSION,
      entries: items.map((item) => ({
        decision: "PASS",
        employeeMembershipId: item.employeeMembershipId,
        issues: [],
        notes: "",
      })),
      reviewedAt: "2026-08-28T12:00:00.000Z",
      reviewer: "质量复核员",
      schemaVersion: 1,
      synthetic: false,
    }),
  ]);
}

async function uniquePng(code: bigint): Promise<Buffer> {
  const pixels = Buffer.alloc(9 * 8);
  for (let row = 0; row < 8; row += 1) {
    let value = 128;
    pixels[row * 9] = value;
    for (let column = 0; column < 8; column += 1) {
      const bit = row * 8 + column;
      value += (code & (1n << BigInt(bit))) === 0n ? 1 : -1;
      pixels[row * 9 + column + 1] = value;
    }
  }
  return sharp(pixels, { raw: { channels: 1, height: 8, width: 9 } })
    .png()
    .toBuffer();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
