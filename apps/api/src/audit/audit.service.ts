import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import {
  type CursorPaginationQueryDto,
  createdAtCursorWhere,
  createdAtOrderBy,
  pageTake,
  toCursorPage,
} from "../http/cursor-pagination";

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    scope: Readonly<{ enterpriseId?: string; tenantId: string }>,
    query: CursorPaginationQueryDto,
  ) {
    const logs = await this.prisma.auditLog.findMany({
      orderBy: createdAtOrderBy(),
      take: pageTake(query),
      where: {
        AND: [
          { enterpriseId: scope.enterpriseId, tenantId: scope.tenantId },
          createdAtCursorWhere(query),
        ],
      },
    });
    const actorIds = [
      ...new Set(logs.flatMap(({ actorUserId }) => (actorUserId ? [actorUserId] : []))),
    ];
    const [administrators, employees] = await Promise.all([
      this.prisma.adminUser.findMany({
        select: { id: true, phone: true },
        where: { id: { in: actorIds } },
      }),
      this.prisma.globalUser.findMany({
        select: { id: true, phone: true },
        where: { id: { in: actorIds } },
      }),
    ]);
    const actors = new Map(
      [...employees, ...administrators].map(({ id, phone }) => [id, { id, phone }]),
    );
    const page = toCursorPage(logs, query);
    return {
      ...page,
      items: page.items.map((log) => {
        const actor = log.actorUserId ? actors.get(log.actorUserId) : undefined;
        return {
          action: log.action,
          actor: actor
            ? { id: actor.id, phone: maskPhone(actor.phone) }
            : { id: null, phone: null },
          actorType: log.actorType,
          createdAt: log.createdAt,
          enterpriseId: log.enterpriseId,
          id: log.id,
          reason: log.reason,
          requestId: log.requestId,
          resourceId: log.resourceId,
          resourceType: log.resourceType,
          tenantId: log.tenantId,
        };
      }),
    };
  }
}

function maskPhone(value: string | null): string | null {
  return value?.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2") ?? null;
}
