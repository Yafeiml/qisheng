import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const privatePath =
  /^(?:(?:backup|output|tmp|素材|deploy\/(?:bak|data))\/)|(?:^|\/)AGENTS\.md$|(?:^|\/)(?:\.git|node_modules|\.artifacts|\.tools|\.next|dist|coverage|playwright-report|test-results)\/|(?:^|\/)\.env(?:\..+)?$|(?:^|\/)project\.private\.config\.json$|^deploy\/s3\.json(?:\..*)?$|\.(?:pem|key|p12|pfx|dump|sqlite3?|zip|tgz|tar(?:\.gz)?)$/iu;
const token =
  /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{16,})\b/u;
const secretAssignment =
  /(?<![\w:.-])(?:[A-Za-z0-9_.]*(?:password|secret)|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']([^"'\r\n]{24,})["']/giu;
const placeholder = /(?:dev[-_]|example|fixture|placeholder|test|dummy|replace|sample|\$\{|\\|`)/iu;
const settingName = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u;
const localOrExampleIp =
  /^(?:0\.|127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|255\.255\.255\.255$)/u;
// Fingerprints identify retired deployment domains without redistributing their names.
const privateDomainHashes = new Set([
  "6c88f6629c7cf5d612d01102260761862575013bfbe85858ba0e8782cd77fabf",
]);
const reviewableRules = new Set([
  "CREDENTIAL_URL",
  "OPERATIONS_IDENTIFIER",
  "POSSIBLE_SECRET_ASSIGNMENT",
  "EMAIL_IDENTIFIER",
]);
export const sourceFingerprint = (value) => createHash("sha256").update(value).digest("hex");

function privateDomain(hostname) {
  const labels = hostname.toLowerCase().split(".");
  return labels.some((_, index) =>
    privateDomainHashes.has(sourceFingerprint(labels.slice(index).join("."))),
  );
}

function exampleDomain(hostname) {
  return /^(?:localhost|127\.0\.0\.1|[^.]+\.example(?:\.com)?|example\.(?:com|org|net)|.+\.(?:example|test|invalid)|example\.invalid)$/iu.test(
    hostname,
  );
}

// Return locations and rule names only; source lines and matched values are never returned.
export function inspectSourceText(path, text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const add = (rule, level) => findings.push({ path, line: index + 1, rule, level });
    if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u.test(line))
      add("PRIVATE_KEY", "blocker");
    if (token.test(line)) add("TOKEN_LITERAL", "blocker");
    if (
      [...line.matchAll(secretAssignment)].some(
        ([, value]) =>
          !placeholder.test(value) && !settingName.test(value) && new Set(value).size >= 12,
      )
    )
      add("POSSIBLE_SECRET_ASSIGNMENT", "review");
    if (
      [
        ...line.matchAll(
          /\b(?:postgres(?:ql)?|mysql|redis|https?):\/\/[^\s/:@]+:[^\s/@]+@([^\s/:]+)/giu,
        ),
      ].length > 0
    )
      add("CREDENTIAL_URL", "blocker");
    if (
      [...line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)].some(
        ([address]) =>
          address.split(".").every((part) => Number(part) <= 255) &&
          !localOrExampleIp.test(address),
      ) ||
      /\bwx[0-9a-f]{16}\b|[A-Z]:[\\/]Users[\\/][^\\/\s]+/iu.test(line) ||
      [...line.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/giu)].some(([hostname]) =>
        privateDomain(hostname),
      )
    )
      add("OPERATIONS_IDENTIFIER", "review");
    const withoutUrls = line.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, "");
    if (
      [...withoutUrls.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/gu)].some(
        ([, host]) => !exampleDomain(host),
      )
    )
      add("EMAIL_IDENTIFIER", "review");
  }
  return findings;
}

export function listSourceFiles(root) {
  const top = execFileSync(
    "git",
    ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "rev-parse", "--show-toplevel"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (relative(realpathSync(top), realpathSync(root)) !== "")
    throw new Error("Source checks require their own Git repository root");
  const files = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${root.replaceAll("\\", "/")}`,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set(files)].sort();
}

function sourcePolicy(root) {
  const path = resolve(root, "scripts/publication/source-policy.json");
  if (!existsSync(path)) return { reviewedFindings: [], reviewedAssets: [] };
  const policy = JSON.parse(readFileSync(path, "utf8"));
  if (
    policy.version !== 1 ||
    !Array.isArray(policy.reviewedFindings) ||
    !Array.isArray(policy.reviewedAssets) ||
    policy.reviewedFindings.some(
      (row) =>
        !reviewableRules.has(row.rule) || !/^[a-f0-9]{64}$/u.test(row.fingerprint) || !row.reason,
    ) ||
    policy.reviewedAssets.some((row) => !/^[a-f0-9]{64}$/u.test(row.sha256) || !row.reason)
  )
    throw new Error("Invalid source review policy");
  return policy;
}

export function scanSourceFiles(root, paths) {
  const findings = [],
    reviewedFindings = [],
    manifest = [];
  const policy = sourcePolicy(root);
  const canonicalRoot = realpathSync(root);
  let textFiles = 0;
  let mediaFiles = 0;
  for (const path of [...new Set(paths)].sort()) {
    if (privatePath.test(path) && !/(?:^|\/)\.env\.example$/u.test(path)) {
      findings.push({ path, rule: "PRIVATE_OR_GENERATED_PATH", level: "blocker" });
      continue;
    }
    const fullPath = resolve(root, path);
    const inside = relative(canonicalRoot, fullPath);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
      findings.push({ path, rule: "PATH_OUTSIDE_SOURCE", level: "blocker" });
      continue;
    }
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      findings.push({ path, rule: "NON_REGULAR_FILE", level: "blocker" });
      continue;
    }
    const realRelative = relative(canonicalRoot, realpathSync(fullPath));
    if (isAbsolute(realRelative) || realRelative === ".." || realRelative.startsWith(`..${sep}`)) {
      findings.push({ path, rule: "PATH_OUTSIDE_SOURCE", level: "blocker" });
      continue;
    }
    if (stat.size > 16 * 1024 * 1024) {
      findings.push({ path, rule: "LARGE_FILE_NOT_SCANNED", level: "review" });
      continue;
    }
    const bytes = readFileSync(fullPath);
    const sha256 = sourceFingerprint(bytes);
    manifest.push({ path, sha256, bytes: bytes.length });
    if (bytes.includes(0)) {
      mediaFiles++;
      if (!policy.reviewedAssets.some((row) => row.path === path && row.sha256 === sha256))
        findings.push({ path, rule: "BINARY_ASSET_REVIEW_REQUIRED", level: "review" });
      continue;
    }
    textFiles++;
    const source = bytes.toString("utf8");
    if (source.startsWith("version https://git-lfs.github.com/spec/v1"))
      findings.push({ path, rule: "LFS_CONTENT_NOT_SCANNED", level: "review" });
    const lines = source.split(/\r?\n/u);
    for (const finding of inspectSourceText(path, source)) {
      const reviewed = policy.reviewedFindings.find(
        (row) =>
          row.path === path &&
          row.rule === finding.rule &&
          row.fingerprint === sourceFingerprint(lines[finding.line - 1]),
      );
      if (reviewed) reviewedFindings.push({ ...finding, reason: reviewed.reason });
      else findings.push(finding);
    }
  }
  const sourceStatus = findings.some(({ level }) => level === "blocker")
    ? "BLOCKED"
    : findings.length
      ? "REQUIRES_REVIEW"
      : "PASS";
  const licensePresent = ["LICENSE", "LICENSE.md", "LICENSE.txt"].some((name) =>
    manifest.some((row) => row.path === name),
  );
  if (!licensePresent)
    findings.unshift({ path: "LICENSE", rule: "LICENSE_UNDECIDED", level: "blocker" });
  return {
    status: findings.some(({ level }) => level === "blocker")
      ? "BLOCKED"
      : findings.length
        ? "REQUIRES_MANUAL_REVIEW"
        : "READY_FOR_REVIEW",
    sourceStatus,
    licenseStatus: licensePresent ? "PRESENT" : "UNDECIDED",
    candidateFiles: manifest.length,
    textFiles,
    mediaFiles,
    findings,
    reviewedFindings,
    manifest,
    limitations: [
      "Scans current non-ignored source files, not ignored configuration, databases or external services. It never uploads or publishes.",
      "A clean source snapshot does not sanitize Git history, refs, reflogs or unreachable objects. Never copy the workspace .git directory for publication.",
      "Reviewed exceptions match exact file, rule and line fingerprint; edits invalidate them. Patterns can still miss credentials.",
      "Asset reviews cover identifiers and metadata, not a copyright license or permission to publish.",
    ],
  };
}

export function checkSourcePublication(root) {
  const result = scanSourceFiles(root, listSourceFiles(root));
  let hasCommits = true;
  try {
    execFileSync(
      "git",
      ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "rev-parse", "--verify", "HEAD"],
      {
        cwd: root,
        stdio: "ignore",
      },
    );
  } catch {
    hasCommits = false;
  }
  const gitReferenceTypes = execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${root.replaceAll("\\", "/")}`,
      "for-each-ref",
      "--format=%(objecttype)",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  return {
    ...result,
    hasCommits,
    gitReferenceTypes,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const result = checkSourcePublication(root);
    if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `${result.status}: source=${result.sourceStatus}; license=${result.licenseStatus}; ${result.candidateFiles} files; ${result.reviewedFindings.length} exact fixture reviews.`,
      );
      for (const { path, line, rule, level } of result.findings)
        console.log(`${level}: ${path}${line ? `:${line}` : ""} [${rule}]`);
      for (const limitation of result.limitations) console.log(limitation);
    }
    process.exitCode = process.argv.includes("--prepare")
      ? Number(result.sourceStatus !== "PASS")
      : Number(result.status !== "READY_FOR_REVIEW");
  } catch {
    console.error(
      "Source publication check failed; no source content was printed. Verify Git and workspace access.",
    );
    process.exitCode = 1;
  }
}
