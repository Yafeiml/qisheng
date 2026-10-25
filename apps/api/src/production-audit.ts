import "reflect-metadata";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ProductionReadinessService } from "./platform-operations/production-readiness.service";

const projectRoot = resolve(__dirname, "../../..");
const envPath = resolve(projectRoot, ".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) process.loadEnvFile(envPath);
process.env.PRODUCTION_AUDIT_CLI = "true";

async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const readiness = await app.resolve(ProductionReadinessService);
    const audit = await readiness.audit();
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${[
          `Production readiness: ${audit.state} (${audit.summary.ready}/${audit.summary.total - audit.summary.warning} required checks ready, ${audit.summary.warning} advisories)`,
          ...audit.checks.map((check) => `[${check.status}] ${check.title}: ${check.message}`),
        ].join("\n")}\n`,
      );
    }
    if (audit.state !== "READY") process.exitCode = 2;
  } finally {
    await app.close();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Production readiness audit failed"}\n`,
  );
  process.exitCode = 1;
});
