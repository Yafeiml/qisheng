import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Verify every installed file before invoking the browser or using collector credentials. */
export async function verifyBundle(root: string): Promise<number> {
  const directory = resolve(root);
  const manifest = await readFile(join(directory, "SHA256SUMS.txt"), "utf8");
  const expected = new Set<string>();
  let count = 0;
  for (const line of manifest.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error("BUNDLE_MANIFEST_INVALID");
    const [, digest, relativePath] = match;
    if (!digest || !relativePath || relativePath.includes("\\") || isAbsolute(relativePath)) {
      throw new Error("BUNDLE_MANIFEST_INVALID");
    }
    const filename = resolve(directory, relativePath);
    if (!filename.startsWith(`${directory}${sep}`) || expected.has(relativePath)) {
      throw new Error("BUNDLE_MANIFEST_INVALID");
    }
    expected.add(relativePath);
    const content = await readFile(filename);
    if (createHash("sha256").update(content).digest("hex") !== digest) {
      throw new Error("BUNDLE_CHECKSUM_MISMATCH");
    }
    count += 1;
  }
  if (count === 0) throw new Error("BUNDLE_MANIFEST_EMPTY");
  const actual = await listFiles(directory);
  actual.delete("SHA256SUMS.txt");
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) {
    throw new Error("BUNDLE_CONTENT_UNEXPECTED");
  }
  return count;
}

async function listFiles(root: string, directory = root): Promise<Set<string>> {
  const files = new Set<string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("BUNDLE_SYMLINK_FORBIDDEN");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const child of await listFiles(root, path)) files.add(child);
    } else if (entry.isFile()) {
      files.add(relative(root, path).split(sep).join("/"));
    } else throw new Error("BUNDLE_CONTENT_UNEXPECTED");
  }
  return files;
}

if (require.main === module) {
  void verifyBundle(resolve(__dirname, ".."))
    .then((count) => process.stdout.write(`BUNDLE_CHECK_OK ${count}\n`))
    .catch(() => {
      process.stderr.write(
        "Bundle verification failed; replace with the intact release package.\n",
      );
      process.exitCode = 1;
    });
}
