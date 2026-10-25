import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { normalizePublicationUrl } from "../publication/publication-url";
import { PlatformSettingsReader } from "./platform-settings.reader";
import { isProductionCredential } from "./production-secret";
import { assertPublicationBrowserProductionReady } from "./publication-browser-production-gate";
import { isProductionHttpsEndpoint } from "./publication-policy-evidence";
import { PublicationReadbackConfigurationService } from "./publication-readback.configuration";
import { HttpPublicationVerificationAdapter } from "./publication-verification-adapter";

export {
  HttpPublicationVerificationAdapter,
  PublicationVerificationInvocationError,
  type PublicContentEvidence,
  type PublicContentImageEvidence,
  type PublicContentResolution,
} from "./publication-verification-adapter";

export type PublicationVerificationPolicy = Readonly<{
  imageSimilarityThreshold: number;
  manualReviewMargin: number;
  policyVersion: string;
  requireImageMatch: boolean;
  textSimilarityThreshold: number;
}>;

export type PublicationVerificationConfiguration = Readonly<{
  adapter: HttpPublicationVerificationAdapter | null;
  mode: "MANUAL" | "DEVELOPMENT" | "HTTP" | "BROWSER" | "READBACK";
  policy: PublicationVerificationPolicy;
}>;

@Injectable()
export class PlatformPublicationVerificationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(PublicationReadbackConfigurationService)
    private readonly readback: PublicationReadbackConfigurationService,
  ) {}

  async current(): Promise<PublicationVerificationConfiguration> {
    const rows = await this.settings.resolveMany([
      "publication.readback_enabled",
      "publication.endpoint",
      "publication.image_similarity_threshold",
      "publication.manual_review_margin",
      "publication.mode",
      "publication.policy_version",
      "publication.provider",
      "publication.require_image_match",
      "publication.text_similarity_threshold",
      "publication.timeout_ms",
    ]);
    const mode = stringValue(rows, "publication.mode");
    if (mode !== "MANUAL" && mode !== "DEVELOPMENT" && mode !== "HTTP" && mode !== "BROWSER") {
      throw new ConflictException("Publication-verification mode is invalid");
    }
    const policy = {
      imageSimilarityThreshold: scoreValue(rows, "publication.image_similarity_threshold"),
      manualReviewMargin: scoreValue(rows, "publication.manual_review_margin"),
      policyVersion: requiredString(rows, "publication.policy_version"),
      requireImageMatch: booleanValue(rows, "publication.require_image_match"),
      textSimilarityThreshold: scoreValue(rows, "publication.text_similarity_threshold"),
    };
    // Distributed readback replaces the synchronous HTTP/browser adapters.
    // Historical settings must not block new submissions while it is active.
    if (
      rows.get("publication.readback_enabled")?.value ??
      process.env.PUBLICATION_READBACK_ENABLED === "true"
    ) {
      const readback = await this.readback.runtime();
      return {
        adapter: null,
        mode: readback.externalMode || readback.verified ? "READBACK" : "MANUAL",
        policy,
      };
    }
    assertPublicationBrowserProductionReady(mode);
    if (mode === "MANUAL" || mode === "DEVELOPMENT" || mode === "BROWSER") {
      return { adapter: null, mode, policy };
    }
    const endpoint = requiredString(rows, "publication.endpoint");
    if (process.env.NODE_ENV === "production" && !isProductionHttpsEndpoint(endpoint)) {
      throw new ConflictException("Publication-verification Endpoint must be a public HTTPS URL");
    }
    const apiKey = required(
      (await this.settings.resolve("publication.api_key")).value,
      "publication.api_key",
    );
    if (process.env.NODE_ENV === "production" && !isProductionCredential(apiKey, 4)) {
      throw new ConflictException("Publication-verification API Key is a development placeholder");
    }
    return {
      adapter: new HttpPublicationVerificationAdapter({
        allowHttp: process.env.NODE_ENV !== "production",
        apiKey,
        endpoint,
        provider: requiredString(rows, "publication.provider"),
        timeoutMs: integerValue(rows, "publication.timeout_ms"),
      }),
      mode,
      policy,
    };
  }

  async test(url: string, reason: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ConflictException("Publication-verification testing requires platform scope");
    }
    const configuration = await this.current();
    if (!configuration.adapter) {
      throw new ConflictException({
        code: "PUBLICATION_VERIFICATION_NOT_CONFIGURED",
        message: "请先完成发布验真服务配置并将模式切换为 HTTP",
      });
    }
    const normalized = normalizePublicationUrl(url);
    if (normalized.classification === "OTHER" || normalized.classification === "DEV_FIXTURE") {
      throw new ConflictException("验真连通测试只接受小红书公开链接或短链接");
    }
    const startedAt = Date.now();
    const result = await configuration.adapter.resolve(normalized.normalizedUrl, randomUUID());
    await this.prisma.auditLog.create({
      data: {
        action: "platform-setting.publication-verification-test",
        actorType: "USER",
        actorUserId: principal.userId,
        metadata: {
          available: result.available,
          latencyMs: Date.now() - startedAt,
          policyVersion: configuration.policy.policyVersion,
          provider: configuration.adapter.providerCode,
        },
        reason,
        resourceId: "publication-verification",
        resourceType: "PlatformSettingGroup",
      },
    });
    return {
      available: result.available,
      checkedAt: new Date().toISOString(),
      imageCount: result.available ? result.evidence.images.length : 0,
      latencyMs: Date.now() - startedAt,
      policyVersion: configuration.policy.policyVersion,
      provider: configuration.adapter.providerCode,
    };
  }
}

function stringValue(
  rows: ReadonlyMap<string, Readonly<{ value: boolean | number | string | null }>>,
  key: string,
): string | null {
  const value = rows.get(key)?.value;
  return typeof value === "string" ? value : null;
}

function requiredString(
  rows: ReadonlyMap<string, Readonly<{ value: boolean | number | string | null }>>,
  key: string,
): string {
  return required(stringValue(rows, key), key);
}

function booleanValue(
  rows: ReadonlyMap<string, Readonly<{ value: boolean | number | string | null }>>,
  key: string,
): boolean {
  const value = rows.get(key)?.value;
  if (typeof value !== "boolean") throw new ConflictException(`${key} is not configured`);
  return value;
}

function integerValue(
  rows: ReadonlyMap<string, Readonly<{ value: boolean | number | string | null }>>,
  key: string,
): number {
  const value = rows.get(key)?.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConflictException(`${key} is not configured`);
  }
  return value;
}

function scoreValue(
  rows: ReadonlyMap<string, Readonly<{ value: boolean | number | string | null }>>,
  key: string,
): number {
  const value = rows.get(key)?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConflictException(`${key} must be between 0 and 1`);
  }
  return value;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConflictException(`${label} is not configured`);
  }
  return value.trim();
}
