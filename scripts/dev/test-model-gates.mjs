import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Tests that temporarily change the global model policy must never use the
// shared development DB or let a running dev Worker consume their fixtures.
const root = fileURLToPath(new URL("../../", import.meta.url));
process.loadEnvFile(`${root}.env`);
const source = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(source.hostname) || !source.pathname.startsWith("/dev_")) {
  throw new Error("This test runner requires local development PostgreSQL");
}
const owner = decodeURIComponent(source.username);
if (!/^[a-z_][a-z0-9_]*$/u.test(owner)) throw new Error("Unsupported development database owner");
const database = `dev_xhs_model_gates_test_${process.pid}`;
const container = process.env.XHS_DEV_POSTGRES_CONTAINER || "dev-postgresql";
const pg = (args) => execFileSync("docker", ["exec", container, ...args], { stdio: "pipe" });
source.pathname = `/${database}`;
const env = { ...process.env, DATABASE_URL: source.toString(), NODE_ENV: "test" };
const run = (args) => {
  const result = spawnSync(`${root}scripts/dev/pnpm.sh`, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Model gate check failed (exit ${result.status})`);
};
let created = false;
try {
  pg(["createdb", "-U", "postgres", "-O", owner, database]);
  created = true;
  run(["exec", "prisma", "migrate", "deploy"]);
  run([
    "exec",
    "prisma",
    "migrate",
    "diff",
    "--exit-code",
    "--from-schema-datasource",
    "prisma/schema.prisma",
    "--to-schema-datamodel",
    "prisma/schema.prisma",
  ]);
  run([
    "exec",
    "vitest",
    "run",
    "packages/ai-gateway/src/route-runtime-health.test.ts",
    "apps/worker/src/route-runtime-health.test.ts",
    "apps/worker/src/generation-execution.spec.ts",
    "apps/worker/src/provider-circuit-breaker.integration.spec.ts",
    "apps/worker/src/generation-runtime.real-provider.integration.test.ts",
    "apps/api/src/model-configuration/model-qualification.service.test.ts",
    "apps/api/src/model-configuration/model-incident-monitor.integration.spec.ts",
    "apps/api/src/model-configuration/generation-status.service.test.ts",
    "apps/api/src/model-configuration/saas-core-sprint-6.integration.spec.ts",
    "apps/api/src/campaign/generation-preflight.service.spec.ts",
    "apps/api/src/platform-operations/production-readiness.service.test.ts",
  ]);
} finally {
  if (created) pg(["dropdb", "-U", "postgres", "--force", database]);
}
