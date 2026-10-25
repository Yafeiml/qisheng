import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./docker/worker-preflight.cjs", import.meta.url), "utf8");
const { Queue: BullQueue } = createRequire(new URL("../apps/worker/package.json", import.meta.url))(
  "bullmq",
);
async function runPreflight({
  supported = true,
  existingPlan = false,
  runOnlyPlan = false,
  requireVersion = false,
  verifyRunning = false,
  runningWorkerNames = ["medical-plan-v1:test"],
  omitRawname = false,
  settingsError,
  credentialError,
  storageProvider = "S3",
} = {}) {
  const queried = [];
  const queueNames = [];
  const storageProviders = [];
  const env = {
    DATABASE_URL: "postgresql://test:test@localhost/dev",
    REDIS_URL: "redis://localhost:6379",
    REDIS_PREFIX: "fixture",
  };
  if (requireVersion) env.QISHENG_REQUIRE_MEDICAL_PLAN_VERSION = "medical-plan-v1";
  if (verifyRunning) env.QISHENG_VERIFY_RUNNING_MEDICAL_WORKERS = "1";
  const process = { env, exitCode: 0 };
  let report;
  class PrismaClient {
    async $connect() {}
    async $disconnect() {}
    modelProvider = {
      findMany: async () =>
        credentialError ? [{ id: "provider", activeCredential: { id: "credential" } }] : [],
    };
    async $queryRawUnsafe(sql) {
      queried.push(sql);
      if (sql.includes("information_schema"))
        return [
          { table_name: "campaigns", column_name: "selection_snapshot" },
          { table_name: "generation_runs", column_name: "generation_input" },
        ];
      return [
        { exists: sql.includes("FROM campaigns") ? existingPlan && !runOnlyPlan : existingPlan },
      ];
    }
  }
  class Queue {
    constructor(name) {
      this.name = name;
      queueNames.push(name);
    }
    on() {}
    async waitUntilReady() {}
    async isPaused() {
      return false;
    }
    async getWorkersCount() {
      return (await this.getWorkers()).length;
    }
    async getJobCounts() {
      return { waiting: 0, active: 0, delayed: 0, failed: 0 };
    }
    async getWorkers() {
      const clientPrefix = `fixture:${Buffer.from(this.name).toString("base64")}`;
      const clientNames = runningWorkerNames.map(
        (name) => `${clientPrefix}${name ? `:w:${name}` : ""}`,
      );
      const queue = Object.create(BullQueue.prototype);
      queue.name = this.name;
      queue.backend = {
        clientName: () => clientPrefix,
        getClientList: async () => [
          clientNames.map((name, index) => `id=${index + 1} name=${name}`).join("\n"),
        ],
      };
      const clients = await queue.getWorkers();
      if (omitRawname) for (const client of clients) delete client.rawname;
      return clients;
    }
    async close() {}
  }
  const modules = {
    database: { PrismaClient, Prisma: { dmmf: { datamodel: { models: [] } } } },
    bullmq: { Queue },
    "@xhs-agentic/ai-gateway": {
      ModelCredentialCipher: {
        fromEnvironment: () => ({
          decrypt() {
            if (credentialError) throw credentialError;
            return "fixture";
          },
        }),
      },
      modelCredentialAssociatedData: () => "fixture-associated-data",
      MEDICAL_PLAN_EXECUTION_VERSION: supported ? "medical-plan-v1" : undefined,
      MEDICAL_GENERATION_QUEUE: "campaign-generation-medical-v1",
    },
    "@xhs-agentic/object-storage": {
      createObjectStorage: (options) => {
        storageProviders.push(options.provider);
        return { async ensureBucket() {} };
      },
    },
    "@xhs-agentic/content-safety": { createContentSafetyScanner: () => ({}) },
    "/app/dist/platform-settings.js": {
      loadWorkerPlatformSettings: async () => {
        if (settingsError) throw settingsError;
        return {
          storage: { provider: storageProvider },
          contentSafety: { mode: "MODEL", verified: true },
        };
      },
    },
    "/app/dist/production-bootstrap-policy.js": { assertProductionWorkerBootstrapPolicy() {} },
    "/app/dist/generation-worker.js": {},
    "/app/dist/material-ingestion-worker.js": {},
  };
  const require = Object.assign(
    (name) => {
      if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
      return modules[name];
    },
    { resolve: () => "database" },
  );
  await vm.runInNewContext(source, {
    require,
    process,
    URL,
    setTimeout: () => 1,
    clearTimeout() {},
    console: {
      log: (value) => {
        report = JSON.parse(value);
      },
    },
  });
  return { report, exitCode: process.exitCode, queueNames, queried, storageProviders };
}

test("co-located Worker preflight uses the configured local or S3 storage backend", async () => {
  for (const storageProvider of ["LOCAL", "S3"]) {
    const result = await runPreflight({ storageProvider });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.checks.objectStorage, "PASS");
    assert.deepEqual(result.storageProviders, [storageProvider]);
  }
});

test("medical capability queue is checked with the supported Worker and every running generation worker is named", async () => {
  const result = await runPreflight({
    requireVersion: true,
    verifyRunning: true,
    existingPlan: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.checks.medicalPlanCapability, "PASS");
  assert.ok(result.queueNames.includes("campaign-generation-medical-v1"));
});

test("older Worker rollback is refused when frozen plans exist on campaigns or runs", async () => {
  for (const runOnlyPlan of [false, true]) {
    const result = await runPreflight({ supported: false, existingPlan: true, runOnlyPlan });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.checks.medicalPlanCapability, "FAIL");
    assert.equal(result.queueNames.length, 0);
  }
});

test("a historical rollback remains possible before medical plans exist, but a normal release requires support", async () => {
  assert.equal((await runPreflight({ supported: false })).exitCode, 0);
  assert.equal((await runPreflight({ supported: false, requireVersion: true })).exitCode, 1);
});

test("new API activation rejects missing, old, mixed or unidentifiable workers using BullMQ client parsing", async () => {
  for (const options of [
    { runningWorkerNames: [null] },
    { runningWorkerNames: ["legacy:test"] },
    { runningWorkerNames: ["medical-plan-v1:test", null] },
    { runningWorkerNames: [] },
    { omitRawname: true },
  ]) {
    const result = await runPreflight({ verifyRunning: true, ...options });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.checks.redisAndQueues, "FAIL");
  }
});

test("an unavailable audit provider is reported as a platform setting failure with an actionable hint", async () => {
  const result = await runPreflight({
    settingsError: new Error("Content-safety model provider is unavailable"),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.checks.platformSettings, "FAIL");
  assert.equal(result.report.checks.credentialDecryption, undefined);
  assert.match(
    result.report.blockers[0],
    /Adding a provider alone does not change the audit selection/u,
  );
});

test("unknown configuration and credential errors remain separate and never print sensitive details", async () => {
  for (const stage of ["platformSettings", "credentialDecryption"]) {
    const error = new Error("api-key=do-not-print");
    const result = await runPreflight(
      stage === "platformSettings" ? { settingsError: error } : { credentialError: error },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.checks[stage], "FAIL");
    assert.doesNotMatch(JSON.stringify(result.report), /do-not-print/u);
  }
});

test("Linux runtime includes the CJK font packages required by local question cards", () => {
  const dockerfile = readFileSync(new URL("./docker/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /AS runtime\nRUN[^\n]*fontconfig fonts-noto-cjk/u);
});
