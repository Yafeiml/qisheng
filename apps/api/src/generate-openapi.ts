import "reflect-metadata";

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApplication } from "./configure-application";
import { createOpenApiDocument } from "./openapi/openapi-document";

const projectRoot = resolve(__dirname, "../../..");
const envPath = resolve(projectRoot, ".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) process.loadEnvFile(envPath);

const outputArgument = process.argv.slice(2).find((argument) => argument !== "--");
const outputPath = resolve(
  projectRoot,
  outputArgument ?? "packages/contracts/openapi/openapi.json",
);

async function run(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    abortOnError: false,
    bodyParser: false,
    logger: false,
  });
  try {
    configureApplication(app);
    const document = createOpenApiDocument(app);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    process.stdout.write(`OpenAPI contract written to ${outputPath}\n`);
  } finally {
    await app.close();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
