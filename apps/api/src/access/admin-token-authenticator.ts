import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { AuthTokenService, type VerifiedAdminAccessToken } from "./auth-token.service";

@Injectable()
export class AdminTokenAuthenticator {
  constructor(
    @Inject(AuthTokenService) private readonly tokens: AuthTokenService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async authenticate(
    authorization: string | string[] | undefined,
  ): Promise<VerifiedAdminAccessToken> {
    const verified = this.tokens.verifyAdminAccessToken(bearerToken(authorization));
    if (!verified.sessionId && !sessionlessDevelopmentTokensAllowed()) {
      throw new UnauthorizedException("Administrator session is required");
    }

    const now = new Date();
    const user = await this.prisma.adminUser.findFirst({
      select: { id: true },
      where: {
        adminSessions: verified.sessionId
          ? {
              some: {
                expiresAt: { gt: now },
                id: verified.sessionId,
                revokedAt: null,
              },
            }
          : undefined,
        id: verified.userId,
        status: "ACTIVE",
      },
    });
    if (!user) {
      throw new UnauthorizedException(
        "Authenticated administrator or session is disabled, expired or revoked",
      );
    }
    return verified;
  }
}

function bearerToken(header: string | string[] | undefined): string {
  if (typeof header !== "string") {
    throw new UnauthorizedException("Bearer access token is required");
  }
  const match = /^Bearer\s+([^\s]+)$/iu.exec(header);
  if (!match?.[1]) {
    throw new UnauthorizedException("Bearer access token is required");
  }
  return match[1];
}

function sessionlessDevelopmentTokensAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_AUTH === "true";
}
