import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@xhs-agentic/database";
import { PrismaService } from "../database/prisma.service";

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

export type TenantCapability = Readonly<{
  geoEnabled: boolean;
  geoEntityLimit: number;
  geoLevel: "ADVANCED" | "BASIC" | "STANDARD";
  geoTopicLimit: number;
  groupSharedMaterialsEnabled: boolean;
  imagesPerDistribution: number;
  maxEnterprises: number | null;
  metricsIntegrationEnabled: boolean;
  storageQuotaBytes: bigint;
}>;

@Injectable()
export class TenantCapabilityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async current(
    tenantId: string,
    client: PrismaClientLike = this.prisma,
  ): Promise<TenantCapability> {
    const policy = await client.tenantCapabilityPolicy.upsert({
      create: { tenantId },
      update: {},
      where: { tenantId },
    });
    return {
      geoEnabled: policy.geoEnabled,
      geoEntityLimit: policy.geoEntityLimit,
      geoLevel: capabilityGeoLevel(policy.geoEnabled, policy.geoEntityLimit, policy.geoTopicLimit),
      geoTopicLimit: policy.geoTopicLimit,
      groupSharedMaterialsEnabled: policy.groupSharedMaterialsEnabled,
      imagesPerDistribution: policy.maxImagesPerContent,
      maxEnterprises: policy.maxEnterprises,
      metricsIntegrationEnabled: policy.metricsIntegrationEnabled,
      storageQuotaBytes: policy.storageLimitBytes,
    };
  }

  async assertEnterpriseCapacity(
    tenantId: string,
    additionalEnterprises = 1,
    client: PrismaClientLike = this.prisma,
  ): Promise<void> {
    const capability = await this.current(tenantId, client);
    if (capability.maxEnterprises === null) return;
    const active = await client.enterprise.count({ where: { status: "ACTIVE", tenantId } });
    if (active + additionalEnterprises > capability.maxEnterprises) {
      throw new ConflictException({
        code: "TENANT_ENTERPRISE_SAFETY_LIMIT_EXCEEDED",
        details: {
          active,
          limit: capability.maxEnterprises,
          requested: active + additionalEnterprises,
        },
        message: "The tenant enterprise safety limit would be exceeded",
      });
    }
  }

  async assertEnterpriseCapacityIfConfigured(
    tenantId: string,
    additionalEnterprises = 1,
    client: PrismaClientLike = this.prisma,
  ): Promise<void> {
    return this.assertEnterpriseCapacity(tenantId, additionalEnterprises, client);
  }

  assertImagesPerContent(capability: TenantCapability, requested: number): void {
    if (requested < 1 || requested > capability.imagesPerDistribution) {
      throw new ConflictException({
        code: "TENANT_IMAGE_COUNT_LIMIT_EXCEEDED",
        details: { limit: capability.imagesPerDistribution, requested },
        message: "The configured image count per employee would be exceeded",
      });
    }
  }

  requireGroupSharedMaterials(capability: TenantCapability): void {
    if (!capability.groupSharedMaterialsEnabled) {
      throw new ForbiddenException({
        code: "TENANT_GROUP_SHARED_MATERIALS_DISABLED",
        message: "Group shared materials are disabled for this tenant",
      });
    }
  }

  async requireMetricsIntegration(
    tenantId: string,
    client: PrismaClientLike = this.prisma,
  ): Promise<void> {
    const capability = await this.current(tenantId, client);
    if (!capability.metricsIntegrationEnabled) {
      throw new ForbiddenException({
        code: "TENANT_METRICS_INTEGRATION_DISABLED",
        message: "Metrics integration is disabled for this tenant",
      });
    }
  }

  async requireGeoEnabled(
    tenantId: string,
    client: PrismaClientLike = this.prisma,
  ): Promise<TenantCapability["geoLevel"]> {
    const capability = await this.current(tenantId, client);
    if (!capability.geoEnabled) {
      throw new ForbiddenException({
        code: "TENANT_GEO_DISABLED",
        message: "GEO features are disabled for this tenant",
      });
    }
    return capability.geoLevel;
  }

  async assertGeoSeriesCapacity(
    tenantId: string,
    resource: "ENTITY" | "TOPIC",
    additionalSeries = 1,
    client: PrismaClientLike = this.prisma,
  ): Promise<void> {
    const capability = await this.current(tenantId, client);
    if (!capability.geoEnabled) {
      throw new ForbiddenException({ code: "TENANT_GEO_DISABLED", message: "GEO is disabled" });
    }
    const active =
      resource === "ENTITY"
        ? (
            await client.geoEntity.findMany({
              distinct: ["seriesId"],
              select: { seriesId: true },
              where: { status: "ACTIVE", tenantId },
            })
          ).length
        : (
            await client.geoTopic.findMany({
              distinct: ["seriesId"],
              select: { seriesId: true },
              where: { status: "ACTIVE", tenantId },
            })
          ).length;
    const limit = resource === "ENTITY" ? capability.geoEntityLimit : capability.geoTopicLimit;
    if (active + additionalSeries > limit) {
      throw new ConflictException({
        code:
          resource === "ENTITY"
            ? "TENANT_GEO_ENTITY_LIMIT_EXCEEDED"
            : "TENANT_GEO_TOPIC_LIMIT_EXCEEDED",
        details: { active, limit, requested: active + additionalSeries },
        message: `The configured GEO ${resource.toLowerCase()} limit would be exceeded`,
      });
    }
  }
}

export function capabilityAllowsImageCount(
  capability: Pick<TenantCapability, "imagesPerDistribution">,
  requested: number,
): boolean {
  return requested >= 1 && requested <= capability.imagesPerDistribution;
}

function capabilityGeoLevel(
  enabled: boolean,
  entityLimit: number,
  topicLimit: number,
): TenantCapability["geoLevel"] {
  if (!enabled || entityLimit <= 20 || topicLimit <= 100) return "BASIC";
  if (entityLimit <= 100 || topicLimit <= 1_000) return "STANDARD";
  return "ADVANCED";
}
