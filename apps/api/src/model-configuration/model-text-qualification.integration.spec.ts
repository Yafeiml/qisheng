import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Prisma } from "@xhs-agentic/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../database/prisma.service";
import {
  configurationFingerprint,
  ModelQualificationService,
  QUALIFICATION_ROUTE_INCLUDE,
} from "./model-qualification.service";

if (existsSync(".env")) process.loadEnvFile(".env");
afterEach(() => vi.unstubAllEnvs());
describe("TEXT qualification PostgreSQL receipt selection", () => {
  it("ignores a later modern IMAGE connection failure and retains actual TEXT failures", async () => {
    const url = new URL(process.env.DATABASE_URL ?? "invalid");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    expect(url.pathname).toMatch(/^\/dev[_-]/u);
    vi.stubEnv("GENERATION_DELIVERY_MODE", "PRODUCTION");
    const prisma = new PrismaService();
    const marker = `TEXT_RECEIPT_${randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("Fixture rollback only");
    try {
      await expect(
        prisma.$transaction(
          async (tx) => {
            const tenant = await tx.tenant.create({
              data: { name: marker, customerType: "GROUP" },
            });
            const provider = await tx.modelProvider.create({
              data: { code: marker, name: marker, baseUrl: "https://unused.invalid/v1" },
            });
            const credential = await tx.modelProviderCredential.create({
              data: {
                providerId: provider.id,
                ciphertext: new Uint8Array([1]),
                initializationVector: new Uint8Array(12),
                authenticationTag: new Uint8Array(16),
                keyVersion: "fixture",
                lastFour: "test",
                createdBy: marker,
              },
            });
            await tx.modelProvider.update({
              where: { id: provider.id },
              data: { activeCredentialId: credential.id },
            });
            const textModel = await tx.modelDefinition.create({
              data: {
                providerId: provider.id,
                code: "TEXT",
                displayName: "TEXT fixture",
                externalModelId: "text",
                capabilities: ["TEXT"],
              },
            });
            const imageModel = await tx.modelDefinition.create({
              data: {
                providerId: provider.id,
                code: "IMAGE",
                displayName: "Unused IMAGE fixture",
                externalModelId: "image",
                capabilities: ["IMAGE"],
              },
            });
            const route = await tx.modelRoute.create({
              data: {
                tenantId: tenant.id,
                scopeId: tenant.id,
                scopeType: "TENANT",
                textModelId: textModel.id,
                imageModelId: imageModel.id,
                createdBy: marker,
              },
              include: QUALIFICATION_ROUTE_INCLUDE,
            });
            const fullFingerprint = configurationFingerprint(route, [
              route.textModel,
              route.imageModel,
            ]);
            const textFingerprint = configurationFingerprint(route, [route.textModel], false);
            const now = new Date();
            const base = {
              routeId: route.id,
              deliveryMode: "PRODUCTION" as const,
              textProviderId: provider.id,
              imageProviderId: provider.id,
              textModelId: textModel.id,
              imageModelId: imageModel.id,
              checkedBy: marker,
              expiresAt: new Date(now.getTime() + 1000),
            };
            await tx.modelRouteQualification.create({
              data: {
                ...base,
                status: "PASSED",
                configurationFingerprint: fullFingerprint,
                storageVerified: true,
                diagnostics: Prisma.DbNull,
                checkedAt: new Date(now.getTime() - 3000),
              },
            });
            const passed = await tx.modelRouteQualification.create({
              data: {
                ...base,
                status: "PASSED",
                configurationFingerprint: textFingerprint,
                storageVerified: false,
                diagnostics: {
                  textConfigurationFingerprint: textFingerprint,
                  requiredCapabilities: ["TEXT"],
                  steps: { TEXT: "PASSED" },
                },
                checkedAt: new Date(now.getTime() - 2000),
              },
            });
            await tx.modelRouteQualification.create({
              data: {
                ...base,
                status: "FAILED",
                configurationFingerprint: fullFingerprint,
                diagnostics: {
                  textConfigurationFingerprint: textFingerprint,
                  requiredCapabilities: ["TEXT", "IMAGE"],
                  steps: { CONNECTION: "FAILED", TEXT: "NOT_RUN" },
                },
                checkedAt: new Date(now.getTime() - 1000),
              },
            });
            await tx.modelDefinition.update({
              where: { id: imageModel.id },
              data: { status: "DISABLED" },
            });
            const service = new ModelQualificationService(
              tx as never,
              {} as never,
              {} as never,
              {} as never,
              {} as never,
              { ensureFresh: vi.fn() } as never,
            );
            const policy = {} as never;
            const assessment = await service.assessRoute(route.id, policy, now, false);
            expect(assessment.eligible).toBe(true);
            expect(assessment.qualification?.id).toBe(passed.id);
            await tx.modelRouteQualification.create({
              data: {
                ...base,
                status: "FAILED",
                configurationFingerprint: textFingerprint,
                diagnostics: {
                  textConfigurationFingerprint: textFingerprint,
                  requiredCapabilities: ["TEXT"],
                  steps: { TEXT: "FAILED" },
                },
                checkedAt: now,
              },
            });
            expect((await service.assessRoute(route.id, policy, now, false)).eligible).toBe(false);
            throw rollback;
          },
          { timeout: 10000 },
        ),
      ).rejects.toBe(rollback);
      expect(await prisma.tenant.count({ where: { name: marker } })).toBe(0);
      expect(await prisma.modelProvider.count({ where: { code: marker } })).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
