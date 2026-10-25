import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { inspectGitHistory } from "./check-git-history.mjs";

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "qisheng-history-check-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (args, input) =>
    execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
      cwd: root,
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@localhost",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@localhost",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init"]);
  return { root, git };
}

function tarFile(name, contents) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header[156] = 48;
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return gzipSync(
    Buffer.concat([
      header,
      contents,
      Buffer.alloc((512 - (contents.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}

test("scans committed and unreachable blobs plus non-commit refs without leaking values", (t) => {
  const { root, git } = repository(t);
  writeFileSync(join(root, "README.md"), "Public fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "Fixture root"]);
  const secret = `sk-${"Ab123cd456ef789Gh".repeat(3)}`;
  const unreachable = git(["hash-object", "-w", "--stdin"], `const apiKey = "${secret}";`);
  const replacement = git(["hash-object", "-w", "--stdin"], "Public replacement\n");
  git(["replace", unreachable, replacement]);
  writeFileSync(join(root, ".env"), "PRIVATE_LOCAL_CONFIG=fixture\n");
  git(["add", "-f", ".env"]);
  const tree = git(["write-tree"]);
  git(["update-ref", "refs/codex/checkpoints/fixture", tree]);
  const result = inspectGitHistory(root);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.refs.some(({ type }) => type === "tree"));
  assert.ok(
    result.findings.some(({ rule, path }) => rule === "PRIVATE_PATH_IN_HISTORY" && path === ".env"),
  );
  assert.ok(
    result.findings.some(
      ({ object, rule, reachable }) =>
        object === unreachable && rule === "TOKEN_LITERAL" && !reachable,
    ),
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("inspects commit and reflog messages and reports remote configuration presence only", (t) => {
  const { root, git } = repository(t);
  writeFileSync(join(root, "README.md"), "Public fixture\n");
  git(["add", "."]);
  const secret = `sk-${"Xy123cd456ef789Gh".repeat(3)}`;
  git(["commit", "-m", `Fixture ${secret}`]);
  const remote = "https://user:opaque-private-password@private.example.invalid/repo.git";
  git(["config", "remote.fixture.url", remote]);
  git(["config", "http.extraHeader", "Authorization: fixture-only-opaque-value"]);
  const result = inspectGitHistory(root);
  assert.ok(
    result.findings.some(({ path, rule }) => path === "git:commit" && rule === "TOKEN_LITERAL"),
  );
  assert.ok(
    result.findings.some(({ path, rule }) => path === "git:reflog" && rule === "TOKEN_LITERAL"),
  );
  assert.equal(result.config.remoteUrlPresent, true);
  assert.equal(result.config.credentialConfigurationPresent, true);
  assert.ok(result.findings.some(({ rule }) => rule === "GIT_CREDENTIAL_CONFIG_REVIEW"));
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(remote), false);
  assert.equal(JSON.stringify(result).includes("opaque-private-password"), false);
  assert.equal(git(["config", "remote.fixture.url"]), remote);
});

test("inspects tar member paths and text in memory and inventories other binary blobs", (t) => {
  const { root, git } = repository(t);
  mkdirSync(join(root, "output"));
  const secret = `sk-${"Cd123ef456gh789Ij".repeat(3)}`;
  writeFileSync(
    join(root, "output", "fixture.tar.gz"),
    tarFile(".env", Buffer.from(`MODEL_API_KEY=${secret}\n`)),
  );
  writeFileSync(join(root, "fixture.png"), Buffer.from([137, 80, 78, 71, 0, 13, 10]));
  git(["add", "."]);
  git(["commit", "-m", "Binary fixtures"]);
  const before = git(["status", "--porcelain"]);
  const result = inspectGitHistory(root);
  assert.ok(
    result.findings.some(
      ({ rule, path }) => rule === "PRIVATE_ARCHIVE_MEMBER" && path.endsWith("!/.env"),
    ),
  );
  assert.ok(
    result.findings.some(({ rule, path }) => rule === "TOKEN_LITERAL" && path.endsWith("!/.env")),
  );
  assert.equal(result.objects.binaryBlobs, 2);
  assert.equal(
    result.binary.find(({ paths }) => paths.includes("output/fixture.tar.gz")).archive.textEntries,
    1,
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(git(["status", "--porcelain"]), before);
});

test("does not inspect ignored working secrets or exempt examples from text scans", (t) => {
  const { root, git } = repository(t);
  const ignoredSecret = `sk-${"NotRead1234567890".repeat(3)}`;
  writeFileSync(join(root, ".gitignore"), ".env\n.privategitconfig\n");
  writeFileSync(join(root, ".env"), ignoredSecret);
  writeFileSync(join(root, ".privategitconfig"), `[http]\nextraHeader=${ignoredSecret}\n`);
  git(["config", "include.path", "../.privategitconfig"]);
  writeFileSync(join(root, ".env.example"), "API_KEY=\n");
  git(["add", "."]);
  git(["commit", "-m", "Examples"]);
  const result = inspectGitHistory(root);
  assert.equal(result.findings.length, 0);
  assert.equal(result.config.externalIncludesPresent, true);
  assert.equal(result.objects.textBlobs, 2);
  assert.equal(JSON.stringify(result).includes(ignoredSecret), false);
});

test("requires the repository root and catches nested collaboration instructions in history", (t) => {
  const { root, git } = repository(t);
  const nested = join(root, "apps", "api");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "AGENTS.md"), "Private collaboration fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "Nested instructions fixture"]);
  assert.throws(() => inspectGitHistory(nested), /own Git repository root/u);
  const result = inspectGitHistory(root);
  assert.ok(
    result.findings.some(
      ({ path, rule }) => path === "apps/api/AGENTS.md" && rule === "PRIVATE_PATH_IN_HISTORY",
    ),
  );
});
