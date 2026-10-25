import type { Prisma } from "@xhs-agentic/database";

export function eligibleMembershipParticipationWhere(
  now: Date,
): Prisma.EnterpriseMembershipWhereInput {
  return {
    OR: [
      { participation: null },
      { participation: { is: { status: "PARTICIPATING" } } },
      {
        participation: {
          is: {
            effectiveUntil: { lte: now },
            status: "PAUSED",
          },
        },
      },
    ],
  };
}
