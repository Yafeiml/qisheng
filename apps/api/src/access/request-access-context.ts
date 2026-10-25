import { ConflictException, Injectable, Scope, UnauthorizedException } from "@nestjs/common";
import type { AccessScope } from "./access-scope";

export type SaasAdminPrincipal = Readonly<{
  audience: "SAAS_ADMIN";
  userId: string;
  scope: AccessScope;
  permissions: readonly string[];
}>;

export type EmployeePrincipal = Readonly<{
  audience: "EMPLOYEE";
  userId: string;
  membershipIds: readonly string[];
}>;

export type AuthenticatedPrincipal = SaasAdminPrincipal | EmployeePrincipal;

@Injectable({ scope: Scope.REQUEST })
export class RequestAccessContext {
  private principal: AuthenticatedPrincipal | undefined;

  currentPrincipal(): AuthenticatedPrincipal | undefined {
    return this.principal;
  }

  initialize(principal: AuthenticatedPrincipal): void {
    if (this.principal) {
      throw new ConflictException("Request access context has already been initialized");
    }
    this.principal = Object.freeze(principal);
  }

  requirePrincipal(): AuthenticatedPrincipal {
    if (!this.principal) {
      throw new UnauthorizedException("Request has no authenticated principal");
    }
    return this.principal;
  }

  requireSaasAdmin(): SaasAdminPrincipal {
    const principal = this.requirePrincipal();
    if (principal.audience !== "SAAS_ADMIN") {
      throw new UnauthorizedException("Employee credentials cannot access SaaS resources");
    }
    return principal;
  }

  requireEmployee(): EmployeePrincipal {
    const principal = this.requirePrincipal();
    if (principal.audience !== "EMPLOYEE") {
      throw new UnauthorizedException("SaaS credentials cannot access employee resources");
    }
    return principal;
  }
}
