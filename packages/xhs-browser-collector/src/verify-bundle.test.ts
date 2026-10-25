import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBundle } from "./verify-bundle";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function bundle(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xhs-bundle-validation-"));
  directories.push(directory);
  const bytes = Buffer.from("pinned program", "utf8");
  await writeFile(join(directory, "package.json"), bytes);
  await writeFile(
    join(directory, "SHA256SUMS.txt"),
    `${createHash("sha256").update(bytes).digest("hex")}  package.json\n`,
  );
  return directory;
}

describe("Windows release verification", () => {
  it("verifies its complete manifest and rejects a modified program", async () => {
    const directory = await bundle();
    await expect(verifyBundle(directory)).resolves.toBe(1);
    await writeFile(join(directory, "package.json"), "modified");
    await expect(verifyBundle(directory)).rejects.toThrow("BUNDLE_CHECKSUM_MISMATCH");
  });

  it("rejects extra files or a manifest entry outside the unpacked directory", async () => {
    const directory = await bundle();
    await writeFile(join(directory, "extra.txt"), "unexpected");
    await expect(verifyBundle(directory)).rejects.toThrow("BUNDLE_CONTENT_UNEXPECTED");
    await writeFile(join(directory, "SHA256SUMS.txt"), `${"0".repeat(64)}  ../outside.txt\n`);
    await expect(verifyBundle(directory)).rejects.toThrow("BUNDLE_MANIFEST_INVALID");
  });
});
