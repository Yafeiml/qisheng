import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { runInNewContext } from "node:vm";
import {
  connectionProbe,
  connectionUrl,
  imageBuildArguments,
  initializeEnvironment,
  replaceEnvironment,
  services,
} from "./self-host.mjs";

test("initialization creates independent strong keys without rewriting connection settings", () => {
  const template =
    "DATABASE_URL=postgresql://example\nADMIN_JWT_SECRET=GENERATE_ADMIN_JWT\nMODEL_CREDENTIAL_ENCRYPTION_KEY=GENERATE_MODEL_KEY\n";
  const value = initializeEnvironment(template);
  const keys = value.match(/(?<==)[A-Za-z0-9+/]{43}=/gu);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(Buffer.from(keys[0], "base64").length, 32);
  assert.match(value, /DATABASE_URL=postgresql:\/\/example/u);
  assert.doesNotMatch(value, /GENERATE_/u);
});

test("installation template supplies required API and Worker environment values", () => {
  const environment = parseEnv(
    initializeEnvironment(readFileSync(new URL("./.env.example", import.meta.url), "utf8")),
  );
  const root = new URL("../", import.meta.url);
  for (const path of globSync("apps/{api,worker}/src/**/*.ts", { cwd: root })) {
    if (/\.(?:spec|test)\.ts$/u.test(path)) continue;
    const source = readFileSync(new URL(path.replaceAll("\\", "/"), root), "utf8");
    for (const [, key] of source.matchAll(
      /\b(?:requiredEnv|requiredEnvironmentValue|requiredSecret)\("([A-Z_]+)"\)/gu,
    )) {
      assert.ok(environment[key]?.trim(), `${path} requires ${key}`);
    }
  }
});

test("default install creates private managed connections with independent passwords", () => {
  const env = parseEnv(
    initializeEnvironment(readFileSync(new URL("./.env.example", import.meta.url), "utf8")),
  );
  const database = new URL(env.DATABASE_URL);
  const redis = new URL(env.REDIS_URL);
  assert.equal(env.QISHENG_DATABASE_MODE, "managed");
  assert.equal(env.COMPOSE_PROFILES, "");
  assert.equal(database.hostname, "postgres");
  assert.equal(redis.hostname, "redis");
  assert.equal(decodeURIComponent(database.password), env.POSTGRES_PASSWORD);
  assert.equal(decodeURIComponent(redis.password), env.REDIS_PASSWORD);
  assert.notEqual(env.POSTGRES_PASSWORD, env.REDIS_PASSWORD);
  assert.notEqual(env.INSTALLATION_TOKEN, env.ADMIN_JWT_SECRET);
  assert.equal(Buffer.from(env.INSTALLATION_TOKEN, "base64").length, 32);
});

test("init CLI keeps credentials out of redirected output and never overwrites an installation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qisheng-installer-test-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("qisheng-installer-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const deploy = join(root, "deploy");
  mkdirSync(deploy);
  for (const file of ["self-host.mjs", ".env.example"])
    copyFileSync(new URL(`./${file}`, import.meta.url), join(deploy, file));
  const run = () =>
    spawnSync(process.execPath, [join(deploy, "self-host.mjs"), "init"], { encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const before = readFileSync(join(deploy, ".env"), "utf8");
  const env = parseEnv(before);
  for (const key of [
    "INSTALLATION_TOKEN",
    "ADMIN_JWT_SECRET",
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
  ])
    assert.equal(first.stdout.includes(env[key]), false);
  const second = run();
  assert.equal(second.status, 1);
  assert.equal(readFileSync(join(deploy, ".env"), "utf8"), before);
});

test("external connection fields are encoded, validated and safe from Compose interpolation", () => {
  const password = "fixture:/@ $'&=";
  const url = connectionUrl("postgresql", {
    host: "db.example.com",
    port: "5432",
    username: "fixture@user",
    password,
    database: "fixture-db",
    tls: true,
  });
  assert.equal(decodeURIComponent(new URL(url).password), password);
  assert.equal(new URL(url).searchParams.get("sslmode"), "require");
  const value = replaceEnvironment("DATABASE_URL=placeholder\nCOMPOSE_PROFILES=managed\n", {
    DATABASE_URL: url,
    COMPOSE_PROFILES: "",
  });
  assert.equal(parseEnv(value).DATABASE_URL, url);
  assert.equal(parseEnv(value).COMPOSE_PROFILES, "");
  assert.match(value, /DATABASE_URL='/u);
  for (const port of ["0", "65536", "-1", "5432/path"])
    assert.throws(() => connectionUrl("redis", { host: "redis", port, database: "0" }));
  assert.throws(() => connectionUrl("redis", { host: "redis", port: "6379", database: "name" }));
  assert.throws(() =>
    replaceEnvironment("DATABASE_URL=placeholder", { DATABASE_URL: "bad\nINJECTED=true" }),
  );
});

for (const fail of [false, true]) {
  test(`connection probe performs read-only checks and closes clients (failure=${fail})`, async () => {
    const calls = [];
    const errors = [];
    const contextProcess = {
      env: { DATABASE_URL: "fixture", REDIS_URL: "fixture" },
      exitCode: undefined,
    };
    class Pool {
      async query(sql) {
        assert.match(sql, /^SELECT /u);
        calls.push("database");
        if (fail) throw new Error("fixture-password-must-not-be-printed");
        return { rows: [{}, {}, {}, {}] };
      }
      async end() {
        calls.push("database-closed");
      }
    }
    class Redis {
      on() {}
      async connect() {
        calls.push("redis-connected");
      }
      async ping() {
        calls.push("redis");
      }
      disconnect() {
        calls.push("redis-closed");
      }
    }
    await runInNewContext(connectionProbe, {
      require: (name) => (name === "pg" ? { Pool } : Redis),
      process: contextProcess,
      console: { log() {}, error: (message) => errors.push(message) },
    });
    assert.ok(calls.includes("database-closed"));
    assert.ok(calls.includes("redis-closed"));
    assert.equal(contextProcess.exitCode, fail ? 1 : undefined);
    assert.equal(calls.includes("redis"), !fail);
    assert.equal(errors.join(" ").includes("fixture-password-must-not-be-printed"), false);
  });
}

test("managed data stays private and setup does not depend on business storage readiness", () => {
  const compose = readFileSync(new URL("./compose.yml", import.meta.url), "utf8");
  assert.doesNotMatch(compose, /profiles:/u);
  assert.match(compose, /required: false/u);
  assert.match(compose, /service_completed_successfully/u);
  assert.doesNotMatch(compose, /5432:5432|6379:6379|image: .*:latest/u);
  assert.match(compose, /postgresql:\/var\/lib\/postgresql/u);
  assert.match(compose, /condition: service_started/u);
  assert.match(compose, /POSTGRES_USER_FILE: \/run\/qisheng\/postgres-user/u);
  assert.match(compose, /POSTGRES_DB_FILE: \/run\/qisheng\/postgres-database/u);
  assert.doesNotMatch(compose, /\$\{POSTGRES_(?:USER|DB)/u);
  assert.ok(
    readFileSync(new URL("../.gitignore", import.meta.url), "utf8").includes("/deploy/data/"),
  );
});

test("all images build locally without public addresses or DNS-specific build arguments", () => {
  for (const service of services) {
    const args = imageBuildArguments(service, "20261015");
    assert.ok(args.includes(`qisheng/${service}:20261015`));
    assert.equal(args.includes("--build-arg"), false);
  }
  assert.throws(() => imageBuildArguments("api", "bad version"));
  assert.throws(() => imageBuildArguments("unknown", "v1"));
  assert.ok(imageBuildArguments("readback", "20261025").includes("qisheng/readback:20261025"));
  assert.equal(services.includes("readback"), false);
});

test("optional colocated readback receives only its own identity and exposes no panel", () => {
  const compose = readFileSync(new URL("./compose.readback.yml", import.meta.url), "utf8");
  assert.match(compose, /READBACK_MANAGED: "true"/u);
  assert.match(compose, /PUBLICATION_READBACK_API_BASE_URL: http:\/\/api:3100/u);
  assert.match(compose, /PUBLICATION_READBACK_NODE_ID: selfhost-readback/u);
  assert.match(compose, /target: \/run\/qisheng-readback\/readback-node-key/u);
  assert.match(compose, /create_host_path: false/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /cap_drop: \["ALL"\]/u);
  assert.doesNotMatch(
    compose,
    /\bbuild:|ports:|env_file:|runtime\.json|ADMIN_JWT|DATABASE_URL|PROVIDER_TOKEN/u,
  );
});

test("runtime Compose consumes prebuilt images and has no private topology or build hook", () => {
  const compose = readFileSync(new URL("./compose.yml", import.meta.url), "utf8");
  assert.doesNotMatch(compose, /\bbuild:|network_mode:|\/opt\/|onessh|1panel|rclone|tailscale/iu);
  for (const service of services) assert.ok(compose.includes(`qisheng/${service}:`));
  assert.doesNotMatch(compose, /API_BIND_PORT/u);
  assert.match(compose, /ports: \["\$\{WEB_BIND_PORT:-3101\}:3101"\]/u);
  const api = compose.slice(compose.indexOf("  api:"), compose.indexOf("  web:"));
  assert.doesNotMatch(api, /ports:/u);
});

test("registered compatible migrations retain their exact checksums", () => {
  const policy = JSON.parse(
    readFileSync(new URL("./migration-policy.json", import.meta.url), "utf8"),
  );
  for (const [name, checksum] of Object.entries(policy.backwardCompatible)) {
    const sql = readFileSync(
      new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
    );
    assert.equal(createHash("sha256").update(sql).digest("hex"), checksum, name);
  }
});
