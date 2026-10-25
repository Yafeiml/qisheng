import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { type Industry, Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type { CreateIndustryDto, UpdateIndustryGuidanceDto } from "./organization.dto";

@Injectable()
export class IndustryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  list() {
    return this.prisma.industry.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, sortOrder: true, createdAt: true, updatedAt: true },
    });
  }

  listManagement(): Promise<Industry[]> {
    return this.prisma.industry.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  }

  async create(input: CreateIndustryDto): Promise<Industry> {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ForbiddenException("Industry management requires platform scope");
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const latest = await transaction.industry.findFirst({
          orderBy: [{ sortOrder: "desc" }, { name: "desc" }],
          select: { sortOrder: true },
        });
        const industry = await transaction.industry.create({
          data: {
            name: input.name,
            generationGuidance: input.generationGuidance ?? "",
            sortOrder: (latest?.sortOrder ?? 0) + 100,
          },
        });
        await transaction.auditLog.create({
          data: {
            action: "industry.create",
            actorType: "USER",
            actorUserId: principal.userId,
            resourceId: industry.id,
            resourceType: "Industry",
            stateAfter: {
              name: industry.name,
              generationGuidance: industry.generationGuidance,
              sortOrder: industry.sortOrder,
            },
          },
        });
        return industry;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("该行业已存在，请勿重复添加");
      }
      throw error;
    }
  }

  async updateGuidance(id: string, input: UpdateIndustryGuidanceDto): Promise<Industry> {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM")
      throw new ForbiddenException("Industry management requires platform scope");
    return this.prisma.$transaction(async (transaction) => {
      const before = await transaction.industry.findUnique({ where: { id } });
      if (!before) throw new NotFoundException("未找到该行业，请刷新行业列表");
      const changed = await transaction.industry.updateMany({
        data: {
          generationGuidance: input.generationGuidance,
          updatedAt: new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1)),
        },
        where: { id, updatedAt: new Date(input.expectedUpdatedAt) },
      });
      if (changed.count !== 1)
        throw new ConflictException("行业规则已被其他管理员修改，请刷新后重新编辑");
      const after = await transaction.industry.findUniqueOrThrow({ where: { id } });
      await transaction.auditLog.create({
        data: {
          action: "industry.guidance.update",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceId: id,
          resourceType: "Industry",
          stateBefore: { generationGuidance: before.generationGuidance },
          stateAfter: { generationGuidance: after.generationGuidance },
        },
      });
      return after;
    });
  }

  async assertAvailable(name: string | null | undefined): Promise<void> {
    if (!name) return;
    const industry = await this.prisma.industry.findUnique({
      select: { id: true },
      where: { name },
    });
    if (!industry) {
      throw new ConflictException("请选择平台预设行业；如需新行业，请联系 SaaS 平台管理员添加");
    }
  }
}
