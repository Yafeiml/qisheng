import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  fileSha256,
  inspectLocalImage,
  runLocalContainer,
  saveImageArchive,
} from "./local-container.mjs";

test("all image operations select one explicit local WSLC session without Docker context", () => {
  const calls = [],
    options = {
      platform: "win32",
      env: { QISHENG_WSLC_SESSION: "local-test", DOCKER_HOST: "ssh://forbidden" },
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: JSON.stringify([{ Id: `sha256:${"a".repeat(64)}` }]) };
      },
    };
  runLocalContainer(["info", "--format", "json"], options);
  assert.equal(inspectLocalImage("qisheng/web:test", options).Id, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(calls, [
    ["wslc.exe", ["--session", "local-test", "info", "--format", "json"]],
    ["wslc.exe", ["--session", "local-test", "image", "inspect", "qisheng/web:test"]],
  ]);
  assert.throws(() => runLocalContainer(["build"], { ...options, platform: "linux" }), /Windows/);
  assert.throws(
    () => runLocalContainer(["build"], { ...options, env: { QISHENG_WSLC_SESSION: "x; exit" } }),
    /会话名称无效/,
  );
  assert.throws(
    () =>
      runLocalContainer(["build"], { ...options, run: () => ({ status: 1, stderr: "failed" }) }),
    /failed/,
  );
});

test("large binary save output is streamed to gzip with checksum and temporary-file cleanup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qisheng-local-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = Buffer.from([0, 255, 128, 10, 13, 1, 2, 3]),
    archive = join(root, "images.tar.gz");
  const options = {
    platform: "win32",
    run: (command, args) => {
      assert.equal(command, "wslc.exe");
      assert.deepEqual(args.slice(0, 2), ["save", "--output"]);
      writeFileSync(args[2], raw);
      return { status: 0 };
    },
  };
  const receipt = saveImageArchive(["qisheng/api:fixture"], archive, options);
  assert.deepEqual(gunzipSync(readFileSync(archive)), raw);
  assert.equal(receipt.sha256, fileSha256(archive));
  assert.equal(receipt.sha256, createHash("sha256").update(readFileSync(archive)).digest("hex"));
  assert.deepEqual(readdirSync(root), ["images.tar.gz"]);
  assert.throws(() => saveImageArchive(["qisheng/api:fixture"], archive, options), /拒绝覆盖/);
  assert.throws(
    () => saveImageArchive(["qisheng/api:fixture;whoami"], join(root, "bad.tar.gz"), options),
    /范围无效/,
  );
  assert.throws(
    () =>
      saveImageArchive(["qisheng/api:fixture"], join(root, "failure.tar.gz"), {
        ...options,
        run: () => ({ status: 1 }),
      }),
    /WSLC save 失败/,
  );
  assert.equal(existsSync(join(root, "failure.tar.gz")), false);
  assert.deepEqual(readdirSync(root), ["images.tar.gz"]);
});

test("archive publication cannot overwrite an output created while WSLC is saving", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qisheng-archive-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, "images.tar.gz");
  assert.throws(
    () =>
      saveImageArchive(["qisheng/api:test"], archive, {
        platform: "win32",
        run: (_command, args) => {
          writeFileSync(args[2], "tar");
          writeFileSync(archive, "existing other release");
          return { status: 0 };
        },
      }),
    /EEXIST/,
  );
  assert.equal(readFileSync(archive, "utf8"), "existing other release");
  assert.deepEqual(readdirSync(root), ["images.tar.gz"]);
});
