import type { Prisma } from "@xhs-agentic/database";

export const activeAdminRoleBindingWhere = {
  OR: [
    { scopeType: "PLATFORM" },
    {
      scopeType: "TENANT",
      tenant: { is: { status: "ACTIVE" } },
    },
    {
      enterprise: { is: { status: "ACTIVE" } },
      scopeType: "ENTERPRISE",
      tenant: { is: { status: "ACTIVE" } },
    },
  ],
  role: { status: "ACTIVE" },
} satisfies Prisma.RoleBindingWhereInput;
