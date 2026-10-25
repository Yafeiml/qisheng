import {
  ROUTE_RUNTIME_FAILURE,
  ROUTE_RUNTIME_FAILURE_THRESHOLD,
  ROUTE_RUNTIME_RESOURCE,
  ROUTE_RUNTIME_SUCCESS,
  summarizeRouteRuntimeHealth,
} from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";

export async function readRouteRuntimeHealth(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  input: {
    routeId: string;
    configurationFingerprint: string;
    deliveryMode: "DEVELOPMENT" | "PRODUCTION";
    qualifiedAt: Date;
    requiredCapabilities?: readonly ("TEXT" | "IMAGE")[];
    configurationFingerprints?: readonly string[];
  },
) {
  const capabilities = input.requiredCapabilities ?? (["TEXT", "IMAGE"] as const);
  const outcomes = await Promise.all(
    capabilities.map((capability) =>
      client.auditLog.findMany({
        select: { action: true, createdAt: true },
        where: {
          resourceType: ROUTE_RUNTIME_RESOURCE,
          resourceId: input.routeId,
          action: { in: [ROUTE_RUNTIME_SUCCESS, ROUTE_RUNTIME_FAILURE] },
          createdAt: { gt: input.qualifiedAt },
          AND: [
            input.configurationFingerprints
              ? {
                  OR: [...new Set(input.configurationFingerprints)].map((fingerprint) => ({
                    metadata: { path: ["configurationFingerprint"], equals: fingerprint },
                  })),
                }
              : {
                  metadata: {
                    path: ["configurationFingerprint"],
                    equals: input.configurationFingerprint,
                  },
                },
            { metadata: { path: ["deliveryMode"], equals: input.deliveryMode } },
            { metadata: { path: ["capability"], equals: capability } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: ROUTE_RUNTIME_FAILURE_THRESHOLD,
      }),
    ),
  );
  return summarizeRouteRuntimeHealth(
    outcomes[capabilities.indexOf("TEXT")] ?? [],
    outcomes[capabilities.indexOf("IMAGE")] ?? [],
  );
}
