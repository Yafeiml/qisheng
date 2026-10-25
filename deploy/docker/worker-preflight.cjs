// Read-only dependency checks. Exit 2 means infrastructure is ready but content
// safety configuration still prevents production generation consumers from starting.
// Older rollback targets predate the shared Prisma 7 adapter package.
const databaseModule = (() => {
  try {
    return require.resolve("@xhs-agentic/database");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    return require.resolve("@prisma/client");
  }
})();
const { PrismaClient, Prisma } = require(databaseModule);
const { Queue } = require("bullmq");
const {
  ModelCredentialCipher,
  modelCredentialAssociatedData,
  MEDICAL_PLAN_EXECUTION_VERSION,
  MEDICAL_GENERATION_QUEUE,
} = require("@xhs-agentic/ai-gateway");
const { createObjectStorage } = require("@xhs-agentic/object-storage");
const { createContentSafetyScanner } = require("@xhs-agentic/content-safety");
const { loadWorkerPlatformSettings } = require("/app/dist/platform-settings.js");
const {
  assertProductionWorkerBootstrapPolicy,
} = require("/app/dist/production-bootstrap-policy.js");
const prisma = new PrismaClient();
const queues = [];
const report = { checkedAt: new Date().toISOString(), checks: {}, blockers: [] };
let stage = "productionPolicy";
const timeout = setTimeout(() => {
  console.error(JSON.stringify({ stage, result: "TIMEOUT" }));
  process.exit(1);
}, 55000);
async function main() {
  assertProductionWorkerBootstrapPolicy();
  report.checks.productionPolicy = "PASS";
  const redisUrl = new URL(process.env.REDIS_URL);
  stage = "postgresAndSchema";
  await prisma.$connect();
  const columns = await prisma.$queryRawUnsafe(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'",
  );
  const known = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = Prisma.dmmf.datamodel.models.flatMap((model) =>
    model.fields
      .filter(
        (field) =>
          field.kind !== "object" &&
          !known.has(`${model.dbName || model.name}.${field.dbName || field.name}`),
      )
      .map((field) => `${model.dbName || model.name}.${field.dbName || field.name}`),
  );
  if (missing.length) {
    report.missingColumns = missing;
    throw new Error();
  }
  report.checks.postgresAndSchema = "PASS";
  stage = "medicalPlanCapability";
  const supportsMedicalPlan = MEDICAL_PLAN_EXECUTION_VERSION === "medical-plan-v1";
  let hasMedicalPlan = false;
  if (known.has("campaigns.selection_snapshot")) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT EXISTS(SELECT 1 FROM campaigns WHERE selection_snapshot IS NOT NULL) AS "exists"',
    );
    hasMedicalPlan = rows[0]?.exists === true;
  }
  if (!hasMedicalPlan && known.has("generation_runs.generation_input")) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT EXISTS(SELECT 1 FROM generation_runs WHERE generation_input->'medicalPlan' IS NOT NULL AND generation_input->'medicalPlan' IS DISTINCT FROM 'null'::jsonb) AS "exists"`,
    );
    hasMedicalPlan = rows[0]?.exists === true;
  }
  if (
    !supportsMedicalPlan &&
    (hasMedicalPlan || process.env.QISHENG_REQUIRE_MEDICAL_PLAN_VERSION)
  ) {
    report.blockers.push(
      "medical-plan-v1 requires the upgraded Worker; an older reconciler cannot process or safely redispatch these plans",
    );
    throw new Error("UNSUPPORTED_MEDICAL_PLAN");
  }
  report.medicalPlanExecutionVersion = supportsMedicalPlan ? MEDICAL_PLAN_EXECUTION_VERSION : null;
  report.checks.medicalPlanCapability = "PASS";
  stage = "platformSettings";
  const settings = await loadWorkerPlatformSettings(prisma);
  report.checks.platformSettings = "PASS";
  stage = "credentialDecryption";
  const cipher = ModelCredentialCipher.fromEnvironment();
  const providers = await prisma.modelProvider.findMany({
    select: { id: true, activeCredential: true },
  });
  let credentialCount = 0;
  for (const provider of providers) {
    if (!provider.activeCredential) continue;
    const credential = provider.activeCredential;
    if (!cipher.decrypt(credential, modelCredentialAssociatedData(provider.id, credential.id)))
      throw new Error();
    credentialCount++;
  }
  report.checks.credentialDecryption = "PASS";
  report.activeProviderCredentialsVerified = credentialCount;
  stage = "objectStorage";
  await createObjectStorage(settings.storage).ensureBucket(false);
  report.checks.objectStorage = "PASS";
  stage = "redisAndQueues";
  const connection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    username: decodeURIComponent(redisUrl.username),
    password: decodeURIComponent(redisUrl.password),
    db: Number(redisUrl.pathname.slice(1) || 0),
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
  report.queues = {};
  for (const name of [
    "campaign-generation-v1",
    ...(supportsMedicalPlan ? [MEDICAL_GENERATION_QUEUE] : []),
    "material-ingestion-v1",
  ]) {
    const queue = new Queue(name, {
      connection,
      prefix: process.env.REDIS_PREFIX,
      skipMetasUpdate: true,
    });
    queues.push(queue);
    queue.on("error", () => {});
    await queue.waitUntilReady();
    report.queues[name] = {
      paused: await queue.isPaused(),
      workers: await queue.getWorkersCount(),
      counts: await queue.getJobCounts("waiting", "active", "delayed", "failed"),
    };
    if (
      process.env.QISHENG_VERIFY_RUNNING_MEDICAL_WORKERS === "1" &&
      name.startsWith("campaign-generation")
    ) {
      const workers = await queue.getWorkers();
      if (
        !workers.length ||
        workers.some((worker) => !worker.rawname?.includes(":w:medical-plan-v1:"))
      ) {
        report.blockers.push(
          "Generation queues contain an unverified or missing Worker; activate only medical-plan-v1 Workers before the new API",
        );
        throw new Error("RUNNING_WORKER_CAPABILITY_MISMATCH");
      }
    }
  }
  report.checks.redisAndQueues = "PASS";
  stage = "workerModuleLoading";
  require("/app/dist/generation-worker.js");
  require("/app/dist/material-ingestion-worker.js");
  report.checks.workerModuleLoading = "PASS";
  stage = "contentSafety";
  if (settings.contentSafety.mode === "DISABLED" || !settings.contentSafety.verified) {
    report.checks.contentSafety = "BLOCKED";
    report.blockers.push("Production generation requires verified model or HTTP content safety");
    process.exitCode = 2;
  } else {
    createContentSafetyScanner(settings.contentSafety, true);
    report.checks.contentSafety = "VERIFIED";
  }
}
main()
  .catch((error) => {
    report.checks[stage] = "FAIL";
    report.blockers.push(
      error?.message === "Content-safety model provider is unavailable"
        ? "Content-safety provider is unavailable; select an active provider with an active credential in Platform Settings > Content Safety, then save the audit model. Adding a provider alone does not change the audit selection."
        : `Dependency verification failed at ${stage}; sensitive details suppressed`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([...queues.map((queue) => queue.close()), prisma.$disconnect()]);
    clearTimeout(timeout);
    console.log(JSON.stringify(report));
  });
