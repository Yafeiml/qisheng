import { existsSync } from "node:fs";
import { defineConfig, env } from "prisma/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: {
    url: env("DATABASE_URL"),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});
