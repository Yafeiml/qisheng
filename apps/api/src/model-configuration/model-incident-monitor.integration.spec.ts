import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@xhs-agentic/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelIncidentMonitor } from "./model-incident-monitor.service";
import { modelIncidentCustomerMessage } from "./model-incident-notification";
import {
  configurationFingerprint,
  QUALIFICATION_ROUTE_INCLUDE,
} from "./model-qualification.service";

describe("durable model incident notification (mock SMTP)", { concurrent: false }, () => {
  const prisma = new PrismaClient();
  const mailer = { sendModelIncident: vi.fn().mockResolvedValue(undefined) };
  const settings = { resolveMany: vi.fn() };
  const monitor = new ModelIncidentMonitor(prisma as never, settings as never, mailer as never);
  let routeId: string;
  let providerId: string;
  let fingerprint: string;
  let qualificationId: string;
  let tenantId: string;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.startsWith("/dev_"))
      throw new Error("Requires local dev DB");
    await prisma.$connect();
  });
  beforeEach(async () => {
    routeId = "";
    providerId = "";
    tenantId = "";
    vi.stubEnv("GENERATION_DELIVERY_MODE", "PRODUCTION");
    mailer.sendModelIncident.mockReset().mockResolvedValue(undefined);
    settings.resolveMany.mockResolvedValue(
      new Map(
        Object.entries({
          model_incident_email: "admin@example.invalid",
          registration_smtp_sender: "sender@example.invalid",
          registration_smtp_password: "mock-password",
        }).map(([key, value]) => [`notification.${key}`, { value }]),
      ),
    );
    const provider = await prisma.modelProvider.create({
      data: {
        code: `INCIDENT_${randomUUID()}`,
        name: "Incident test",
        protocol: "OPENAI_COMPATIBLE",
        baseUrl: "https://provider.invalid/v1",
      },
    });
    providerId = provider.id;
    const model = await prisma.modelDefinition.create({
      data: {
        providerId,
        code: "test",
        externalModelId: "test",
        displayName: "test",
        capabilities: ["TEXT", "IMAGE"],
      },
    });
    const tenant = await prisma.tenant.create({
      data: { name: "Incident test", customerType: "GROUP" },
    });
    tenantId = tenant.id;
    const route = await prisma.modelRoute.create({
      data: {
        scopeType: "TENANT",
        scopeId: tenantId,
        tenantId,
        textModelId: model.id,
        imageModelId: model.id,
        createdBy: "test",
      },
      include: QUALIFICATION_ROUTE_INCLUDE,
    });
    routeId = route.id;
    fingerprint = configurationFingerprint(route, [route.textModel]);
    const q = await prisma.modelRouteQualification.create({
      data: {
        routeId,
        deliveryMode: "PRODUCTION",
        configurationFingerprint: fingerprint,
        status: "PASSED",
        storageVerified: true,
        checkedBy: "test",
        checkedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
        textProviderId: providerId,
        imageProviderId: providerId,
        textModelId: model.id,
        imageModelId: model.id,
      },
    });
    qualificationId = q.id;
  });
  afterEach(async () => {
    if (routeId) {
      await prisma.auditLog.deleteMany({
        where: { resourceId: routeId, resourceType: "ModelRouteRuntime" },
      });
      await prisma.modelRouteQualification.deleteMany({ where: { routeId } });
      await prisma.modelRoute.delete({ where: { id: routeId } });
    }
    if (providerId) {
      await prisma.modelDefinition.deleteMany({ where: { providerId } });
      await prisma.modelProvider.delete({ where: { id: providerId } });
    }
    if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } });
    vi.unstubAllEnvs();
  });
  afterAll(() => prisma.$disconnect());

  async function outcomes(count = 3, mode = "PRODUCTION", configuration = fingerprint) {
    await prisma.auditLog.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        actorType: "SYSTEM" as const,
        action: "model-route.runtime.exhausted",
        resourceType: "ModelRouteRuntime",
        resourceId: routeId,
        createdAt: new Date(Date.now() - 5_000 + index),
        metadata: {
          configurationFingerprint: configuration,
          deliveryMode: mode,
          capability: "IMAGE",
        },
      })),
    });
  }
  const incident = () =>
    prisma.modelRouteIncident.findUniqueOrThrow({
      where: { routeId_deliveryMode: { routeId, deliveryMode: "PRODUCTION" } },
    });

  it("ignores one task, other configurations and development observations", async () => {
    await outcomes(1);
    await outcomes(3, "DEVELOPMENT");
    await outcomes(3, "PRODUCTION", "old-config");
    await monitor.reconcileRoute(routeId);
    expect(await prisma.modelRouteIncident.count({ where: { routeId } })).toBe(0);
    expect(mailer.sendModelIncident).not.toHaveBeenCalled();
  });
  it("opens one incident under concurrent scans, leases one sender, and resolves on recovery", async () => {
    await outcomes();
    await Promise.all([monitor.reconcileRoute(routeId), monitor.reconcileRoute(routeId)]);
    const row = await incident();
    expect(row).toMatchObject({
      revision: 1,
      status: "OPEN",
      notificationStatus: "PENDING",
      imageFailures: 3,
    });
    await Promise.all([monitor.notify(row.id), monitor.notify(row.id)]);
    await monitor.notify(row.id);
    expect(mailer.sendModelIncident).toHaveBeenCalledTimes(1);
    expect(await incident()).toMatchObject({ notificationStatus: "SENT", notificationAttempts: 1 });
    expect(modelIncidentCustomerMessage("SENT")).toContain("已通知平台管理员");
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "model-route.runtime.succeeded",
        resourceType: "ModelRouteRuntime",
        resourceId: routeId,
        metadata: {
          configurationFingerprint: fingerprint,
          deliveryMode: "PRODUCTION",
          capability: "IMAGE",
        },
      },
    });
    await monitor.reconcileRoute(routeId);
    expect(await incident()).toMatchObject({ status: "RESOLVED" });
  });
  it("does not claim notification with missing settings or failed SMTP, bounds retries and supports manual retry", async () => {
    await outcomes();
    await monitor.reconcileRoute(routeId);
    const row = await incident();
    settings.resolveMany.mockResolvedValueOnce(new Map());
    await monitor.notify(row.id);
    expect(await incident()).toMatchObject({
      notificationStatus: "UNCONFIGURED",
      notificationAttempts: 0,
    });
    expect(modelIncidentCustomerMessage("UNCONFIGURED")).not.toContain("已通知");
    await monitor.retryNotification(routeId);
    mailer.sendModelIncident.mockRejectedValue(new Error("SMTP unavailable"));
    for (let i = 0; i < 5; i++) {
      await prisma.modelRouteIncident.update({
        where: { id: row.id },
        data: { nextNotificationAt: new Date(0) },
      });
      await monitor.notify(row.id);
    }
    expect(await incident()).toMatchObject({
      notificationStatus: "EXHAUSTED",
      notificationAttempts: 5,
      notifiedAt: null,
    });
    await monitor.notify(row.id);
    expect(mailer.sendModelIncident).toHaveBeenCalledTimes(5);
    expect(modelIncidentCustomerMessage("FAILED")).not.toContain("已通知");
    expect(await monitor.retryNotification(routeId)).toEqual({ queued: true });
  });
  it("recovers an expired sending lease and clears an incident only after a successful new validation", async () => {
    await outcomes();
    await monitor.reconcileRoute(routeId);
    const row = await incident();
    await prisma.modelRouteIncident.update({
      where: { id: row.id },
      data: {
        notificationStatus: "SENDING",
        notificationLeaseToken: "dead-node",
        notificationLeaseUntil: new Date(0),
      },
    });
    await monitor.notify(row.id);
    expect(mailer.sendModelIncident).toHaveBeenCalledTimes(1);
    await prisma.modelRouteQualification.update({
      where: { id: qualificationId },
      data: { status: "FAILED" },
    });
    await monitor.reconcileRoute(routeId);
    expect((await incident()).status).toBe("OPEN");
    await prisma.modelRouteQualification.update({
      where: { id: qualificationId },
      data: { status: "PASSED", checkedAt: new Date() },
    });
    await monitor.reconcileRoute(routeId);
    expect((await incident()).status).toBe("RESOLVED");
  });
  it("does not send an obsolete incident after configuration changes", async () => {
    await outcomes();
    await monitor.reconcileRoute(routeId);
    const row = await incident();
    await prisma.modelProvider.update({
      where: { id: providerId },
      data: { baseUrl: "https://new.invalid/v1" },
    });
    await monitor.notify(row.id);
    expect((await incident()).status).toBe("RESOLVED");
    expect(mailer.sendModelIncident).not.toHaveBeenCalled();
  });
});
