import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { modelIncidentCustomerMessage } from "./model-incident-notification";
import { ModelQualificationService } from "./model-qualification.service";

@Injectable()
export class GenerationStatusService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
    @Inject(ModelQualificationService) private readonly qualifications: ModelQualificationService,
  ) {}

  async current(tenantId: string, enterpriseId?: string) {
    const { scope } = this.access.requireSaasAdmin();
    if (
      scope.type === "PLATFORM" ||
      scope.tenantId !== tenantId ||
      (scope.type === "ENTERPRISE" && scope.enterpriseId !== enterpriseId)
    ) {
      throw new ForbiddenException("Generation status is limited to the selected organization");
    }
    const [enterprises, routes] = await Promise.all([
      this.prisma.enterprise.findMany({
        where: { tenantId, status: "ACTIVE", ...(enterpriseId ? { id: enterpriseId } : {}) },
        select: { id: true },
      }),
      this.prisma.modelRoute.findMany({
        where: {
          OR: [
            { scopeType: "PLATFORM", scopeId: "platform", tenantId: null, enterpriseId: null },
            { scopeType: "TENANT", scopeId: tenantId, tenantId, enterpriseId: null },
            {
              scopeType: "ENTERPRISE",
              tenantId,
              ...(enterpriseId ? { enterpriseId, scopeId: enterpriseId } : {}),
            },
          ],
        },
        select: { id: true, scopeType: true, scopeId: true, enterpriseId: true },
      }),
    ]);
    const counts = new Map<string, number>();
    const enterpriseRoutes = new Map(
      routes
        .filter((r) => r.scopeType === "ENTERPRISE" && r.scopeId === r.enterpriseId)
        .map((r) => [r.enterpriseId, r]),
    );
    const inherited =
      routes.find((r) => r.scopeType === "TENANT") ??
      routes.find((r) => r.scopeType === "PLATFORM");
    for (const enterprise of enterprises) {
      const route = enterpriseRoutes.get(enterprise.id) ?? inherited;
      if (route) counts.set(route.id, (counts.get(route.id) ?? 0) + 1);
    }
    // Shared routes are assessed once; provider details never enter the customer response.
    const health = await this.qualifications.runtimeHealthForRoutes([...counts.keys()]);
    const notifications = new Map<string, number>();
    for (const [id, count] of counts) {
      const state = health.get(id);
      if (state?.state !== "REVALIDATION_REQUIRED" && !state?.notificationStatus) continue;
      const status = state.notificationStatus ?? "PENDING";
      notifications.set(status, (notifications.get(status) ?? 0) + count);
    }
    return {
      checkedAt: new Date().toISOString(),
      affectedEnterpriseCount: [...notifications.values()].reduce((sum, count) => sum + count, 0),
      notices: [...notifications].map(([notificationStatus, affectedEnterpriseCount]) => ({
        notificationStatus,
        affectedEnterpriseCount,
        message: modelIncidentCustomerMessage(notificationStatus),
      })),
    };
  }
}
