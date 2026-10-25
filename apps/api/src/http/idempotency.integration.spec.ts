import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  type INestApplication,
  Inject,
  Injectable,
  Module,
  Post,
  Scope,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { GlobalUser } from "@xhs-agentic/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccessModule } from "../access/access.module";
import { platformAccessScope } from "../access/access-scope";
import { RequestAccessContext } from "../access/request-access-context";
import { configureApplication } from "../configure-application";
import { PrismaModule } from "../database/prisma.module";
import { PrismaService } from "../database/prisma.service";
import { HttpInfrastructureModule } from "./http-infrastructure.module";
import { Idempotent } from "./idempotent.decorator";

type TestInput = Readonly<{ delayMs?: number; value: string }>;

@Injectable({ scope: Scope.REQUEST })
class TestPrincipalGuard implements CanActivate {
  static users: readonly string[] = [];

  constructor(@Inject(RequestAccessContext) private readonly access: RequestAccessContext) {}

  canActivate(context: ExecutionContext): boolean {
    const supplied = context.switchToHttp().getRequest().headers["x-test-user"];
    const userId = typeof supplied === "string" ? supplied : TestPrincipalGuard.users[0];
    if (!userId || !TestPrincipalGuard.users.includes(userId)) return false;
    this.access.initialize({
      audience: "SAAS_ADMIN",
      permissions: [],
      scope: platformAccessScope(),
      userId,
    });
    return true;
  }
}

@Controller("__tests/idempotency")
@UseGuards(TestPrincipalGuard)
class IdempotencyTestController {
  static executionCount = 0;

  @Post()
  @Idempotent()
  async execute(@Body() input: TestInput) {
    IdempotencyTestController.executionCount += 1;
    if (input.delayMs) await delay(input.delayMs);
    return { execution: IdempotencyTestController.executionCount, value: input.value };
  }
}

@Module({
  controllers: [IdempotencyTestController],
  imports: [PrismaModule, AccessModule, HttpInfrastructureModule],
  providers: [TestPrincipalGuard],
})
class IdempotencyTestModule {}

describe("persistent HTTP idempotency", { concurrent: false }, () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let users: GlobalUser[] = [];

  beforeAll(async () => {
    app = await NestFactory.create(IdempotencyTestModule, {
      bodyParser: false,
      logger: ["error"],
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
    users = await Promise.all(
      [0, 1].map((index) =>
        prisma.globalUser.create({
          data: { phone: `135${Date.now().toString().slice(-7)}${index}` },
        }),
      ),
    );
    TestPrincipalGuard.users = users.map(({ id }) => id);
  });

  beforeEach(() => {
    IdempotencyTestController.executionCount = 0;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.globalUser.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
    }
    await app?.close();
  });

  it("requires a valid idempotency key before executing the handler", async () => {
    const response = await call({ key: null, value: "missing" });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(IdempotencyTestController.executionCount).toBe(0);
  });

  it("rejects a concurrent duplicate, then replays the persisted successful response", async () => {
    const key = randomUUID();
    const firstRequest = call({ delayMs: 180, key, value: "once" });
    await waitForRecord(key);

    const concurrent = await call({ delayMs: 180, key, value: "once" });
    expect(concurrent.status).toBe(409);
    expect(concurrent.body).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });

    const first = await firstRequest;
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotency-replayed")).toBe("false");
    expect(first.body).toEqual({ execution: 1, value: "once" });

    const replay = await call({ delayMs: 180, key, value: "once" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(IdempotencyTestController.executionCount).toBe(1);
  });

  it("rejects reuse for another payload and scopes identical keys by user", async () => {
    const key = randomUUID();
    const first = await call({ key, userId: users[0]?.id, value: "first" });
    expect(first.status).toBe(201);

    const conflict = await call({ key, userId: users[0]?.id, value: "changed" });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const otherUser = await call({ key, userId: users[1]?.id, value: "changed" });
    expect(otherUser.status).toBe(201);
    expect(IdempotencyTestController.executionCount).toBe(2);
  });

  async function waitForRecord(key: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await prisma.idempotencyRecord.findFirst({ where: { key } })) return;
      await delay(10);
    }
    throw new Error("Timed out waiting for the in-progress idempotency record");
  }

  async function call(
    input: Readonly<{
      delayMs?: number;
      key: string | null;
      userId?: string;
      value: string;
    }>,
  ): Promise<Readonly<{ body: unknown; headers: Headers; status: number }>> {
    const headers = new Headers({ "content-type": "application/json" });
    if (input.key) headers.set("idempotency-key", input.key);
    if (input.userId) headers.set("x-test-user", input.userId);
    const response = await fetch(`${baseUrl}/__tests/idempotency`, {
      body: JSON.stringify({ delayMs: input.delayMs, value: input.value }),
      headers,
      method: "POST",
    });
    return {
      body: await response.json(),
      headers: response.headers,
      status: response.status,
    };
  }
});
