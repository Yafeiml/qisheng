import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";

@Injectable()
export class GroupOverviewService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(TenantCapabilityService)
    private readonly tenantCapabilities: TenantCapabilityService,
  ) {}

  async overview(tenantId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "TENANT" || principal.scope.tenantId !== tenantId) {
      throw new ForbiddenException("Only an authorized tenant scope can read the group overview");
    }
    const now = new Date();
    const expiringBefore = new Date(now.getTime() + 30 * 86_400_000);
    const [tenant, capability, enterprises] = await Promise.all([
      this.prisma.tenant.findFirst({ where: { id: tenantId, status: "ACTIVE" } }),
      this.tenantCapabilities.current(tenantId),
      this.prisma.enterprise.findMany({
        orderBy: [{ status: "asc" }, { name: "asc" }],
        where: { tenantId },
      }),
    ]);
    if (!tenant) throw new NotFoundException("Active tenant was not found");
    const enterpriseIds = enterprises.map(({ id }) => id);
    const includeShared = capability.groupSharedMaterialsEnabled;
    const [memberships, campaigns, workItems, materials, sensitiveRules, sharedUsage, expiring] =
      await Promise.all([
        this.prisma.enterpriseMembership.groupBy({
          _count: { _all: true },
          by: ["enterpriseId", "seatStatus", "status"],
          where: { enterpriseId: { in: enterpriseIds }, tenantId },
        }),
        this.prisma.campaign.groupBy({
          _count: { _all: true },
          by: ["enterpriseId", "status"],
          where: { archivedAt: null, enterpriseId: { in: enterpriseIds }, tenantId },
        }),
        this.prisma.generationWorkItem.groupBy({
          _count: { _all: true },
          by: ["enterpriseId", "status"],
          where: { enterpriseId: { in: enterpriseIds }, tenantId },
        }),
        this.prisma.material.groupBy({
          _count: { _all: true },
          by: ["enterpriseId"],
          where: {
            AND: [
              { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
              { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            ],
            authorizationStatus: "AUTHORIZED",
            ingestionStatus: "READY",
            usabilityStatus: "USABLE",
            OR: [{ enterpriseId: null }, { enterpriseId: { in: enterpriseIds } }],
            status: "ACTIVE",
            tenantId,
          },
        }),
        this.prisma.sensitiveRule.groupBy({
          _count: { _all: true },
          by: ["enterpriseId"],
          where: {
            AND: [
              { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
              { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
            ],
            OR: [{ enterpriseId: null }, { enterpriseId: { in: enterpriseIds } }],
            status: "ACTIVE",
            tenantId,
          },
        }),
        this.prisma.campaignRetrievalEvidence.groupBy({
          _count: { _all: true },
          _max: { createdAt: true },
          by: ["enterpriseId", "materialId", "materialTitle", "materialVersion"],
          where: { materialScopeKey: "__tenant__", tenantId },
        }),
        this.prisma.material.findMany({
          orderBy: { expiresAt: "asc" },
          select: { expiresAt: true, id: true, title: true, version: true },
          take: 50,
          where: {
            authorizationStatus: "AUTHORIZED",
            enterpriseId: null,
            expiresAt: { gt: now, lte: expiringBefore },
            ingestionStatus: "READY",
            usabilityStatus: "USABLE",
            status: "ACTIVE",
            tenantId,
          },
        }),
      ]);
    const sharedMaterialCount = groupedNullableCount(materials, null);
    const sharedSensitiveRuleCount = groupedNullableCount(sensitiveRules, null);
    const enterpriseRows = enterprises.map((enterprise) => {
      const membershipRows = memberships.filter((row) => row.enterpriseId === enterprise.id);
      const campaignCounts = groupedStatusCounts(campaigns, enterprise.id);
      const generationCounts = groupedStatusCounts(workItems, enterprise.id);
      const enabledSeats = membershipRows
        .filter(({ status }) => status === "ACTIVE" || status === "PENDING_BIND")
        .reduce((sum, row) => sum + row._count._all, 0);
      const privateMaterials = groupedNullableCount(materials, enterprise.id);
      const effectiveMaterials = privateMaterials + (includeShared ? sharedMaterialCount : 0);
      const effectiveSensitiveRules =
        groupedNullableCount(sensitiveRules, enterprise.id) +
        (includeShared ? sharedSensitiveRuleCount : 0);
      const terminalGeneration = (generationCounts.SUCCEEDED ?? 0) + (generationCounts.FAILED ?? 0);
      const blockers = [
        enterprise.status !== "ACTIVE" ? "ENTERPRISE_DISABLED" : null,
        enabledSeats === 0 ? "NO_PARTICIPATING_MEMBERS" : null,
        effectiveMaterials === 0 ? "NO_EFFECTIVE_MATERIALS" : null,
      ].filter((value): value is string => Boolean(value));
      return {
        blockers,
        campaignReady: blockers.length === 0,
        campaigns: campaignCounts,
        code: enterprise.code,
        effectiveMaterials,
        effectiveSensitiveRules,
        enabledSeats,
        generation: {
          failed: generationCounts.FAILED ?? 0,
          running: (generationCounts.QUEUED ?? 0) + (generationCounts.RUNNING ?? 0),
          succeeded: generationCounts.SUCCEEDED ?? 0,
          successRate:
            terminalGeneration === 0
              ? null
              : (generationCounts.SUCCEEDED ?? 0) / terminalGeneration,
        },
        id: enterprise.id,
        name: enterprise.name,
        status: enterprise.status,
      };
    });
    return {
      enterprises: enterpriseRows,
      sharedMaterials: {
        effectiveCount: sharedMaterialCount,
        expiring: expiring.map((material) => ({
          expiresAt: material.expiresAt,
          id: material.id,
          title: material.title,
          version: material.version,
        })),
        usage: sharedUsage.map((row) => ({
          enterpriseId: row.enterpriseId,
          hitCount: row._count._all,
          lastHitAt: row._max.createdAt,
          materialId: row.materialId,
          materialTitle: row.materialTitle,
          materialVersion: row.materialVersion,
        })),
      },
      summary: {
        activeEnterprises: enterprises.filter(({ status }) => status === "ACTIVE").length,
        blockedEnterprises: enterpriseRows.filter(({ campaignReady }) => !campaignReady).length,
        campaignReadyEnterprises: enterpriseRows.filter(({ campaignReady }) => campaignReady)
          .length,
        enabledSeats: enterpriseRows.reduce((sum, row) => sum + row.enabledSeats, 0),
        totalCampaigns: enterpriseRows.reduce(
          (sum, row) => sum + Object.values(row.campaigns).reduce((a, b) => a + b, 0),
          0,
        ),
        totalEnterprises: enterprises.length,
      },
      tenant: {
        customerType: tenant.customerType,
        id: tenant.id,
        name: tenant.name,
        timezone: tenant.timezone,
      },
    };
  }
}

function groupedStatusCounts(
  rows: ReadonlyArray<
    Readonly<{ _count: Readonly<{ _all: number }>; enterpriseId: string; status: string }>
  >,
  enterpriseId: string,
): Record<string, number> {
  return Object.fromEntries(
    rows
      .filter((row) => row.enterpriseId === enterpriseId)
      .map((row) => [row.status, row._count._all]),
  );
}

function groupedNullableCount(
  rows: ReadonlyArray<
    Readonly<{ _count: Readonly<{ _all: number }>; enterpriseId: string | null }>
  >,
  enterpriseId: string | null,
): number {
  return rows.find((row) => row.enterpriseId === enterpriseId)?._count._all ?? 0;
}
