import { SetMetadata } from "@nestjs/common";
import type { PermissionCode } from "./permission-catalog";

export const ADMIN_ACCESS_REQUIREMENT = Symbol("ADMIN_ACCESS_REQUIREMENT");

export type AdminRouteScope = "PLATFORM" | "TENANT" | "ENTERPRISE";

export type AdminAccessRequirement = Readonly<{
  scope: AdminRouteScope;
  permissions: readonly PermissionCode[];
}>;

export function RequireAdminAccess(
  scope: AdminRouteScope,
  ...permissions: readonly PermissionCode[]
): MethodDecorator & ClassDecorator {
  if (permissions.length === 0) {
    throw new Error("Admin routes must require at least one permission");
  }
  return SetMetadata(ADMIN_ACCESS_REQUIREMENT, Object.freeze({ permissions, scope }));
}
