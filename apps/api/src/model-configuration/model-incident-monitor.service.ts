import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { generationDeliveryMode } from "@xhs-agentic/ai-gateway";
import { Prisma } from "@xhs-agentic/database";
import { writeStructuredLog } from "@xhs-agentic/observability";
import { PrismaService } from "../database/prisma.service";
import { type MailConfiguration, NotificationMailer } from "../notifications/notification-mailer";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import {
  configurationFingerprint,
  QUALIFICATION_ROUTE_INCLUDE,
} from "./model-qualification.service";
import { readRouteRuntimeHealth } from "./route-runtime-health";

@Injectable()
export class ModelIncidentMonitor implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(NotificationMailer) private readonly mailer: NotificationMailer,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      let cursor: string | undefined;
      do {
        const routes = await this.prisma.modelRoute.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
          take: 50,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const route of routes) {
          try {
            await this.reconcileRoute(route.id);
          } catch {
            writeStructuredLog({
              event: "model-incident.reconcile.failed",
              fields: { routeId: route.id },
              level: "error",
              service: "api",
            });
          }
        }
        cursor = routes.length === 50 ? routes.at(-1)?.id : undefined;
      } while (cursor);
      // Development/test observations must never send real operational mail.
      if (generationDeliveryMode() === "PRODUCTION") {
        const due = await this.prisma.modelRouteIncident.findMany({
          where: {
            deliveryMode: "PRODUCTION",
            status: "OPEN",
            notificationStatus: { notIn: ["SENT", "EXHAUSTED"] },
            nextNotificationAt: { lte: new Date() },
          },
          orderBy: { nextNotificationAt: "asc" },
          take: 10,
        });
        for (const incident of due) await this.notify(incident.id);
      }
    } catch {
      writeStructuredLog({
        event: "model-incident.monitor.failed",
        fields: {},
        level: "error",
        service: "api",
      });
    } finally {
      this.running = false;
    }
  }

  async reconcileRoute(routeId: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.reconcile(tx, routeId), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15_000,
        });
      } catch (error) {
        if (
          attempt >= 2 ||
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2034"
        )
          throw error;
      }
    }
  }

  private async reconcile(tx: Prisma.TransactionClient, routeId: string) {
    const deliveryMode = generationDeliveryMode();
    const route = await tx.modelRoute.findUnique({
      where: { id: routeId },
      include: QUALIFICATION_ROUTE_INCLUDE,
    });
    if (!route) return;
    const fallbackIds = [
      ...new Set([...route.textFallbackModelIds, ...route.imageFallbackModelIds]),
    ];
    const fallbacks = await tx.modelDefinition.findMany({
      where: { id: { in: fallbackIds } },
      include: { provider: { include: { activeCredential: true } } },
    });
    const models = [
      ...new Map(
        [route.textModel, route.imageModel, ...fallbacks].map((model) => [model.id, model]),
      ).values(),
    ];
    if (
      fallbacks.length !== fallbackIds.length ||
      models.some((model) => model.synthetic || model.provider.synthetic)
    ) {
      await tx.modelRouteIncident.updateMany({
        where: { routeId, deliveryMode, status: "OPEN" },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          notificationLeaseToken: null,
          notificationLeaseUntil: null,
        },
      });
      return;
    }
    const fingerprint = configurationFingerprint(route, models);
    const qualification = await tx.modelRouteQualification.findFirst({
      where: {
        routeId,
        configurationFingerprint: fingerprint,
        deliveryMode: generationDeliveryMode(),
      },
      orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
    });
    await tx.modelRouteIncident.updateMany({
      where: {
        routeId,
        deliveryMode,
        status: "OPEN",
        configurationFingerprint: { not: fingerprint },
      },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        notificationLeaseToken: null,
        notificationLeaseUntil: null,
      },
    });
    // A failed manual validation does not silently resolve an existing incident.
    if (qualification?.status !== "PASSED" || !qualification.storageVerified) return;
    const health = await readRouteRuntimeHealth(tx, {
      routeId,
      configurationFingerprint: fingerprint,
      deliveryMode: qualification.deliveryMode,
      qualifiedAt: qualification.checkedAt,
    });
    if (health.state !== "REVALIDATION_REQUIRED") {
      await tx.modelRouteIncident.updateMany({
        where: { routeId, deliveryMode, status: "OPEN" },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          notificationLeaseToken: null,
          notificationLeaseUntil: null,
        },
      });
      return;
    }
    const current = await tx.modelRouteIncident.upsert({
      where: { routeId_deliveryMode: { routeId, deliveryMode } },
      update: {},
      create: {
        routeId,
        deliveryMode,
        configurationFingerprint: fingerprint,
        qualificationId: qualification.id,
        textFailures: health.textFailures,
        imageFailures: health.imageFailures,
      },
    });
    if (
      current.status === "RESOLVED" ||
      current.qualificationId !== qualification.id ||
      current.configurationFingerprint !== fingerprint
    ) {
      await tx.modelRouteIncident.updateMany({
        where: { id: current.id, revision: current.revision, updatedAt: current.updatedAt },
        data: {
          status: "OPEN",
          revision: { increment: 1 },
          configurationFingerprint: fingerprint,
          qualificationId: qualification.id,
          textFailures: health.textFailures,
          imageFailures: health.imageFailures,
          notificationStatus: "PENDING",
          notificationAttempts: 0,
          nextNotificationAt: new Date(),
          notificationLeaseToken: null,
          notificationLeaseUntil: null,
          notificationError: null,
          notifiedAt: null,
          openedAt: new Date(),
          resolvedAt: null,
        },
      });
    }
  }

  async retryNotification(routeId: string) {
    await this.reconcileRoute(routeId);
    const reset = await this.prisma.modelRouteIncident.updateMany({
      where: {
        routeId,
        deliveryMode: generationDeliveryMode(),
        status: "OPEN",
        notificationStatus: { in: ["FAILED", "EXHAUSTED", "UNCONFIGURED"] },
      },
      data: {
        notificationStatus: "PENDING",
        notificationAttempts: 0,
        nextNotificationAt: new Date(),
        notificationLeaseToken: null,
        notificationLeaseUntil: null,
      },
    });
    return { queued: reset.count > 0 };
  }

  async notify(id: string) {
    if (generationDeliveryMode() !== "PRODUCTION") return;
    const candidate = await this.prisma.modelRouteIncident.findUnique({ where: { id } });
    if (candidate?.deliveryMode !== "PRODUCTION") return;
    await this.reconcileRoute(candidate.routeId);
    const row = await this.prisma.modelRouteIncident.findUnique({
      where: { id },
      include: { route: true },
    });
    if (row?.status !== "OPEN" || ["SENT", "EXHAUSTED"].includes(row.notificationStatus)) return;
    const now = new Date();
    const token = randomUUID();
    const claimed = await this.prisma.modelRouteIncident.updateMany({
      where: {
        id,
        revision: row.revision,
        status: "OPEN",
        notificationStatus: { notIn: ["SENT", "EXHAUSTED"] },
        nextNotificationAt: { lte: now },
        OR: [{ notificationLeaseUntil: null }, { notificationLeaseUntil: { lte: now } }],
      },
      data: {
        notificationStatus: "SENDING",
        notificationLeaseToken: token,
        notificationLeaseUntil: new Date(now.getTime() + 120_000),
      },
    });
    if (claimed.count !== 1) return;
    const where = { id, revision: row.revision, status: "OPEN", notificationLeaseToken: token };
    try {
      const configuration = await this.mailConfiguration();
      if (!configuration) {
        await this.prisma.modelRouteIncident.updateMany({
          where,
          data: {
            notificationStatus: "UNCONFIGURED",
            notificationError: "未配置模型故障接收邮箱或 SMTP 发件配置",
            nextNotificationAt: new Date(Date.now() + 300_000),
            notificationLeaseToken: null,
            notificationLeaseUntil: null,
          },
        });
        return;
      }
      if (!(await this.prisma.modelRouteIncident.count({ where }))) return;
      await this.mailer.sendModelIncident(configuration, {
        id,
        revision: row.revision,
        textFailures: row.textFailures,
        imageFailures: row.imageFailures,
        routeLabel:
          row.route.scopeType === "PLATFORM"
            ? "平台默认路由"
            : `${row.route.scopeType} 路由 ${row.route.scopeId}`,
      });
      await this.prisma.modelRouteIncident.updateMany({
        where,
        data: {
          notificationStatus: "SENT",
          notifiedAt: new Date(),
          notificationError: null,
          notificationAttempts: { increment: 1 },
          notificationLeaseToken: null,
          notificationLeaseUntil: null,
        },
      });
    } catch {
      const attempts = row.notificationAttempts + 1;
      await this.prisma.modelRouteIncident.updateMany({
        where,
        data: {
          notificationStatus: attempts >= 5 ? "EXHAUSTED" : "FAILED",
          notificationAttempts: attempts,
          notificationError: "邮件发送未确认，请检查 SMTP 配置与邮件服务",
          nextNotificationAt: new Date(Date.now() + Math.min(60_000 * 2 ** attempts, 1_800_000)),
          notificationLeaseToken: null,
          notificationLeaseUntil: null,
        },
      });
    }
  }

  private async mailConfiguration(): Promise<MailConfiguration | null> {
    const keys = [
      "model_incident_email",
      "registration_application_email",
      "registration_smtp_host",
      "registration_smtp_port",
      "registration_smtp_username",
      "registration_smtp_password",
      "registration_smtp_sender",
      "registration_smtp_from_name",
    ];
    const values = await this.settings.resolveMany(keys.map((key) => `notification.${key}`));
    const value = (key: string) => values.get(`notification.${key}`)?.value;
    const recipient = String(
      value("model_incident_email") || value("registration_application_email") || "",
    );
    const sender = String(value("registration_smtp_sender") || "");
    const password = String(value("registration_smtp_password") || "");
    if (!recipient || !sender || !password) return null;
    return {
      recipient,
      sender,
      password,
      host: String(value("registration_smtp_host") || "smtpdm.aliyun.com"),
      port: Number(value("registration_smtp_port") || 465),
      username: String(value("registration_smtp_username") || sender),
      fromName: String(value("registration_smtp_from_name") || "平台通知"),
    };
  }
}
