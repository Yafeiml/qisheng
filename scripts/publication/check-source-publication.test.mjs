import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkSourcePublication,
  inspectSourceText,
  scanSourceFiles,
  sourceFingerprint,
} from "./check-source-publication.mjs";

test("reports credential locations without returning credential values or source lines", () => {
  const secret = `sk-${"Ab123cd456ef789Gh".repeat(3)}`;
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const result = inspectSourceText(
    "config.ts",
    `const key = "${secret}";\n${header}\n${"Ab123cd456ef789Gh".repeat(3)}`,
  );
  assert.deepEqual(
    result.map(({ line, rule }) => ({ line, rule })),
    [
      { line: 1, rule: "TOKEN_LITERAL" },
      { line: 2, rule: "PRIVATE_KEY" },
    ],
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("BEGIN PRIVATE"), false);
});

test("separates operational identifiers from credentials and permits documentation addresses", () => {
  assert.deepEqual(inspectSourceText("example.md", "http://127.0.0.1:3101 203.0.113.7"), []);
  assert.equal(inspectSourceText("config.ts", 'host: "10.20.30.40"')[0].level, "review");
  assert.equal(
    inspectSourceText("config.ts", "DATABASE_URL=postgresql://user:opaque@db.internal/db")[0].rule,
    "CREDENTIAL_URL",
  );
  assert.deepEqual(
    inspectSourceText("example.env", 'API_KEY="replace-with-a-dedicated-benchmark-key"'),
    [],
  );
  assert.deepEqual(
    inspectSourceText("settings.ts", 'accessKeySecret: "admin_sms.aliyun.access_key_secret"'),
    [],
  );
});

test("checks the prospective Git file set, preserves examples, and blocks tracked private paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qisheng-source-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
      cwd: root,
      stdio: "ignore",
    });
  git("init");
  writeFileSync(join(root, ".gitignore"), ".env\n.env.*\n!.env.example\noutput/\ndeploy/s3.json\n");
  writeFileSync(join(root, ".env"), `API_KEY=sk-${"DO_NOT_READ_OR_REPORT".repeat(3)}`);
  writeFileSync(join(root, ".env.example"), "API_KEY=\n");
  mkdirSync(join(root, "output"));
  writeFileSync(join(root, "output", "private.txt"), "private content");
  mkdirSync(join(root, "deploy"));
  writeFileSync(join(root, "deploy", "s3.json"), '{"secretAccessKey":"DO_NOT_READ_OR_REPORT"}');
  let result = checkSourcePublication(root);
  assert.equal(result.candidateFiles, 2);
  assert.equal(result.hasCommits, false);
  assert.deepEqual(result.gitReferenceTypes, []);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule, "LICENSE_UNDECIDED");
  writeFileSync(join(root, "LICENSE"), "fixture license, never a project license decision\n");
  git("add", "-f", ".env");
  result = checkSourcePublication(root);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.findings, [
    { path: ".env", rule: "PRIVATE_OR_GENERATED_PATH", level: "blocker" },
  ]);
  assert.equal(JSON.stringify(result).includes("DO_NOT_READ_OR_REPORT"), false);
  const nested = join(root, "snapshot");
  mkdirSync(nested);
  assert.throws(() => checkSourcePublication(nested), /own Git repository root/u);
});

test("a fixture approval is exact and cannot suppress a later edit or a real token", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qisheng-review-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/publication"), { recursive: true });
  const source = 'const host = "10.20.30.40";';
  writeFileSync(join(root, "fixture.ts"), source);
  const policy = {
    version: 1,
    reviewedFindings: [
      {
        path: "fixture.ts",
        rule: "OPERATIONS_IDENTIFIER",
        fingerprint: sourceFingerprint(source),
        reason: "Synthetic private-network rejection fixture",
      },
    ],
    reviewedAssets: [],
  };
  writeFileSync(join(root, "scripts/publication/source-policy.json"), JSON.stringify(policy));
  const first = scanSourceFiles(root, ["fixture.ts"]);
  assert.equal(first.sourceStatus, "PASS");
  assert.equal(first.licenseStatus, "UNDECIDED");
  assert.equal(first.reviewedFindings.length, 1);
  writeFileSync(join(root, "fixture.ts"), source.replace("10.20.30.40", "10.20.30.41"));
  assert.equal(scanSourceFiles(root, ["fixture.ts"]).sourceStatus, "REQUIRES_REVIEW");
  policy.reviewedFindings[0].rule = "TOKEN_LITERAL";
  writeFileSync(join(root, "scripts/publication/source-policy.json"), JSON.stringify(policy));
  assert.throws(() => scanSourceFiles(root, ["fixture.ts"]), /Invalid source review policy/u);
});

test("credentials on loopback, emails, unreviewed binaries and escaping paths remain visible", (t) => {
  assert.equal(
    inspectSourceText("source.ts", "postgresql://user:opaque@localhost/db")[0].rule,
    "CREDENTIAL_URL",
  );
  assert.equal(
    inspectSourceText("source.ts", "contact@private-company.internal")[0].rule,
    "EMAIL_IDENTIFIER",
  );
  const root = mkdtempSync(join(tmpdir(), "qisheng-unreviewed-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "example.png"), Buffer.from([0, 1, 2]));
  const result = scanSourceFiles(root, ["example.png", "../outside.txt"]);
  assert.ok(result.findings.some(({ rule }) => rule === "BINARY_ASSET_REVIEW_REQUIRED"));
  assert.ok(result.findings.some(({ rule }) => rule === "PATH_OUTSIDE_SOURCE"));
  assert.ok(
    scanSourceFiles(root, ["deploy/data/postgresql/PG_VERSION"]).findings.some(
      ({ rule }) => rule === "PRIVATE_OR_GENERATED_PATH",
    ),
  );
});
