import { createHash } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import { AuthTokenService } from "../access/auth-token.service";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { hashPassword, normalizeUsername } from "./password";

@Injectable()
export class EmployeeWebService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminTokenAuthenticator) private readonly authenticator: AdminTokenAuthenticator,
    @Inject(AuthTokenService) private readonly tokens: AuthTokenService,
    @Inject(RequestAccessContext) private readonly context: RequestAccessContext,
  ) {}

  async invitation(_membershipId: string) {
    throw new ForbiddenException("自助注册已关闭，请由管理员直接创建员工登录账号");
  }

  async createAccount(membershipId: string, input: { username: string; password: string }) {
    const actor = this.context.requireSaasAdmin();
    if (actor.scope.type !== "ENTERPRISE") throw new ForbiddenException("请在企业范围创建员工账号");
    const scope = actor.scope;
    const username = normalizeUsername(input.username);
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const where: Prisma.EnterpriseMembershipWhereInput = {
          id: membershipId,
          tenantId: scope.tenantId,
          enterpriseId: scope.enterpriseId,
          globalUserId: null,
          status: { in: ["ACTIVE", "PENDING_BIND"] },
          seatStatus: "ENABLED",
          enterprise: { status: "ACTIVE" },
          tenant: { status: "ACTIVE" },
        };
        const membership = await transaction.enterpriseMembership.findFirst({ where });
        if (!membership) throw new ConflictException("成员不存在、已绑定账号，或任务资格尚未启用");
        const employee = await transaction.globalUser.create({ data: {} });
        const user = await transaction.adminUser.create({
          data: { username, passwordHash, name: membership.name, employeeUserId: employee.id },
        });
        const claimed = await transaction.enterpriseMembership.updateMany({
          where,
          data: {
            globalUserId: employee.id,
            status: "ACTIVE",
            boundAt: new Date(),
            webInvitationHash: null,
            webInvitationExpiresAt: null,
          },
        });
        if (claimed.count !== 1)
          throw new ConflictException("成员状态已变化，请刷新后重试；未创建员工账号");
        await transaction.auditLog.create({
          data: {
            action: "employee-web.account-created",
            actorType: "USER",
            actorUserId: actor.userId,
            tenantId: scope.tenantId,
            enterpriseId: scope.enterpriseId,
            resourceType: "EnterpriseMembership",
            resourceId: membershipId,
            stateAfter: { userId: user.id, username },
          },
        });
        return { userId: user.id, username, membershipId };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException("账号已存在或成员已绑定，请使用其他账号并刷新后重试");
      throw error;
    }
  }

  async bind(authorization: string | undefined, token: string) {
    const account = await this.authenticator.authenticate(authorization);
    if (!account.sessionId) throw new UnauthorizedException("请使用账号密码正式登录后绑定");
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${account.userId}, 20261015))`;
      const user = await transaction.adminUser.findUniqueOrThrow({ where: { id: account.userId } });
      if (!user.passwordHash) throw new UnauthorizedException("请使用账号密码正式登录后绑定");
      const membership = await transaction.enterpriseMembership.findFirst({
        where: {
          webInvitationHash: hash(token),
          webInvitationExpiresAt: { gt: new Date() },
          globalUserId: null,
          seatStatus: "ENABLED",
          status: { in: ["PENDING_BIND", "ACTIVE"] },
          enterprise: { status: "ACTIVE" },
          tenant: { status: "ACTIVE" },
        },
      });
      if (!membership)
        throw new ConflictException("邀请已失效、已使用或成员资格已变更，请联系管理员重新邀请");
      const employee = user.employeeUserId
        ? await transaction.globalUser.findFirst({
            where: { id: user.employeeUserId, status: "ACTIVE" },
          })
        : await transaction.globalUser.create({ data: {} });
      if (!employee) throw new UnauthorizedException("员工账号已停用，请联系管理员");
      await transaction.adminUser.update({
        where: { id: user.id },
        data: { employeeUserId: employee.id },
      });
      const claimed = await transaction.enterpriseMembership.updateMany({
        where: {
          id: membership.id,
          webInvitationHash: hash(token),
          globalUserId: null,
          webInvitationExpiresAt: { gt: new Date() },
          seatStatus: "ENABLED",
          status: membership.status,
        },
        data: {
          globalUserId: employee.id,
          status: "ACTIVE",
          boundAt: new Date(),
          webInvitationHash: null,
          webInvitationExpiresAt: null,
        },
      });
      if (claimed.count !== 1) throw new ConflictException("邀请已被使用或成员资格已变更");
      await transaction.auditLog.create({
        data: {
          action: "employee-web.bind",
          actorType: "USER",
          actorUserId: user.id,
          tenantId: membership.tenantId,
          enterpriseId: membership.enterpriseId,
          resourceType: "EnterpriseMembership",
          resourceId: membership.id,
        },
      });
    });
    return this.session(authorization);
  }

  async session(authorization: string | undefined) {
    const { userId, sessionId } = await this.authenticator.authenticate(authorization);
    if (!sessionId) throw new UnauthorizedException("需要正式登录会话");
    const account = await this.prisma.adminUser.findUnique({
      where: { id: userId },
      include: {
        employeeUser: {
          include: {
            memberships: {
              include: { enterprise: { select: { name: true } } },
              where: {
                status: "ACTIVE",
                seatStatus: "ENABLED",
                enterprise: { status: "ACTIVE" },
                tenant: { status: "ACTIVE" },
              },
            },
          },
        },
      },
    });
    const employee = account?.employeeUser;
    if (employee?.status !== "ACTIVE" || !employee.memberships.length)
      throw new NotFoundException("账号尚未绑定可用员工身份，请联系管理员创建或启用员工账号");
    return {
      accessToken: this.tokens.issueEmployeeAccessToken(employee.id, sessionId),
      audience: "xhs-employee-miniapp",
      tokenType: "Bearer",
      userId: employee.id,
      memberships: employee.memberships.map((membership) => ({
        tenantId: membership.tenantId,
        enterpriseId: membership.enterpriseId,
        enterpriseName: membership.enterprise.name,
        membershipId: membership.id,
      })),
    };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
