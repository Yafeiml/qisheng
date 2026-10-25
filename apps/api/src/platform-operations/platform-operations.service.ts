import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { generationDeliveryMode } from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { GenerationQueueService } from "../campaign/generation-queue.service";
import { PrismaService } from "../database/prisma.service";
import {
  type CursorPaginationQueryDto,
  createdAtCursorWhere,
  createdAtOrderBy,
  pageTake,
  toCursorPage,
} from "../http/cursor-pagination";
import { ModelConfigurationService } from "../model-configuration/model-configuration.service";
import { ModelProviderHealthService } from "../model-configuration/model-provider-health.service";
import { ModelQualificationService } from "../model-configuration/model-qualification.service";
import { RuntimePolicyService } from "../model-configuration/runtime-policy.service";
import { EnterpriseWorkspaceService } from "../organization/enterprise-workspace.service";
import type {
  CreatePlatformCustomerNoteDto,
  CustomerListQueryDto,
  ProvisionCustomerDto,
} from "./platform-operations.dto";
import { ProductionReadinessService } from "./production-readiness.service";

function customerRelations() {
  return {
    capabilityPolicy: true,
    enterprises: {
      orderBy: { createdAt: "asc" as const },
      select: { code: true, id: true, name: true, status: true },
    },
  } as const satisfies Prisma.TenantInclude;
}

type CustomerRecord = Prisma.TenantGetPayload<{
  include: ReturnType<typeof customerRelations>;
}>;

type CustomerSummary = Readonly<{
  createdAt: Date;
  enterpriseState: string;
  id: string;
  readiness: Readonly<{ state: string; totalEnterprises: number }>;
}> &
  Readonly<Record<string, unknown>>;

@Injectable()
export class PlatformOperationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(GenerationQueueService) private readonly generationQueue: GenerationQueueService,
    @Inject(EnterpriseWorkspaceService)
    private readonly enterpriseWorkspace: EnterpriseWorkspaceService,
    @Inject(ModelQualificationService)
    private readonly modelQualifications: ModelQualificationService,
    @Inject(ModelConfigurationService)
    private readonly modelConfiguration: ModelConfigurationService,
    @Inject(RuntimePolicyService) private readonly runtimePolicy: RuntimePolicyService,
    @Inject(ProductionReadinessService)
    private readonly productionReadiness: ProductionReadinessService,
    @Inject(ModelProviderHealthService) private readonly providerHealth: ModelProviderHealthService,
  ) {}

  customerEnterpriseReadiness(tenantId: string, enterpriseId: string) {
    return this.enterpriseWorkspace.platformSummary(tenantId, enterpriseId);
  }

  async overview() {
    const monitoredModelIds = await this.providerHealth.refreshConfigured();
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const policy = await this.runtimePolicy.current();
    const [
      activeTenants,
      tenantKinds,
      activeEnterprises,
      activeProviders,
      realProviders,
      openCircuitProviders,
      halfOpenCircuitProviders,
      runsToday,
      runStatuses,
      workItemStatuses,
      staleRuns,
      staleWorkItems,
      invocationsToday,
      failedInvocationsToday,
      invocationCost,
      invocationLatency,
      retriedWorkItemsToday,
      queue,
      modelRoutes,
      staleHealthProviders,
      productionReadiness,
    ] = await Promise.all([
      this.prisma.tenant.count({ where: { status: "ACTIVE" } }),
      this.prisma.tenant.groupBy({
        _count: { _all: true },
        by: ["customerType"],
        where: { status: "ACTIVE" },
      }),
      this.prisma.enterprise.count({ where: { status: "ACTIVE" } }),
      this.prisma.modelProvider.count({ where: { status: "ACTIVE" } }),
      this.prisma.modelProvider.count({ where: { status: "ACTIVE", synthetic: false } }),
      this.prisma.modelProvider.count({ where: { circuitState: "OPEN", status: "ACTIVE" } }),
      this.prisma.modelProvider.count({ where: { circuitState: "HALF_OPEN", status: "ACTIVE" } }),
      this.prisma.generationRun.count({ where: { createdAt: { gte: today } } }),
      this.prisma.generationRun.groupBy({
        _count: { _all: true },
        by: ["status"],
      }),
      this.prisma.generationWorkItem.groupBy({
        _count: { _all: true },
        by: ["status"],
      }),
      this.prisma.generationRun.count({
        where: {
          campaign: { blueprint: { is: null } },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          status: "RUNNING",
        },
      }),
      this.prisma.generationWorkItem.count({
        where: {
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          status: "RUNNING",
        },
      }),
      this.prisma.modelInvocation.count({ where: { createdAt: { gte: today } } }),
      this.prisma.modelInvocation.count({
        where: { createdAt: { gte: today }, status: "FAILED" },
      }),
      this.prisma.modelInvocation.aggregate({
        _sum: { estimatedCost: true },
        where: { createdAt: { gte: today } },
      }),
      this.prisma.modelInvocation.aggregate({
        _avg: { latencyMs: true },
        where: { createdAt: { gte: today }, latencyMs: { not: null } },
      }),
      this.prisma.generationWorkItem.count({
        where: { attemptCount: { gt: 1 }, createdAt: { gte: today } },
      }),
      this.generationQueue.getOperationalMetrics(),
      this.prisma.modelRoute.findMany({
        include: {
          imageModel: { select: { synthetic: true } },
          textModel: { select: { synthetic: true } },
        },
      }),
      this.prisma.modelProvider.count({
        where: {
          models: { some: { id: { in: monitoredModelIds } } },
          OR: [
            { healthStatus: { not: "HEALTHY" } },
            {
              lastHealthCheckedAt: {
                lt: new Date(now.getTime() - policy.providerHealthMaxAgeSeconds * 1_000),
              },
            },
            { lastHealthCheckedAt: null },
          ],
          status: "ACTIVE",
          synthetic: false,
        },
      }),
      this.productionReadiness.audit(),
    ]);

    const routeAssessments = await Promise.all(
      modelRoutes.map(async (route) => {
        if (route.textModel.synthetic && route.imageModel.synthetic) return null;
        return this.modelQualifications.assessRoute(route.id, policy, now).catch(() => null);
      }),
    );
    const syntheticRoutes = modelRoutes.filter(
      ({ imageModel, textModel }) => imageModel.synthetic || textModel.synthetic,
    ).length;
    const qualifiedRoutes = routeAssessments.filter((assessment) => assessment?.eligible).length;
    const blockedRoutes = modelRoutes.length - syntheticRoutes - qualifiedRoutes;

    const runCounts = countByStatus(runStatuses);
    const workItemCounts = countByStatus(workItemStatuses);
    const terminalRuns = (runCounts.SUCCEEDED ?? 0) + (runCounts.FAILED ?? 0);

    return {
      generatedAt: now.toISOString(),
      generation: {
        averageInvocationLatencyMs: invocationLatency._avg.latencyMs,
        invocationsToday,
        invocationCostToday: Number(invocationCost._sum.estimatedCost ?? 0),
        invocationFailuresToday: failedInvocationsToday,
        queue,
        retriedWorkItemsToday,
        runSuccessRate: terminalRuns === 0 ? null : (runCounts.SUCCEEDED ?? 0) / terminalRuns,
        runsByStatus: runCounts,
        runsToday,
        staleRuns,
        staleWorkItems,
        workItemsByStatus: workItemCounts,
      },
      models: {
        activeProviders,
        blockedRoutes,
        deliveryMode: generationDeliveryMode(),
        halfOpenCircuitProviders,
        openCircuitProviders,
        qualifiedRoutes,
        realProviders,
        staleHealthProviders,
        syntheticProviders: activeProviders - realProviders,
        syntheticRoutes,
      },
      productionReadiness,
      tenants: {
        activeEnterprises,
        activeTenants,
        groups: tenantKinds.find((row) => row.customerType === "GROUP")?._count._all ?? 0,
        singleEnterprises:
          tenantKinds.find((row) => row.customerType === "SINGLE_ENTERPRISE")?._count._all ?? 0,
      },
    };
  }

  async listGenerationRuns(query: CursorPaginationQueryDto) {
    const now = new Date();
    const runs = await this.prisma.generationRun.findMany({
      include: {
        campaign: {
          include: {
            enterprise: { select: { id: true, name: true } },
            tenant: { select: { id: true, name: true } },
          },
        },
        invocations: { select: { estimatedCost: true, status: true } },
        workItems: { select: { attemptCount: true, leaseExpiresAt: true, status: true } },
      },
      orderBy: createdAtOrderBy(),
      take: pageTake(query),
      where: createdAtCursorWhere(query),
    });

    const page = toCursorPage(runs, query);
    return {
      ...page,
      items: page.items.map((run) => {
        const workItems = countRowsByStatus(run.workItems);
        const invocations = countRowsByStatus(run.invocations);
        const estimatedCost = run.invocations.reduce(
          (total, invocation) => total + Number(invocation.estimatedCost),
          0,
        );
        return {
          activeWorkItemLeases: run.workItems.filter(
            ({ leaseExpiresAt, status }) =>
              status === "RUNNING" && leaseExpiresAt !== null && leaseExpiresAt > now,
          ).length,
          attemptCount: run.attemptCount,
          campaign: {
            id: run.campaign.id,
            status: run.campaign.status,
            title: run.campaign.title,
          },
          completedCount: run.completedCount,
          createdAt: run.createdAt,
          errorCode: run.errorCode,
          errorRetryable: run.errorRetryable,
          enterprise: run.campaign.enterprise,
          estimatedCost,
          executionVersion: run.executionVersion,
          failedCount: run.failedCount,
          finishedAt: run.finishedAt,
          id: run.id,
          imageModel: run.imageModel,
          invocations,
          provider: run.provider,
          queueVersion: run.queueVersion,
          recoveryCount: run.recoveryCount,
          requestedCount: run.requestedCount,
          retriedWorkItems: run.workItems.filter(({ attemptCount }) => attemptCount > 1).length,
          startedAt: run.startedAt,
          staleWorkItems: run.workItems.filter(
            ({ leaseExpiresAt, status }) =>
              status === "RUNNING" && (leaseExpiresAt === null || leaseExpiresAt <= now),
          ).length,
          status: run.status,
          synthetic: run.synthetic,
          tenant: run.campaign.tenant,
          textModel: run.textModel,
          leaseExpiresAt: run.leaseExpiresAt,
          workItems,
        };
      }),
    };
  }

  async getGenerationRun(generationRunId: string) {
    const run = await this.prisma.generationRun.findUnique({
      include: {
        campaign: {
          include: {
            enterprise: { select: { id: true, name: true } },
            tenant: { select: { id: true, name: true } },
          },
        },
        invocations: { select: { estimatedCost: true, status: true } },
        workItems: { orderBy: { createdAt: "asc" } },
      },
      where: { id: generationRunId },
    });
    if (!run) throw new NotFoundException("Generation run was not found");
    const workItems = countRowsByStatus(run.workItems);
    const invocations = countRowsByStatus(run.invocations);
    const now = new Date();
    return {
      activeWorkItemLeases: run.workItems.filter(
        ({ leaseExpiresAt, status }) =>
          status === "RUNNING" && leaseExpiresAt !== null && leaseExpiresAt > now,
      ).length,
      attemptCount: run.attemptCount,
      campaign: { id: run.campaign.id, status: run.campaign.status, title: run.campaign.title },
      completedCount: run.completedCount,
      createdAt: run.createdAt,
      enterprise: run.campaign.enterprise,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      errorRetryable: run.errorRetryable,
      estimatedCost: run.invocations.reduce(
        (total, invocation) => total + Number(invocation.estimatedCost),
        0,
      ),
      executionVersion: run.executionVersion,
      failedCount: run.failedCount,
      finishedAt: run.finishedAt,
      heartbeatAt: run.heartbeatAt,
      id: run.id,
      imageModel: run.imageModel,
      invocations,
      leaseExpiresAt: run.leaseExpiresAt,
      leaseOwner: run.leaseOwner,
      maxAttempts: run.maxAttempts,
      nextRetryAt: run.nextRetryAt,
      provider: run.provider,
      queueVersion: run.queueVersion,
      recoveryCount: run.recoveryCount,
      requestedCount: run.requestedCount,
      retriedWorkItems: run.workItems.filter(({ attemptCount }) => attemptCount > 1).length,
      startedAt: run.startedAt,
      staleWorkItems: run.workItems.filter(
        ({ leaseExpiresAt, status }) =>
          status === "RUNNING" && (leaseExpiresAt === null || leaseExpiresAt <= now),
      ).length,
      status: run.status,
      synthetic: run.synthetic,
      tenant: run.campaign.tenant,
      textModel: run.textModel,
      workItemDetails: run.workItems.map((item) => ({
        attemptCount: item.attemptCount,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        errorRetryable: item.errorRetryable,
        executionVersion: item.executionVersion,
        finishedAt: item.finishedAt,
        heartbeatAt: item.heartbeatAt,
        id: item.id,
        leaseExpiresAt: item.leaseExpiresAt,
        leaseOwner: item.leaseOwner,
        maxAttempts: item.maxAttempts,
        nextRetryAt: item.nextRetryAt,
        queueVersion: item.queueVersion,
        recoveryCount: item.recoveryCount,
        reservationVersion: item.reservationVersion,
        startedAt: item.startedAt,
        status: item.status,
      })),
      workItems,
    };
  }

  async recoverGenerationRun(generationRunId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ConflictException("Generation recovery requires platform scope");
    }
    const now = new Date();
    const recovery = await this.prisma.$transaction(async (transaction) => {
      const run = await transaction.generationRun.findUnique({
        include: {
          campaign: { include: { blueprint: { select: { campaignId: true } } } },
          workItems: { orderBy: { createdAt: "asc" } },
        },
        where: { id: generationRunId },
      });
      if (!run) throw new NotFoundException("Generation run was not found");
      if (run.status === "FAILED" || run.status === "SUCCEEDED") {
        throw new ConflictException("Terminal generation runs cannot be operationally recovered");
      }

      let runJob: { generationRunId: string; queueVersion: number; tenantId: string } | null = null;
      const workItemJobs: Array<{
        generationRunId: string;
        queueVersion: number;
        reservationVersion: number;
        tenantId: string;
        workItemId: string;
      }> = [];
      let recoveredRuns = 0;
      let recoveredWorkItems = 0;

      if (!run.campaign.blueprint) {
        if (run.status === "RUNNING" && isActiveLease(run.leaseExpiresAt, now)) {
          throw new ConflictException("The generation run still has an active worker lease");
        }
        const updated = await transaction.generationRun.update({
          data: {
            errorCode: "PLATFORM_MANUAL_RECOVERY",
            errorMessage: "Platform administrator requested durable redispatch",
            errorRetryable: true,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            maxAttempts: run.attemptCount >= run.maxAttempts ? { increment: 1 } : undefined,
            nextRetryAt: now,
            queueVersion: { increment: 1 },
            recoveryCount: run.status === "RUNNING" ? { increment: 1 } : undefined,
            status: "QUEUED",
          },
          select: { queueVersion: true },
          where: { id: run.id },
        });
        runJob = {
          generationRunId: run.id,
          queueVersion: updated.queueVersion,
          tenantId: run.tenantId,
        };
        recoveredRuns = 1;
      } else {
        for (const item of run.workItems) {
          if (item.status === "FAILED" || item.status === "SUCCEEDED") continue;
          if (item.status === "RUNNING" && isActiveLease(item.leaseExpiresAt, now)) continue;
          const updated = await transaction.generationWorkItem.update({
            data: {
              errorCode: "PLATFORM_MANUAL_RECOVERY",
              errorMessage: "Platform administrator requested durable redispatch",
              errorRetryable: true,
              leaseExpiresAt: null,
              leaseOwner: null,
              leaseToken: null,
              maxAttempts: item.attemptCount >= item.maxAttempts ? { increment: 1 } : undefined,
              nextRetryAt: now,
              queueVersion: { increment: 1 },
              recoveryCount: item.status === "RUNNING" ? { increment: 1 } : undefined,
              status: "QUEUED",
            },
            select: { queueVersion: true },
            where: { id: item.id },
          });
          workItemJobs.push({
            generationRunId: run.id,
            queueVersion: updated.queueVersion,
            reservationVersion: item.reservationVersion,
            tenantId: run.tenantId,
            workItemId: item.id,
          });
          recoveredWorkItems += 1;
        }
        if (workItemJobs.length > 0 && run.status !== "RUNNING") {
          await transaction.generationRun.update({
            data: { finishedAt: null, status: "RUNNING" },
            where: { id: run.id },
          });
        }
      }

      if (!runJob && workItemJobs.length === 0) {
        throw new ConflictException("No queued or expired generation execution can be recovered");
      }
      await transaction.auditLog.create({
        data: {
          action: "generation.run.manual-recovery",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId: run.campaign.enterpriseId,
          metadata: {
            recoveredRuns,
            recoveredWorkItems,
            runQueueVersion: runJob?.queueVersion,
            workItemQueueVersions: workItemJobs.map(({ queueVersion, workItemId }) => ({
              queueVersion,
              workItemId,
            })),
          },
          resourceId: run.id,
          resourceType: "GenerationRun",
          tenantId: run.tenantId,
        },
      });
      return { recoveredRuns, recoveredWorkItems, runJob, workItemJobs };
    });

    const runDispatch = recovery.runJob
      ? await settled(this.generationQueue.enqueueRun(recovery.runJob))
      : false;
    const itemDispatches = await Promise.all(
      recovery.workItemJobs.map(async (job) => ({
        job,
        sent: await settled(this.generationQueue.enqueueWorkItem(job)),
      })),
    );
    const failedItems = itemDispatches.filter(({ sent }) => !sent).map(({ job }) => job.workItemId);
    if ((recovery.runJob && !runDispatch) || failedItems.length > 0) {
      await this.prisma.auditLog.create({
        data: {
          action: "generation.run.manual-recovery-dispatch-pending",
          actorType: "SYSTEM",
          metadata: {
            runDispatchPending: Boolean(recovery.runJob && !runDispatch),
            workItemDispatchPending: failedItems,
          },
          resourceId: generationRunId,
          resourceType: "GenerationRun",
        },
      });
    }
    return {
      enqueuedRuns: runDispatch ? 1 : 0,
      enqueuedWorkItems: itemDispatches.filter(({ sent }) => sent).length,
      generationRunId,
      recoveredRuns: recovery.recoveredRuns,
      recoveredWorkItems: recovery.recoveredWorkItems,
    };
  }

  async listCustomers(query: CustomerListQueryDto) {
    const now = new Date();
    const baseWhere: Prisma.TenantWhereInput[] = [
      query.customerType ? { customerType: query.customerType } : {},
      query.lifecycle ? { status: query.lifecycle } : {},
      query.enterpriseCode
        ? {
            enterprises: {
              some: { code: { contains: query.enterpriseCode, mode: "insensitive" } },
            },
          }
        : {},
      query.enterpriseState === "HAS_ENTERPRISE" ? { enterprises: { some: {} } } : {},
      query.enterpriseState === "NO_ENTERPRISE" ? { enterprises: { none: {} } } : {},
      query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              {
                enterprises: {
                  some: { name: { contains: query.search, mode: "insensitive" } },
                },
              },
              {
                enterprises: {
                  some: { code: { contains: query.search, mode: "insensitive" } },
                },
              },
            ],
          }
        : {},
    ];
    let cursorWhere = createdAtCursorWhere(query) as Prisma.TenantWhereInput;
    const matched: CustomerSummary[] = [];
    const batchSize = Math.max(100, query.limit * 2);

    while (matched.length <= query.limit) {
      const rows = await this.prisma.tenant.findMany({
        include: customerRelations(),
        orderBy: createdAtOrderBy(),
        take: batchSize + 1,
        where: { AND: [...baseWhere, cursorWhere] },
      });
      const hasMoreSource = rows.length > batchSize;
      const sourceRows = hasMoreSource ? rows.slice(0, batchSize) : rows;
      if (sourceRows.length === 0) break;
      const summaries = await this.customerSummaries(sourceRows, now);
      matched.push(...summaries.filter((customer) => matchesCustomerFilters(customer, query)));
      if (!hasMoreSource) break;
      cursorWhere = afterTenant(sourceRows.at(-1));
    }

    return toCursorPage(matched, query);
  }

  async getCustomer(tenantId: string) {
    this.requirePlatform();
    const now = new Date();
    const tenant = await this.prisma.tenant.findUnique({
      include: customerRelations(),
      where: { id: tenantId },
    });
    if (!tenant) throw new NotFoundException("Customer tenant was not found");
    const customer = (await this.customerSummaries([tenant], now))[0];
    if (!customer) throw new NotFoundException("Customer tenant was not found");

    const [audits, notes, runStatuses, workItemStatuses, workItemAttempts, invocations] =
      await Promise.all([
        this.prisma.auditLog.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
          where: { tenantId },
        }),
        this.prisma.platformCustomerNote.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
          where: { tenantId },
        }),
        this.prisma.generationRun.groupBy({
          _count: { _all: true },
          by: ["status"],
          where: { tenantId },
        }),
        this.prisma.generationWorkItem.groupBy({
          _count: { _all: true },
          by: ["status"],
          where: { tenantId },
        }),
        this.prisma.generationWorkItem.aggregate({
          _avg: { attemptCount: true },
          where: { tenantId },
        }),
        this.prisma.modelInvocation.aggregate({
          _count: { _all: true },
          _sum: { estimatedCost: true },
          where: { tenantId },
        }),
      ]);
    const [failedInvocations, actorPhones, enterpriseDetails, administratorBindings] =
      await Promise.all([
        this.prisma.modelInvocation.count({ where: { status: "FAILED", tenantId } }),
        this.prisma.adminUser.findMany({
          select: { id: true, phone: true },
          where: { id: { in: [...new Set(notes.map(({ createdBy }) => createdBy))] } },
        }),
        this.customerEnterpriseDetails(tenantId, tenant.enterprises, now),
        this.prisma.roleBinding.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            enterpriseId: true,
            scopeType: true,
            user: { select: { email: true, id: true, name: true, phone: true } },
          },
          where: {
            OR: [
              { role: { code: "TENANT_ADMIN" }, scopeType: "TENANT", scopeId: tenantId },
              {
                enterpriseId: { in: tenant.enterprises.map(({ id }) => id) },
                role: { code: "ENTERPRISE_ADMIN" },
                scopeType: "ENTERPRISE",
              },
            ],
            role: { status: "ACTIVE" },
            tenantId,
            user: { status: "ACTIVE" },
          },
        }),
      ]);
    const workItemsByStatus = countByStatus(workItemStatuses);
    const terminalWorkItems = (workItemsByStatus.SUCCEEDED ?? 0) + (workItemsByStatus.FAILED ?? 0);
    const phoneByUserId = new Map(actorPhones.map(({ id, phone }) => [id, maskPhone(phone)]));

    return {
      administrators: administratorBindings
        .filter(({ scopeType }) => scopeType === "TENANT")
        .map(({ user }) => user),
      audits: audits.map((audit) => ({
        action: audit.action,
        actorUserId: audit.actorUserId,
        createdAt: audit.createdAt,
        enterpriseId: audit.enterpriseId,
        id: audit.id,
        metadata: audit.metadata,
        reason: audit.reason,
        resourceId: audit.resourceId,
        resourceType: audit.resourceType,
      })),
      customer,
      enterprises: enterpriseDetails.map((detail) => ({
        ...detail,
        administrators: administratorBindings
          .filter(
            ({ enterpriseId, scopeType }) =>
              scopeType === "ENTERPRISE" && enterpriseId === detail.enterprise.id,
          )
          .map(({ user }) => user),
      })),
      generation: {
        averageAttempts: workItemAttempts._avg.attemptCount ?? 0,
        estimatedCost: Number(invocations._sum.estimatedCost ?? 0),
        invocationFailures: failedInvocations,
        invocations: invocations._count._all,
        runsByStatus: countByStatus(runStatuses),
        successRate:
          terminalWorkItems === 0 ? null : (workItemsByStatus.SUCCEEDED ?? 0) / terminalWorkItems,
        workItemsByStatus,
      },
      notes: notes.map((note) => ({
        ...note,
        createdByPhone: phoneByUserId.get(note.createdBy) ?? null,
      })),
    };
  }

  async createCustomerNote(tenantId: string, input: CreatePlatformCustomerNoteDto) {
    const principal = this.requirePlatform();
    const note = await this.prisma.$transaction(async (transaction) => {
      const tenant = await transaction.tenant.findUnique({
        select: { id: true },
        where: { id: tenantId },
      });
      if (!tenant) throw new NotFoundException("Customer tenant was not found");
      const created = await transaction.platformCustomerNote.create({
        data: { body: input.body, createdBy: principal.userId, tenantId },
      });
      await transaction.auditLog.create({
        data: {
          action: "platform.customer-note.create",
          actorType: "USER",
          actorUserId: principal.userId,
          metadata: { noteId: created.id, preview: input.body.slice(0, 120) },
          reason: input.reason,
          resourceId: created.id,
          resourceType: "PlatformCustomerNote",
          tenantId,
        },
      });
      return created;
    });
    const author = await this.prisma.adminUser.findUnique({
      select: { phone: true },
      where: { id: principal.userId },
    });
    return {
      ...note,
      createdByPhone: author ? maskPhone(author.phone) : null,
    };
  }

  async setCustomerSuspended(tenantId: string, suspended: boolean, reason: string) {
    const principal = this.requirePlatform();
    return this.prisma.$transaction(async (transaction) => {
      const tenant = await transaction.tenant.findUnique({
        where: { id: tenantId },
      });
      if (!tenant) throw new NotFoundException("Customer tenant was not found");
      if (tenant.status === "CLOSED") {
        throw new ConflictException("A closed customer cannot be suspended or resumed");
      }
      const tenantStatus = suspended ? "SUSPENDED" : "ACTIVE";
      if (tenant.status !== tenantStatus) {
        await transaction.tenant.update({
          data: { status: tenantStatus },
          where: { id: tenantId },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: suspended ? "customer.suspend" : "customer.resume",
          actorType: "USER",
          actorUserId: principal.userId,
          reason,
          resourceId: tenantId,
          resourceType: "Tenant",
          stateAfter: {
            status: tenantStatus,
          },
          stateBefore: {
            status: tenant.status,
          },
          tenantId,
        },
      });
      return {
        status: tenantStatus,
        tenantId,
      };
    });
  }

  private async customerSummaries(tenants: readonly CustomerRecord[], now: Date) {
    if (tenants.length === 0) return [];
    const tenantIds = tenants.map(({ id }) => id);
    const [seatCounts, campaignCounts, materialCounts] = await Promise.all([
      this.prisma.enterpriseMembership.groupBy({
        _count: { _all: true },
        by: ["tenantId", "enterpriseId", "seatStatus"],
        where: { tenantId: { in: tenantIds } },
      }),
      this.prisma.campaign.groupBy({
        _count: { _all: true },
        by: ["tenantId", "status"],
        where: { archivedAt: null, tenantId: { in: tenantIds } },
      }),
      this.prisma.material.groupBy({
        _count: { _all: true },
        by: ["tenantId", "enterpriseId"],
        where: {
          AND: [
            { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
          authorizationStatus: "AUTHORIZED",
          ingestionStatus: "READY",
          usabilityStatus: "USABLE",
          status: "ACTIVE",
          tenantId: { in: tenantIds },
        },
      }),
    ]);

    return tenants.map((tenant) => {
      const tenantSeatRows = seatCounts.filter((row) => row.tenantId === tenant.id);
      const sharedMaterials = groupedMaterialCount(materialCounts, tenant.id, null);
      const includeShared = tenant.capabilityPolicy?.groupSharedMaterialsEnabled ?? true;
      const readyEnterprises = tenant.enterprises.filter((enterprise) => {
        const enterpriseSeats = tenantSeatRows
          .filter((row) => row.enterpriseId === enterprise.id && row.seatStatus === "ENABLED")
          .reduce((sum, row) => sum + row._count._all, 0);
        const effectiveMaterials =
          groupedMaterialCount(materialCounts, tenant.id, enterprise.id) +
          (includeShared ? sharedMaterials : 0);
        return enterprise.status === "ACTIVE" && enterpriseSeats > 0 && effectiveMaterials > 0;
      }).length;
      const readiness = {
        blockedEnterprises: tenant.enterprises.length - readyEnterprises,
        readyEnterprises,
        state:
          tenant.enterprises.length === 0
            ? ("NOT_APPLICABLE" as const)
            : readyEnterprises === tenant.enterprises.length
              ? ("READY" as const)
              : ("BLOCKED" as const),
        totalEnterprises: tenant.enterprises.length,
      };
      return {
        campaigns: countGroupedRows(campaignCounts, tenant.id),
        createdAt: tenant.createdAt,
        customerType: tenant.customerType,
        enterprises: tenant.enterprises,
        enterpriseState:
          tenant.enterprises.length > 0 ? ("HAS_ENTERPRISE" as const) : ("NO_ENTERPRISE" as const),
        id: tenant.id,
        name: tenant.name,
        readiness,
        memberships: countGroupedRows(tenantSeatRows, tenant.id),
        status: tenant.status,
        timezone: tenant.timezone,
      };
    });
  }

  private async customerEnterpriseDetails(
    tenantId: string,
    enterprises: readonly CustomerRecord["enterprises"][number][],
    now: Date,
  ) {
    const policy = await this.runtimePolicy.current();
    return Promise.all(
      enterprises.map(async (enterprise) => {
        const workspace = await this.enterpriseWorkspace.platformSummary(tenantId, enterprise.id);
        try {
          const route = await this.modelConfiguration.resolveRoute(tenantId, enterprise.id);
          const assessment = await this.modelQualifications.assessRoute(route.id, policy, now);
          return {
            enterprise,
            route: {
              configurationFingerprint: assessment.configurationFingerprint,
              eligible: assessment.eligible,
              id: route.id,
              image: platformRouteModel(route.imageModel),
              qualification: assessment.qualification,
              reasons: assessment.reasons,
              scopeId: route.scopeId,
              scopeType: route.scopeType,
              text: platformRouteModel(route.textModel),
            },
            routeError: null,
            workspace,
          };
        } catch (error) {
          return {
            enterprise,
            route: null,
            routeError: safeErrorMessage(error),
            workspace,
          };
        }
      }),
    );
  }

  private requirePlatform() {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ForbiddenException("Platform customer operations require platform scope");
    }
    return principal;
  }

  async provisionCustomer(_input: ProvisionCustomerDto): Promise<never> {
    this.requirePlatform();
    throw new ForbiddenException("一套安装只管理一个企业或集团，请在集团后台新增下属企业");
  }
}

function countByStatus(
  rows: ReadonlyArray<Readonly<{ _count: Readonly<{ _all: number }>; status: string }>>,
): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}

function countRowsByStatus(
  rows: ReadonlyArray<Readonly<{ status: string }>>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = (result[row.status] ?? 0) + 1;
  return result;
}

function countGroupedRows(
  rows: ReadonlyArray<Readonly<{ _count: Readonly<{ _all: number }>; tenantId: string }>>,
  tenantId: string,
): Record<string, number> {
  return Object.fromEntries(
    rows
      .filter((row) => row.tenantId === tenantId)
      .map((row) => {
        const value = "status" in row ? row.status : "seatStatus" in row ? row.seatStatus : "ALL";
        return [String(value), row._count._all];
      }),
  );
}

function matchesCustomerFilters(customer: CustomerSummary, query: CustomerListQueryDto): boolean {
  return (
    !query.readiness ||
    (customer.readiness.totalEnterprises > 0 && customer.readiness.state === query.readiness)
  );
}

function afterTenant(
  tenant: Readonly<{ createdAt: Date; id: string }> | undefined,
): Prisma.TenantWhereInput {
  if (!tenant) return { id: "__no_tenant__" };
  return {
    OR: [
      { createdAt: { lt: tenant.createdAt } },
      { createdAt: tenant.createdAt, id: { lt: tenant.id } },
    ],
  };
}

function groupedMaterialCount(
  rows: ReadonlyArray<
    Readonly<{
      _count: Readonly<{ _all: number }>;
      enterpriseId: string | null;
      tenantId: string;
    }>
  >,
  tenantId: string,
  enterpriseId: string | null,
): number {
  return (
    rows.find((row) => row.tenantId === tenantId && row.enterpriseId === enterpriseId)?._count
      ._all ?? 0
  );
}

function platformRouteModel(model: {
  displayName: string;
  externalModelId: string;
  id: string;
  provider: {
    code: string;
    healthStatus: string;
    name: string;
    status: string;
  };
  status: string;
  synthetic: boolean;
  tier: string;
}) {
  return {
    displayName: model.displayName,
    externalModelId: model.externalModelId,
    healthStatus: model.provider.healthStatus,
    id: model.id,
    providerCode: model.provider.code,
    providerName: model.provider.name,
    providerStatus: model.provider.status,
    status: model.status,
    synthetic: model.synthetic,
    tier: model.tier,
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Model route diagnostics are unavailable";
}

function maskPhone(value: string | null): string | null {
  return value?.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2") ?? null;
}

function isActiveLease(leaseExpiresAt: Date | null, now: Date): boolean {
  return leaseExpiresAt !== null && leaseExpiresAt > now;
}

async function settled(operation: Promise<unknown>): Promise<boolean> {
  try {
    await operation;
    return true;
  } catch {
    return false;
  }
}
