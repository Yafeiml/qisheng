import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import {
  generationDeliveryMode,
  ModelCredentialCipher,
  modelCredentialAssociatedData,
} from "@xhs-agentic/ai-gateway";
import {
  CONTENT_SAFETY_POLICY_VERSION,
  type ContentSafetyConfiguration,
  ContentSafetyInvocationError,
  type ContentSafetyScanner,
  contentSafetyFingerprint,
  createContentSafetyScanner,
  probeContentSafety,
} from "@xhs-agentic/content-safety";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type { SaveContentSafetySettingsDto } from "./content-safety-settings.dto";
import { platformSettingDefinition } from "./platform-setting-catalog";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import { PlatformSettingsReader, type ResolvedPlatformSetting } from "./platform-settings.reader";

const keys = [
  "content_safety.api_key",
  "content_safety.endpoint",
  "content_safety.mode",
  "content_safety.provider",
  "content_safety.timeout_ms",
  "content_safety.model_provider_id",
  "content_safety.model",
] as const;
export type PlatformContentSafetyConfiguration = Readonly<{
  configured: boolean;
  mode: ContentSafetyConfiguration["mode"];
  scanner?: ContentSafetyScanner;
  fingerprint: string;
  verified: boolean;
  checkedAt: string | null;
}>;

@Injectable()
export class PlatformContentSafetyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(PlatformSettingCrypto) private readonly crypto: PlatformSettingCrypto,
  ) {}
  async current(): Promise<PlatformContentSafetyConfiguration> {
    const configuration = await this.resolve(await this.settings.resolveMany(keys));
    const scanner = createContentSafetyScanner(
      configuration,
      process.env.NODE_ENV === "production",
    );
    const fingerprint = contentSafetyFingerprint(configuration);
    const receipt =
      configuration.mode === "DISABLED"
        ? null
        : await this.prisma.auditLog.findFirst({
            where: {
              action: "platform-setting.content-safety-test",
              resourceId: "content-safety",
              metadata: { path: ["configurationFingerprint"], equals: fingerprint },
            },
            orderBy: { createdAt: "desc" },
            select: { metadata: true, createdAt: true },
          });
    const verified = Boolean(
      receipt?.metadata &&
        typeof receipt.metadata === "object" &&
        !Array.isArray(receipt.metadata) &&
        receipt.metadata.success === true,
    );
    return {
      configured: !!scanner,
      mode: configuration.mode,
      scanner,
      fingerprint,
      verified,
      checkedAt: receipt?.createdAt.toISOString() ?? null,
    };
  }
  async configuration() {
    this.requirePlatform();
    const rows = await this.settings.resolveMany(keys);
    const providers = await this.prisma.modelProvider.findMany({
      where: {
        status: "ACTIVE",
        synthetic: false,
        protocol: "OPENAI_COMPATIBLE",
        activeCredential: { status: "ACTIVE" },
      },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    });
    let status: Pick<PlatformContentSafetyConfiguration, "verified" | "checkedAt"> = {
      verified: false,
      checkedAt: null,
    };
    try {
      status = await this.current();
    } catch {
      /* Incomplete settings remain editable. */
    }
    return {
      mode: text(rows, "mode") || "DISABLED",
      modelProviderId: text(rows, "model_provider_id"),
      model: text(rows, "model"),
      provider: text(rows, "provider"),
      endpoint: text(rows, "endpoint"),
      apiKeyConfigured: !!text(rows, "api_key"),
      timeoutMs: Number(rows.get("content_safety.timeout_ms")?.value ?? 30000),
      providers: providers
        .filter(
          (provider) =>
            !(
              (provider.name === "Sprint 6 Real Qualification Provider" &&
                /^S6_REAL_[A-F0-9]+$/u.test(provider.code)) ||
              (/^REAL_[A-F0-9]+$/u.test(provider.code) &&
                provider.name === `Runtime Provider ${provider.code.slice(5)}`)
            ),
        )
        .map(({ id, name }) => ({ id, name })),
      verified: status.verified,
      checkedAt: status.checkedAt,
    };
  }
  async save(input: SaveContentSafetySettingsDto) {
    const principal = this.requirePlatform();
    if (input.mode === "DISABLED" && generationDeliveryMode() === "PRODUCTION")
      throw new ConflictException("生产交付不能关闭内容审核");
    const current = await this.settings.resolveMany(keys);
    const changes: Record<string, string | number> = {
      mode: input.mode,
      timeout_ms: input.timeoutMs,
    };
    if (input.mode === "MODEL")
      Object.assign(changes, {
        model_provider_id: input.modelProviderId?.trim() ?? "",
        model: input.model?.trim() ?? "",
      });
    if (input.mode === "HTTP")
      Object.assign(changes, {
        endpoint: input.endpoint?.trim() ?? "",
        provider: input.provider?.trim() ?? "",
        ...(input.apiKey ? { api_key: input.apiKey } : {}),
      });
    for (const [key, value] of Object.entries(changes))
      current.set(`content_safety.${key}`, {
        ...current.get(`content_safety.${key}`),
        value,
      } as ResolvedPlatformSetting);
    const configuration = await this.resolve(current);
    createContentSafetyScanner(configuration, process.env.NODE_ENV === "production");
    await this.prisma.$transaction(async (transaction) => {
      for (const [suffix, value] of Object.entries(changes)) {
        const key = `content_safety.${suffix}`;
        const definition = platformSettingDefinition(key);
        if (!definition) throw new Error("Unknown content-safety setting");
        const secret =
          definition.valueType === "SECRET" ? this.crypto.encrypt(String(value), key) : null;
        const data = {
          group: definition.group,
          valueType: definition.valueType,
          updatedBy: principal.userId,
          value: secret ? Prisma.DbNull : value,
          ciphertext: secret ? Buffer.from(secret.ciphertext) : null,
          authenticationTag: secret ? Buffer.from(secret.authenticationTag) : null,
          initializationVector: secret ? Buffer.from(secret.initializationVector) : null,
          keyVersion: secret?.keyVersion ?? null,
          secretLastFour: secret?.secretLastFour ?? null,
        };
        await transaction.platformSetting.upsert({
          where: { key },
          create: { key, ...data },
          update: { ...data, version: { increment: 1 } },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: "platform-setting.content-safety.save",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceType: "PlatformSettingGroup",
          resourceId: "content-safety",
          reason: "保存图文内容审核配置",
          stateAfter: { mode: input.mode, changedKeys: Object.keys(changes) },
        },
      });
    });
    return this.configuration();
  }
  async readiness() {
    const required = generationDeliveryMode() === "PRODUCTION";
    try {
      const config = await this.current();
      return {
        configured: config.configured && (!required || config.verified),
        verified: config.verified,
        required,
        mode: config.mode,
      };
    } catch {
      return { configured: false, verified: false, required, mode: "DISABLED" as const };
    }
  }
  async test(reason: string) {
    return this.testAndRecord(reason, this.requirePlatform().userId);
  }
  // Server-side operational verification uses SYSTEM audit attribution, never a fabricated user.
  async verifyForOperations(reason: string) {
    return this.testAndRecord(reason);
  }
  private async testAndRecord(reason: string, actorUserId?: string) {
    const configuration = await this.current();
    if (!configuration.scanner) throw new ConflictException("请先保存模型或独立审核服务配置");
    let success = false;
    let result: Awaited<ReturnType<typeof probeContentSafety>> | undefined;
    let failure: ReturnType<typeof testFailure> | undefined;
    try {
      result = await probeContentSafety(configuration.scanner, configuration.mode === "MODEL");
      if ((await this.current()).fingerprint !== configuration.fingerprint)
        throw new ContentSafetyInvocationError(
          "测试期间配置已变化，请重新测试",
          "CONTENT_SAFETY_CONFIGURATION_CHANGED",
          false,
        );
      success = true;
    } catch (error) {
      failure = testFailure(error);
    }
    let auditId: string;
    try {
      const receipt = await this.prisma.auditLog.create({
        data: {
          action: "platform-setting.content-safety-test",
          actorType: actorUserId ? "USER" : "SYSTEM",
          actorUserId,
          reason,
          resourceId: "content-safety",
          resourceType: "PlatformSettingGroup",
          metadata: {
            configurationFingerprint: configuration.fingerprint,
            success,
            policyVersion: CONTENT_SAFETY_POLICY_VERSION,
            mode: configuration.mode,
            imageRiskDetected: result?.imageRiskDetected ?? false,
            ...(failure ? { failure } : {}),
            ...(result
              ? {
                  categoryCount: result.categories.length,
                  decision: result.decision,
                  latencyMs: result.latencyMs,
                  model: result.model ?? null,
                  provider: result.provider,
                  providerRequestId: result.providerRequestId,
                }
              : {}),
          },
        },
        select: { id: true },
      });
      auditId = receipt.id;
    } catch {
      throw new ConflictException({
        code: "CONTENT_SAFETY_TEST_AUDIT_FAILED",
        message: "审核测试结果无法写入审计，当前配置未验证",
        auditId: null,
        ...(failure ? { failure } : {}),
      });
    }
    if (failure)
      throw new ConflictException({
        code: failure.code,
        message: failureMessage(failure.code),
        auditId,
        failure,
      });
    if (!result) throw new ConflictException("审核测试失败");
    return {
      categoryCount: result.categories.length,
      checkedAt: result.checkedAt,
      decision: result.decision,
      latencyMs: result.latencyMs,
      provider: result.provider,
      imageRiskDetected: result.imageRiskDetected,
    };
  }
  private async resolve(
    rows: ReadonlyMap<string, ResolvedPlatformSetting>,
  ): Promise<ContentSafetyConfiguration> {
    const mode = text(rows, "mode");
    const timeoutMs = Number(rows.get("content_safety.timeout_ms")?.value ?? 30000);
    if (mode === "DISABLED") return { mode };
    if (mode === "HTTP")
      return {
        mode,
        timeoutMs,
        apiKey: text(rows, "api_key"),
        endpoint: text(rows, "endpoint"),
        provider: text(rows, "provider"),
      };
    if (mode !== "MODEL") throw new ConflictException("内容审核模式无效");
    const providerId = text(rows, "model_provider_id");
    const model = text(rows, "model");
    if (!providerId || !model) throw new ConflictException("请选择审核供应商和支持图片理解的模型");
    const provider = await this.prisma.modelProvider.findUnique({
      where: { id: providerId },
      include: { activeCredential: true },
    });
    if (
      provider?.status !== "ACTIVE" ||
      provider.synthetic ||
      provider.protocol !== "OPENAI_COMPATIBLE" ||
      provider.activeCredential?.status !== "ACTIVE"
    )
      throw new ConflictException("审核供应商不可用，请检查启用状态和 API Key");
    const apiKey = ModelCredentialCipher.fromEnvironment().decrypt(
      provider.activeCredential,
      modelCredentialAssociatedData(provider.id, provider.activeCredential.id),
    );
    return { mode, timeoutMs, model, apiKey, endpoint: provider.baseUrl, provider: provider.code };
  }
  private requirePlatform() {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM")
      throw new ForbiddenException("仅平台管理员可以配置内容审核");
    return principal;
  }
}
function text(rows: ReadonlyMap<string, ResolvedPlatformSetting>, suffix: string): string {
  const value = rows.get(`content_safety.${suffix}`)?.value;
  return typeof value === "string" ? value.trim() : "";
}

const failureMessages: Readonly<Record<string, string>> = {
  CONTENT_SAFETY_PROBE_FAILED: "审核模型未通过中性图文测试",
  CONTENT_SAFETY_VISION_PROBE_FAILED:
    "审核模型未识别测试图片中的危险医疗宣传，请选择支持图像理解的模型",
  CONTENT_SAFETY_CONFIGURATION_CHANGED: "测试期间配置已变化，请重新测试",
  CONTENT_SAFETY_DNS_FAILED: "审核服务域名解析失败",
  CONTENT_SAFETY_TIMEOUT: "审核服务响应超时",
  CONTENT_SAFETY_NETWORK: "审核服务连接失败",
  CONTENT_SAFETY_INVALID_RESPONSE: "审核服务未返回有效且完整的图文审核结果",
  CONTENT_SAFETY_RESPONSE_TOO_LARGE: "审核服务返回结果过大",
  CONTENT_SAFETY_INPUT_INVALID: "图文审核测试输入无效",
  CONTENT_SAFETY_PROBE_ERROR: "图文审核测试请求失败",
  CONTENT_SAFETY_TEST_FAILED: "审核测试失败，请检查测试审计",
};
function failureMessage(code: string) {
  const httpStatus = /^CONTENT_SAFETY_HTTP_([1-5]\d{2})$/u.exec(code)?.[1];
  return httpStatus
    ? `审核服务请求失败（HTTP ${httpStatus}）`
    : (failureMessages[code] ?? failureMessages.CONTENT_SAFETY_TEST_FAILED);
}
function testFailure(error: unknown) {
  const invocation = error instanceof ContentSafetyInvocationError ? error : undefined;
  const code =
    invocation &&
    (Object.hasOwn(failureMessages, invocation.code) ||
      /^CONTENT_SAFETY_HTTP_[1-5]\d{2}$/u.test(invocation.code))
      ? invocation.code
      : "CONTENT_SAFETY_TEST_FAILED";
  const context = invocation?.context;
  return {
    code,
    retryable: invocation?.retryable === true,
    probeStage:
      context?.probeStage === "neutral" || context?.probeStage === "image-risk"
        ? context.probeStage
        : null,
    decision:
      context?.decision === "PASS" ||
      context?.decision === "REVIEW" ||
      context?.decision === "BLOCK"
        ? context.decision
        : null,
    httpStatus:
      Number.isInteger(context?.httpStatus) &&
      (context?.httpStatus ?? 0) >= 100 &&
      (context?.httpStatus ?? 0) <= 599
        ? context?.httpStatus
        : null,
    providerRequestId:
      typeof context?.providerRequestId === "string" &&
      /^[A-Za-z0-9_.:-]{1,200}$/u.test(context.providerRequestId)
        ? context.providerRequestId
        : null,
  };
}
