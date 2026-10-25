import { Injectable, UnauthorizedException } from "@nestjs/common";
import jwt, { type JwtPayload } from "jsonwebtoken";

export const ADMIN_TOKEN_AUDIENCE = "xhs-saas-admin";
export const EMPLOYEE_TOKEN_AUDIENCE = "xhs-employee-miniapp";

export type VerifiedAdminAccessToken = Readonly<{
  sessionId: string | null;
  userId: string;
}>;

export type VerifiedEmployeeAccessToken = Readonly<{
  userId: string;
  sessionId: string | null;
}>;

@Injectable()
export class AuthTokenService {
  private readonly issuer = requiredEnvironmentValue("JWT_ISSUER");
  private readonly adminSecret = requiredSecret("ADMIN_JWT_SECRET");
  private readonly employeeSecret = requiredSecret("EMPLOYEE_JWT_SECRET");
  private readonly ttlSeconds = accessTokenTtl();

  get accessTokenTtlSeconds(): number {
    return this.ttlSeconds;
  }

  issueAdminAccessToken(userId: string, sessionId?: string): string {
    return this.issue(userId, ADMIN_TOKEN_AUDIENCE, this.adminSecret, sessionId);
  }

  issueEmployeeAccessToken(userId: string, sessionId?: string): string {
    return this.issue(userId, EMPLOYEE_TOKEN_AUDIENCE, this.employeeSecret, sessionId);
  }

  verifyAdminAccessToken(token: string): VerifiedAdminAccessToken {
    const payload = this.verify(token, ADMIN_TOKEN_AUDIENCE, this.adminSecret);
    return Object.freeze({
      sessionId: typeof payload.sid === "string" && payload.sid.length > 0 ? payload.sid : null,
      userId: payload.sub,
    });
  }

  verifyEmployeeAccessToken(token: string): VerifiedEmployeeAccessToken {
    const payload = this.verify(token, EMPLOYEE_TOKEN_AUDIENCE, this.employeeSecret);
    return Object.freeze({
      userId: payload.sub,
      sessionId: typeof payload.sid === "string" ? payload.sid : null,
    });
  }

  private issue(userId: string, audience: string, secret: string, sessionId?: string): string {
    const subject = userId.trim();
    if (subject.length === 0) {
      throw new Error("Access token subject must not be empty");
    }
    return jwt.sign({ sid: sessionId, tokenUse: "access" }, secret, {
      algorithm: "HS256",
      audience,
      expiresIn: this.ttlSeconds,
      issuer: this.issuer,
      subject,
    });
  }

  private verify(token: string, audience: string, secret: string): JwtPayload & { sub: string } {
    try {
      const payload = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        audience,
        issuer: this.issuer,
      });
      if (typeof payload === "string" || !isValidAccessPayload(payload)) {
        throw new UnauthorizedException("Access token claims are invalid");
      }
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException("Access token is invalid or expired");
    }
  }
}

function isValidAccessPayload(payload: JwtPayload): payload is JwtPayload & { sub: string } {
  return payload.tokenUse === "access" && typeof payload.sub === "string" && payload.sub.length > 0;
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredSecret(name: string): string {
  const value = requiredEnvironmentValue(name);
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

function accessTokenTtl(): number {
  const raw = requiredEnvironmentValue("ACCESS_TOKEN_TTL_SECONDS");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 86_400) {
    throw new Error("ACCESS_TOKEN_TTL_SECONDS must be an integer between 60 and 86400");
  }
  return value;
}
