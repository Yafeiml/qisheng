#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkSourcePublication,
  scanSourceFiles,
  sourceFingerprint,
} from "./check-source-publication.mjs";

export function exportSource(root, destination) {
  const report = checkSourcePublication(root);
  if (report.sourceStatus !== "PASS")
    throw new Error("Source has unreviewed findings; export refused. Run source:check --prepare.");
  const target = resolve(destination);
  const canonicalRoot = realpathSync(root);
  const parent = realpathSync(dirname(target));
  const fromRoot = relative(canonicalRoot, parent);
  const candidate = resolve(parent, target.split(sep).at(-1));
  const metadata = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${root.replaceAll("\\", "/")}`,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/u);
  const inMetadata = metadata.some((path) => {
    const fromMetadata = relative(realpathSync(path), candidate);
    return (
      fromMetadata === "" ||
      (!isAbsolute(fromMetadata) && fromMetadata !== ".." && !fromMetadata.startsWith(`..${sep}`))
    );
  });
  if (
    target === canonicalRoot ||
    candidate.split(sep).some((part) => part.toLowerCase() === ".git") ||
    inMetadata ||
    existsSync(target) ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      fromRoot.split(sep)[0] !== ".artifacts")
  )
    throw new Error(
      "Export requires a new directory outside Git metadata; existing files are never overwritten.",
    );
  const modes = new Map(
    execFileSync(
      "git",
      ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "ls-files", "--stage", "-z"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        return [entry.slice(tab + 1), entry.startsWith("100755 ")];
      }),
  );
  mkdirSync(candidate, { mode: 0o700 });
  for (const file of report.manifest) {
    const output = resolve(candidate, file.path);
    const inside = relative(candidate, output);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
      throw new Error("Invalid source path");
    const source = resolve(root, file.path);
    const sourceRelative = relative(canonicalRoot, realpathSync(source));
    if (
      !lstatSync(source).isFile() ||
      lstatSync(source).isSymbolicLink() ||
      isAbsolute(sourceRelative) ||
      sourceRelative === ".." ||
      sourceRelative.startsWith(`..${sep}`)
    )
      throw new Error("Source path changed during export");
    const bytes = readFileSync(source);
    if (sourceFingerprint(bytes) !== file.sha256)
      throw new Error("Source changed during export; incomplete snapshot must not be published.");
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, bytes, { flag: "wx", mode: modes.get(file.path) ? 0o700 : 0o600 });
  }
  const copied = scanSourceFiles(
    candidate,
    report.manifest.map(({ path }) => path),
  );
  if (copied.sourceStatus !== "PASS")
    throw new Error("Export verification failed; incomplete snapshot must not be published.");
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    purpose: "LOCAL_REVIEW_ONLY",
    publicationAllowed: false,
    licenseStatus: copied.licenseStatus,
    gitHistoryIncluded: false,
    sourceStatus: copied.sourceStatus,
    files: copied.manifest.map((file) => ({ ...file, executable: modes.get(file.path) ?? false })),
    limitations: copied.limitations,
  };
  writeFileSync(
    resolve(candidate, "SOURCE_EXPORT.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    resolve(candidate, "NOT_FOR_PUBLICATION.txt"),
    "Local review snapshot. No Git history is included. License and publication approval remain undecided. Do not publish this snapshot as-is.\n",
    { flag: "wx", mode: 0o600 },
  );
  return {
    path: candidate,
    sourceStatus: copied.sourceStatus,
    licenseStatus: copied.licenseStatus,
    files: copied.manifest.length,
    gitHistoryIncluded: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    if (process.argv.length > 3)
      throw new Error("Usage: node scripts/publication/export-source.mjs [new-output-directory]");
    const parent = resolve(root, ".artifacts");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const target = process.argv[2] ?? resolve(parent, `open-source-review-${Date.now()}`);
    console.log(JSON.stringify(exportSource(root, target), null, 2));
  } catch {
    console.error(
      "Source export refused or failed. Review source:check --prepare and use a new output directory; no publication or history rewrite was performed.",
    );
    process.exitCode = 1;
  }
}
