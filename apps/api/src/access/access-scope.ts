import type { Prisma } from "@xhs-agentic/database";

export type PlatformAccessScope = Readonly<{
  type: "PLATFORM";
}>;

export type TenantAccessScope = Readonly<{
  type: "TENANT";
  tenantId: string;
}>;

export type EnterpriseAccessScope = Readonly<{
  type: "ENTERPRISE";
  tenantId: string;
  enterpriseId: string;
}>;

export type AccessScope = PlatformAccessScope | TenantAccessScope | EnterpriseAccessScope;

export type PersistedAccessScope = Readonly<{
  scopeType: AccessScope["type"];
  scopeId: string;
  tenantId: string | null;
  enterpriseId: string | null;
}>;

export function platformAccessScope(): PlatformAccessScope {
  return Object.freeze({ type: "PLATFORM" });
}

export function tenantAccessScope(tenantId: string): TenantAccessScope {
  return Object.freeze({ type: "TENANT", tenantId: requiredIdentifier(tenantId, "tenantId") });
}

export function enterpriseAccessScope(
  tenantId: string,
  enterpriseId: string,
): EnterpriseAccessScope {
  return Object.freeze({
    enterpriseId: requiredIdentifier(enterpriseId, "enterpriseId"),
    tenantId: requiredIdentifier(tenantId, "tenantId"),
    type: "ENTERPRISE",
  });
}

export function tenantWhere(scope: AccessScope): Prisma.TenantWhereInput {
  if (scope.type === "PLATFORM") {
    return {};
  }
  return { id: scope.tenantId };
}

export function enterpriseWhere(scope: AccessScope): Prisma.EnterpriseWhereInput {
  switch (scope.type) {
    case "PLATFORM":
      return {};
    case "TENANT":
      return { tenantId: scope.tenantId };
    case "ENTERPRISE":
      return { id: scope.enterpriseId, tenantId: scope.tenantId };
  }
}

export function membershipWhere(scope: AccessScope): Prisma.EnterpriseMembershipWhereInput {
  switch (scope.type) {
    case "PLATFORM":
      return {};
    case "TENANT":
      return { tenantId: scope.tenantId };
    case "ENTERPRISE":
      return { enterpriseId: scope.enterpriseId, tenantId: scope.tenantId };
  }
}

export function roleBindingWhere(scope: AccessScope): Prisma.RoleBindingWhereInput {
  switch (scope.type) {
    case "PLATFORM":
      return {};
    case "TENANT":
      return { tenantId: scope.tenantId };
    case "ENTERPRISE":
      return { enterpriseId: scope.enterpriseId, tenantId: scope.tenantId };
  }
}

export function persistedAccessScope(scope: AccessScope): PersistedAccessScope {
  switch (scope.type) {
    case "PLATFORM":
      return {
        enterpriseId: null,
        scopeId: "platform",
        scopeType: "PLATFORM",
        tenantId: null,
      };
    case "TENANT":
      return {
        enterpriseId: null,
        scopeId: scope.tenantId,
        scopeType: "TENANT",
        tenantId: scope.tenantId,
      };
    case "ENTERPRISE":
      return {
        enterpriseId: scope.enterpriseId,
        scopeId: scope.enterpriseId,
        scopeType: "ENTERPRISE",
        tenantId: scope.tenantId,
      };
  }
}

export function canAdministerScope(actor: AccessScope, target: AccessScope): boolean {
  if (actor.type === "PLATFORM") {
    return true;
  }
  if (target.type === "PLATFORM") {
    return false;
  }
  if (actor.type === "TENANT") {
    return actor.tenantId === target.tenantId;
  }
  return (
    target.type === "ENTERPRISE" &&
    actor.tenantId === target.tenantId &&
    actor.enterpriseId === target.enterpriseId
  );
}

function requiredIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
}
