import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type { CreateManagementActionDto, UpdateManagementActionDto } from "./management-action.dto";

@Injectable()
export class ManagementActionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  list(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.managementAction.findMany({
      include: { campaign: { select: { id: true, title: true } } },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
      where: { enterpriseId, tenantId },
    });
  }

  async create(tenantId: string, enterpriseId: string, input: CreateManagementActionDto) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.$transaction(async (transaction) => {
      if (input.campaignId) {
        const campaign = await transaction.campaign.findFirst({
          select: { id: true },
          where: { enterpriseId, id: input.campaignId, tenantId },
        });
        if (!campaign) throw new NotFoundException("当前企业中未找到关联活动");
      }
      const action = await transaction.managementAction.create({
        data: {
          assignee: optionalText(input.assignee),
          campaignId: optionalText(input.campaignId),
          createdBy: principal.userId,
          description: optionalText(input.description),
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          enterpriseId,
          tenantId,
          title: input.title,
        },
        include: { campaign: { select: { id: true, title: true } } },
      });
      await transaction.auditLog.create({
        data: {
          action: "management-action.create",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId,
          resourceId: action.id,
          resourceType: "ManagementAction",
          stateAfter: { assignee: action.assignee, status: action.status, title: action.title },
          tenantId,
        },
      });
      return action;
    });
  }

  async update(
    tenantId: string,
    enterpriseId: string,
    actionId: string,
    input: UpdateManagementActionDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    if (
      input.status === undefined &&
      input.assignee === undefined &&
      input.note === undefined &&
      input.dueAt === undefined
    ) {
      throw new BadRequestException("请至少修改负责人、状态、截止时间或复盘备注");
    }
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.managementAction.findFirst({
        where: { enterpriseId, id: actionId, tenantId },
      });
      if (!existing) throw new NotFoundException("当前企业中未找到该管理事项");
      const updated = await transaction.managementAction.update({
        data: {
          assignee:
            input.assignee === undefined ? undefined : (optionalText(input.assignee) ?? null),
          dueAt: input.dueAt === undefined ? undefined : new Date(input.dueAt),
          note: input.note === undefined ? undefined : (optionalText(input.note) ?? null),
          resolvedAt:
            input.status === "RESOLVED"
              ? (existing.resolvedAt ?? new Date())
              : input.status
                ? null
                : undefined,
          status: input.status,
        },
        include: { campaign: { select: { id: true, title: true } } },
        where: { id: existing.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "management-action.update",
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId,
          resourceId: existing.id,
          resourceType: "ManagementAction",
          stateAfter: {
            assignee: updated.assignee,
            dueAt: updated.dueAt,
            status: updated.status,
          },
          stateBefore: {
            assignee: existing.assignee,
            dueAt: existing.dueAt,
            status: existing.status,
          },
          tenantId,
        },
      });
      return updated;
    });
  }

  private requireEnterpriseScope(tenantId: string, enterpriseId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== tenantId ||
      principal.scope.enterpriseId !== enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match the requested enterprise");
    }
    return principal;
  }
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
