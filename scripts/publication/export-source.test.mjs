import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportSource } from "./export-source.mjs";

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "qisheng-source-export-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "source");
  mkdirSync(root);
  execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "init"], {
    cwd: root,
    stdio: "ignore",
  });
  writeFileSync(join(root, ".gitignore"), ".env\n.artifacts/\n");
  writeFileSync(join(root, ".env"), "SECRET=DO_NOT_COPY\n");
  writeFileSync(join(root, "README.md"), "Project fixture\n");
  writeFileSync(join(root, "start.sh"), "#!/bin/sh\nexit 0\n");
  execFileSync(
    "git",
    ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "add", "--chmod=+x", "start.sh"],
    { cwd: root, stdio: "ignore" },
  );
  return { parent, root };
}

test("exports current reviewed source without ignored secrets or Git, even before a license decision", (t) => {
  const { parent, root } = fixture(t);
  const result = exportSource(root, join(parent, "review"));
  assert.equal(result.sourceStatus, "PASS");
  assert.equal(result.licenseStatus, "UNDECIDED");
  assert.equal(existsSync(join(result.path, ".git")), false);
  assert.equal(existsSync(join(result.path, ".env")), false);
  assert.equal(readFileSync(join(result.path, "README.md"), "utf8"), "Project fixture\n");
  const manifest = JSON.parse(readFileSync(join(result.path, "SOURCE_EXPORT.json"), "utf8"));
  assert.equal(manifest.publicationAllowed, false);
  assert.equal(manifest.gitHistoryIncluded, false);
  assert.equal(manifest.files.find(({ path }) => path === "start.sh").executable, true);
  assert.throws(() => exportSource(root, result.path), /never overwritten/u);
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=DO_NOT_COPY\n");
});

test("refuses exports with sensitive findings or into Git metadata", (t) => {
  const { parent, root } = fixture(t);
  assert.throws(() => exportSource(root, join(root, ".git", "review")), /outside Git metadata/u);
  assert.throws(() => exportSource(root, join(parent, ".git")), /outside Git metadata/u);
  assert.throws(() => exportSource(root, join(root, "nested-source")), /outside Git metadata/u);
  writeFileSync(join(root, "unsafe.ts"), `const key = "sk-${"TestSecret0123456789".repeat(3)}";`);
  assert.throws(() => exportSource(root, join(parent, "refused")), /unreviewed findings/u);
  assert.equal(existsSync(join(parent, "refused")), false);
  assert.deepEqual(readdirSync(parent), ["source"]);
});
