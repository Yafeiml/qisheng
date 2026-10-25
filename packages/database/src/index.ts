import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as GeneratedPrismaClient } from "@prisma/client";
import { postgresConnectionStringWithUtcSession } from "@xhs-agentic/observability";

export * from "@prisma/client";

/** Shared Prisma 7 transport for API, workers, tests and operational scripts. */
export class PrismaClient extends GeneratedPrismaClient {
  constructor(options: { datasourceUrl?: string } = {}) {
    const databaseUrl = options.datasourceUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");
    const url = new URL(postgresConnectionStringWithUtcSession(databaseUrl));
    const schema = url.searchParams.get("schema") ?? "public";
    const max = Number(url.searchParams.get("connection_limit") ?? 10);
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("Invalid database connection_limit");
    super({
      adapter: new PrismaPg(
        { connectionString: url.toString(), max, connectionTimeoutMillis: 10_000 },
        { schema },
      ),
    });
  }
}
