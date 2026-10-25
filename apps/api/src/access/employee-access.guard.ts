import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Scope,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { AuthTokenService } from "./auth-token.service";
import { RequestAccessContext } from "./request-access-context";

type HttpRequest = Readonly<{
  headers: Readonly<Record<string, string | string[] | undefined>>;
}>;

@Injectable({ scope: Scope.REQUEST })
export class EmployeeAccessGuard implements CanActivate {
  constructor(
    @Inject(AuthTokenService) private readonly tokens: AuthTokenService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    const { userId, sessionId } = this.tokens.verifyEmployeeAccessToken(
      bearerToken(request.headers.authorization),
    );
    if (
      sessionId &&
      !(await this.prisma.adminSession.count({
        where: {
          id: sessionId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: { status: "ACTIVE", employeeUserId: userId },
        },
      }))
    )
      throw new UnauthorizedException("员工会话已注销、过期或账号已停用");
    const user = await this.prisma.globalUser.findFirst({
      select: {
        id: true,
        memberships: {
          select: { id: true },
          where: {
            enterprise: { status: "ACTIVE" },
            seatStatus: "ENABLED",
            status: "ACTIVE",
            tenant: { status: "ACTIVE" },
          },
        },
      },
      where: { id: userId, status: "ACTIVE" },
    });
    if (!user) {
      throw new UnauthorizedException("Authenticated employee is disabled or no longer exists");
    }
    if (user.memberships.length === 0) {
      throw new ForbiddenException("Employee has no active enterprise membership");
    }
    this.accessContext.initialize({
      audience: "EMPLOYEE",
      membershipIds: Object.freeze(user.memberships.map(({ id }) => id)),
      userId: user.id,
    });
    return true;
  }
}

function bearerToken(header: string | string[] | undefined): string {
  if (typeof header !== "string") {
    throw new UnauthorizedException("Bearer access token is required");
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match?.[1]) {
    throw new UnauthorizedException("Bearer access token is required");
  }
  return match[1];
}
