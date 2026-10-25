import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type ModelCapability, type Prisma, PrismaClient } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformAccessScope } from "../access/access-scope";
import { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import { ModelConfigurationService } from "./model-configuration.service";
import { ModelCredentialService } from "./model-credential.service";
import { ModelProviderHealthService } from "./model-provider-health.service";
import type { ModelQualificationService } from "./model-qualification.service";
import { ModelSetupService, parseAvailableModels } from "./model-setup.service";
import { RuntimePolicyService } from "./runtime-policy.service";

const prisma = new PrismaClient();
const rollback = new Error("ROLLBACK_TEST_FIXTURE");
const providerFixtureId = randomUUID();
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("dev_")) throw new Error("Requires development database");
  const credentialId = randomUUID();
  const encrypted = new ModelCredentialService().encrypt(
    "test-only-model-key",
    providerFixtureId,
    credentialId,
  );
  await prisma.modelProvider.create({
    data: {
      id: providerFixtureId,
      code: `SETUP_FIXTURE_${providerFixtureId}`,
      name: "Setup rollback fixture",
      baseUrl: "https://models.example.invalid/v1",
      synthetic: false,
    },
  });
  await prisma.modelProviderCredential.create({
    data: {
      ...encrypted,
      authenticationTag: Buffer.from(encrypted.authenticationTag),
      ciphertext: Buffer.from(encrypted.ciphertext),
      initializationVector: Buffer.from(encrypted.initializationVector),
      id: credentialId,
      providerId: providerFixtureId,
      createdBy: "setup-test",
    },
  });
  await prisma.modelProvider.update({
    where: { id: providerFixtureId },
    data: { activeCredentialId: credentialId },
  });
});
afterAll(async () => {
  try {
    await prisma.modelProvider.updateMany({
      where: { id: providerFixtureId },
      data: { activeCredentialId: null },
    });
    await prisma.modelProviderCredential.deleteMany({ where: { providerId: providerFixtureId } });
    await prisma.modelProvider.deleteMany({ where: { id: providerFixtureId } });
  } finally {
    await prisma.$disconnect();
  }
});

function services(database: PrismaService, userId: string) {
  const access = new RequestAccessContext();
  access.initialize({
    audience: "SAAS_ADMIN",
    scope: platformAccessScope(),
    userId,
    permissions: ["platform.model.manage"],
  });
  const credentials = new ModelCredentialService();
  const configuration = new ModelConfigurationService(
    database,
    access,
    credentials,
    {} as ModelQualificationService,
    new ModelProviderHealthService(database, credentials),
  );
  const policy = new RuntimePolicyService(database, access);
  return {
    setup: new ModelSetupService(database, access, credentials, configuration, policy),
    credentials,
  };
}
async function isolated(
  run: (
    tx: Prisma.TransactionClient,
    setup: ModelSetupService,
    providerId: string,
  ) => Promise<void>,
  baseUrl = "https://models.example/v1",
) {
  if (!process.env.DATABASE_URL?.includes("dev_")) throw new Error("Requires development database");
  try {
    await prisma.$transaction(
      async (tx) => {
        const admin = await tx.adminUser.create({
          data: { phone: `setup-${randomUUID().slice(0, 16)}` },
        });
        const database = new Proxy(tx, {
          get(target, key) {
            if (key === "$transaction")
              return (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
                operation(tx);
            return Reflect.get(target, key);
          },
        }) as unknown as PrismaService;
        const { setup, credentials } = services(database, admin.id);
        const id = randomUUID();
        const credentialId = randomUUID();
        const encrypted = credentials.encrypt("test-only-model-key", id, credentialId);
        await tx.modelProvider.create({
          data: { id, code: `TEST_${id}`, name: "Setup test provider", baseUrl },
        });
        await tx.modelProviderCredential.create({
          data: {
            ...encrypted,
            id: credentialId,
            providerId: id,
            createdBy: admin.id,
            authenticationTag: Buffer.from(encrypted.authenticationTag),
            ciphertext: Buffer.from(encrypted.ciphertext),
            initializationVector: Buffer.from(encrypted.initializationVector),
          },
        });
        await tx.modelProvider.update({
          where: { id },
          data: { activeCredentialId: credentialId },
        });
        const createModel = (externalModelId: string, capabilities: ModelCapability[]) =>
          tx.modelDefinition.create({
            data: {
              providerId: id,
              code: externalModelId.toUpperCase(),
              displayName: externalModelId,
              externalModelId,
              capabilities,
            },
          });
        const [text, image, backup] = await Promise.all([
          createModel("prior-text", ["TEXT"]),
          createModel("prior-image", ["IMAGE"]),
          createModel("backup-text", ["TEXT"]),
        ]);
        await tx.modelRoute.upsert({
          where: { scopeType_scopeId: { scopeType: "PLATFORM", scopeId: "platform" } },
          create: {
            scopeType: "PLATFORM",
            scopeId: "platform",
            textModelId: text.id,
            imageModelId: image.id,
            createdBy: admin.id,
            maxAttemptsPerModel: 3,
            textFallbackModelIds: [backup.id],
          },
          update: {
            textModelId: text.id,
            imageModelId: image.id,
            maxAttemptsPerModel: 3,
            textFallbackModelIds: [backup.id],
            imageFallbackModelIds: [],
          },
        });
        await run(tx, setup, id);
        throw rollback;
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe("one-page model setup", () => {
  it("imports four selections together, preserves unrelated policy and route defaults, and avoids duplicate models", async () => {
    const outsideBefore = await prisma.runtimePolicy.findUnique({ where: { id: "platform" } });
    await isolated(async (tx, setup, providerId) => {
      const before = await tx.runtimePolicy.findUniqueOrThrow({ where: { id: "platform" } });
      const customRoutes = await tx.modelRoute.findMany({
        where: { scopeType: { not: "PLATFORM" } },
      });
      const selection = (externalModelId: string) => ({ providerId, externalModelId });
      const input = {
        textModel: selection("writer"),
        imageModel: selection("painter"),
        embeddingModel: selection("BAAI/bge-m3"),
        materialAnalysisModel: selection("vision-reader"),
      };
      const result = await setup.save(input);
      expect(result.route.textModel.externalModelId).toBe("writer");
      expect(result.route.imageModel.externalModelId).toBe("painter");
      expect(result.route.maxAttemptsPerModel).toBe(3);
      expect(result.route.textFallbackModelIds).toHaveLength(1);
      expect(result.runtimePolicy.retrievalTopK).toBe(before.retrievalTopK);
      expect(result.runtimePolicy.materialChunkSizeCharacters).toBe(
        before.materialChunkSizeCharacters,
      );
      const embedding = await tx.modelDefinition.findUniqueOrThrow({
        where: { id: result.runtimePolicy.embeddingModelId ?? "" },
      });
      const vision = await tx.modelDefinition.findUniqueOrThrow({
        where: { id: result.runtimePolicy.materialAnalysisModelId ?? "" },
      });
      expect(embedding.capabilities).toEqual(["EMBEDDING"]);
      expect(vision.capabilities).toEqual(["TEXT", "VISION"]);
      expect(await tx.modelRoute.findMany({ where: { scopeType: { not: "PLATFORM" } } })).toEqual(
        customRoutes,
      );
      const count = await tx.modelDefinition.count({ where: { providerId } });
      await setup.save(input);
      expect(await tx.modelDefinition.count({ where: { providerId } })).toBe(count);
      const follow = await setup.save({ ...input, materialAnalysisModel: null });
      expect(follow.runtimePolicy.materialAnalysisModelId).toBeNull();
      expect(follow.route.textModel.capabilities).toContain("VISION");
    });
    expect(await prisma.runtimePolicy.findUnique({ where: { id: "platform" } })).toEqual(
      outsideBefore,
    );
  });

  it("rolls back new models and the generation route when later policy validation fails", async () => {
    const admin = await prisma.adminUser.findFirstOrThrow();
    const real = await prisma.modelProvider.findFirstOrThrow({
      where: { id: providerFixtureId },
    });
    const synthetic = await prisma.modelProvider.findFirstOrThrow({
      where: { status: "ACTIVE", synthetic: true },
    });
    const beforeRoute = await prisma.modelRoute.findUnique({
      where: { scopeType_scopeId: { scopeType: "PLATFORM", scopeId: "platform" } },
    });
    const beforePolicy = await prisma.runtimePolicy.findUnique({ where: { id: "platform" } });
    const marker = `rollback-${randomUUID()}`;
    const { setup } = services(prisma as unknown as PrismaService, admin.id);
    await expect(
      setup.save({
        textModel: { providerId: real.id, externalModelId: `${marker}-text` },
        imageModel: { providerId: real.id, externalModelId: `${marker}-image` },
        materialAnalysisModel: { providerId: synthetic.id, externalModelId: `${marker}-vision` },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.modelDefinition.count({ where: { externalModelId: { startsWith: marker } } }),
    ).toBe(0);
    expect(
      await prisma.modelRoute.findUnique({
        where: { scopeType_scopeId: { scopeType: "PLATFORM", scopeId: "platform" } },
      }),
    ).toEqual(beforeRoute);
    expect(await prisma.runtimePolicy.findUnique({ where: { id: "platform" } })).toEqual(
      beforePolicy,
    );
  });

  it("reads paginated supplier lists with the stored credential and exposes no secrets", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      if (request.headers.authorization !== "Bearer test-only-model-key") {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.includes("after=")
            ? { data: [{ id: "BAAI/bge-m3" }], has_more: false }
            : { data: [{ id: "writer" }], has_more: true, last_id: "writer" },
        ),
      );
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      await isolated(async (_tx, setup, providerId) => {
        const result = await setup.availableModels(providerId);
        expect(result.models.map((model) => model.externalModelId).sort()).toEqual([
          "BAAI/bge-m3",
          "writer",
        ]);
        expect(JSON.stringify(result)).not.toContain("test-only-model-key");
      }, `http://127.0.0.1:${address.port}/v1`);
      expect(paths).toEqual(["/v1/models", "/v1/models?after=writer"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("updates the provider URL and credential together without exposing the new key", async () => {
    await isolated(async (tx, setup, providerId) => {
      const before = await tx.modelProvider.findUniqueOrThrow({ where: { id: providerId } });
      const response = await setup.saveConnection(providerId, {
        baseUrl: "https://updated.example/v1",
        apiKey: "new-test-only-model-key",
        reason: "测试连接更新",
        emergency: false,
      });
      const updated = await tx.modelProvider.findUniqueOrThrow({
        where: { id: providerId },
        include: { activeCredential: true },
      });
      expect(updated.baseUrl).toBe("https://updated.example/v1");
      expect(updated.activeCredentialId).not.toBe(before.activeCredentialId);
      expect(
        updated.activeCredential && new ModelCredentialService().decrypt(updated.activeCredential),
      ).toBe("new-test-only-model-key");
      expect(
        (
          await tx.modelProviderCredential.findUniqueOrThrow({
            where: { id: before.activeCredentialId ?? "" },
          })
        ).status,
      ).toBe("REVOKED");
      expect(JSON.stringify(response)).not.toContain("new-test-only-model-key");
    });
  });

  it("rolls back provider settings when credential rotation fails", async () => {
    const admin = await prisma.adminUser.findFirstOrThrow();
    const provider = await prisma.modelProvider.findFirstOrThrow({
      where: { id: providerFixtureId },
    });
    const { setup } = services(prisma as unknown as PrismaService, admin.id);
    await expect(
      setup.saveConnection(provider.id, {
        baseUrl: "https://rollback.example/v1",
        apiKey: "    ",
        reason: "验证原子回滚",
        emergency: false,
      }),
    ).rejects.toThrow();
    expect(await prisma.modelProvider.findUnique({ where: { id: provider.id } })).toEqual(provider);
  });

  it("rejects malformed lists and keeps unfamiliar model IDs available", () => {
    expect(() => parseAvailableModels({ message: "bad response" })).toThrow();
    const result = parseAvailableModels({
      data: [
        { id: "BAAI/bge-m3" },
        { id: "gpt-image-1" },
        { id: "private-unknown-alias" },
        { id: "" },
        { id: 123 },
      ],
    });
    expect(result.models).toHaveLength(3);
    expect(result.models[0]?.suggestedCapabilities).toEqual(["EMBEDDING"]);
    expect(result.models[1]?.suggestedCapabilities).toEqual(["IMAGE"]);
    expect(result.models[2]?.suggestedCapabilities).toEqual([]);
  });
});

function listen(server: Server) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}
