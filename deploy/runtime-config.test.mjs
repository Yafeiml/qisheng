import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  initializeConfig,
  initializeStorageDirectory,
  loadConfig,
  runtimeEnvironment,
} = require("./docker/runtime-config.cjs");
const script = fileURLToPath(new URL("./docker/runtime-config.cjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qisheng-runtime-test-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("qisheng-runtime-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  return join(root, "config", "runtime.json");
}

test("Docker-only first boot generates independent persisted keys and database passwords", (t) => {
  const file = fixture(t);
  const saved = initializeConfig(file, {});
  assert.equal(Buffer.from(saved.MODEL_CREDENTIAL_ENCRYPTION_KEY, "base64").length, 32);
  assert.notEqual(saved.MODEL_CREDENTIAL_ENCRYPTION_KEY, saved.ADMIN_JWT_SECRET);
  assert.notEqual(saved.POSTGRES_PASSWORD, saved.REDIS_PASSWORD);
  assert.equal(readFileSync(join(dirname(file), "postgres-user"), "utf8"), saved.POSTGRES_USER);
  assert.equal(readFileSync(join(dirname(file), "postgres-database"), "utf8"), saved.POSTGRES_DB);
  assert.equal(
    readFileSync(join(dirname(file), "postgres-password"), "utf8"),
    saved.POSTGRES_PASSWORD,
  );
  assert.equal(new URL(saved.DATABASE_URL).hostname, "postgres");
  assert.equal(new URL(saved.REDIS_URL).hostname, "redis");
  assert.equal(saved.NEXT_PUBLIC_API_BASE_URL, "/api");
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  }
});

test("bootstrap prepares the private shared local storage directory without changing files", (t) => {
  const file = fixture(t);
  const directory = join(dirname(file), "objects");
  initializeStorageDirectory(directory);
  const object = join(directory, "existing-object");
  writeFileSync(object, "retained");
  initializeStorageDirectory(directory);
  assert.equal(readFileSync(object, "utf8"), "retained");
  if (process.platform !== "win32") {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    if (process.getuid?.() === 0) assert.equal(statSync(directory).uid, 1000);
  }
  assert.throws(() => initializeStorageDirectory(object));
});

test("database identity is derived from persisted configuration rather than Compose shell interpolation", (t) => {
  const file = fixture(t);
  const saved = initializeConfig(file, {
    POSTGRES_USER: "fixture-user",
    POSTGRES_DB: "fixture-db",
  });
  assert.equal(new URL(saved.DATABASE_URL).username, "fixture-user");
  assert.equal(new URL(saved.DATABASE_URL).pathname, "/fixture-db");
  initializeConfig(file, { POSTGRES_USER: "changed-user", POSTGRES_DB: "changed-db" });
  assert.equal(readFileSync(join(dirname(file), "postgres-user"), "utf8"), "fixture-user");
  assert.equal(readFileSync(join(dirname(file), "postgres-database"), "utf8"), "fixture-db");
});

test("restart reuses every original key and can recover a missing derived password file", (t) => {
  const file = fixture(t);
  const saved = initializeConfig(file, {});
  const original = readFileSync(file, "utf8");
  unlinkSync(join(dirname(file), "redis-password"));
  assert.deepEqual(initializeConfig(file, {}), saved);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(join(dirname(file), "redis-password"), "utf8"), saved.REDIS_PASSWORD);
});

test("bootstrap derives a separate managed-node key without changing persisted master keys", (t) => {
  const file = fixture(t);
  const saved = initializeConfig(file, {});
  const original = readFileSync(file, "utf8");
  const keyFile = join(dirname(file), "readback-node-key");
  const key = readFileSync(keyFile, "utf8");
  assert.equal(
    key,
    createHmac("sha256", saved.ADMIN_JWT_SECRET)
      .update("qisheng:managed-readback-node:v1")
      .digest("base64"),
  );
  assert.notEqual(key, saved.ADMIN_JWT_SECRET);
  assert.equal(Buffer.from(key, "base64").length, 32);
  assert.deepEqual(initializeConfig(file, {}), saved);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(keyFile, "utf8"), key);
  unlinkSync(keyFile);
  initializeConfig(file, {});
  assert.equal(readFileSync(keyFile, "utf8"), key);
  assert.equal(readFileSync(file, "utf8"), original);
  if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600);
});

test("bootstrap refuses to replace a changed managed-node key", (t) => {
  const file = fixture(t);
  initializeConfig(file, {});
  const original = readFileSync(file, "utf8");
  const keyFile = join(dirname(file), "readback-node-key");
  writeFileSync(keyFile, "different-fixture-node-key");
  assert.throws(() => initializeConfig(file, {}), /refusing to overwrite/u);
  assert.equal(readFileSync(keyFile, "utf8"), "different-fixture-node-key");
  assert.equal(readFileSync(file, "utf8"), original);
});

test("existing application keys are imported without changing encrypted-data identity", (t) => {
  const file = fixture(t);
  const environment = Object.fromEntries(
    [
      "MODEL_CREDENTIAL_ENCRYPTION_KEY",
      "ADMIN_JWT_SECRET",
      "EMPLOYEE_JWT_SECRET",
      "ADMIN_OTP_HMAC_SECRET",
      "EMPLOYEE_OTP_HMAC_SECRET",
    ].map((key) => [key, randomBytes(32).toString("base64")]),
  );
  environment.DATABASE_URL = "postgresql://fixture:fixture@db.example.com/fixture";
  const saved = initializeConfig(file, environment);
  for (const [key, value] of Object.entries(environment)) assert.equal(saved[key], value);
  assert.equal(runtimeEnvironment(file, { ...environment, API_PORT: "4000" }).API_PORT, "4000");
  assert.throws(
    () => runtimeEnvironment(file, { ADMIN_JWT_SECRET: "changed-fixture-key" }),
    /refusing to rotate/u,
  );
});

test("partial or missing migration keys and malformed persisted state fail without replacement", (t) => {
  const file = fixture(t);
  assert.throws(
    () => initializeConfig(file, { ADMIN_JWT_SECRET: "partial-fixture-key" }),
    /partial key migration/u,
  );
  assert.throws(
    () => initializeConfig(file, { DATABASE_URL: "postgresql://db.example.com/fixture" }),
    /explicit application keys/u,
  );
  mkdirSync(dirname(file), { recursive: true });
  const incomplete = JSON.stringify({ version: 1, environment: { ADMIN_JWT_SECRET: "fixture" } });
  writeFileSync(file, incomplete);
  assert.throws(() => initializeConfig(file, {}), /incomplete/u);
  assert.equal(readFileSync(file, "utf8"), incomplete);
});

test("a changed database password file is never overwritten", (t) => {
  const file = fixture(t);
  initializeConfig(file, {});
  const path = join(dirname(file), "postgres-password");
  writeFileSync(path, "different-fixture-password");
  assert.throws(() => initializeConfig(file, {}), /refusing to overwrite/u);
  assert.equal(readFileSync(path, "utf8"), "different-fixture-password");
});

test("launcher loads persisted environment and preserves child exit code without printing keys", (t) => {
  const file = fixture(t);
  const saved = initializeConfig(file, {});
  const child = spawnSync(
    process.execPath,
    [
      script,
      "run",
      process.execPath,
      "-e",
      "if (!process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY) process.exit(1); console.log('CONFIG_LOADED'); process.exit(7);",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, QISHENG_RUNTIME_CONFIG: file },
    },
  );
  assert.equal(child.status, 7, child.stderr);
  assert.match(child.stdout, /CONFIG_LOADED/u);
  assert.equal(child.stdout.includes(saved.INSTALLATION_TOKEN), false);
  const token = spawnSync(process.execPath, [script, "token"], {
    encoding: "utf8",
    env: { ...process.env, QISHENG_RUNTIME_CONFIG: file },
  });
  assert.equal(token.status, 1);
  assert.equal(token.stdout.includes(saved.INSTALLATION_TOKEN), false);
  assert.deepEqual(loadConfig(file), saved);
});
