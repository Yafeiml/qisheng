import "reflect-metadata";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApplication } from "./configure-application";
import { ApiStructuredLogger } from "./http/api-structured-logger";
import { mountOpenApi } from "./openapi/openapi-document";
import { assertProductionBootstrapPolicy } from "./production-bootstrap-policy";

const envPath = resolve(__dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
assertProductionBootstrapPolicy();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new ApiStructuredLogger(),
  });
  const port = Number(process.env.API_PORT ?? 3100);
  const host = process.env.API_HOST ?? "127.0.0.1";

  configureApplication(app);
  mountOpenApi(app);
  app.enableShutdownHooks();

  await app.listen(port, host);
}

void bootstrap();
