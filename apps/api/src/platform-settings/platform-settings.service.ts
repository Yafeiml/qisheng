import { createHash, randomUUID } from "node:crypto";
import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import {
  type ObjectStorageLifecycleState,
  StorageManagementError,
} from "@xhs-agentic/object-storage";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type { UpdateRuntimePolicyDto } from "../model-configuration/runtime-policy.dto";
import { RuntimePolicyService } from "../model-configuration/runtime-policy.service";
import { readAliyunSmsConfiguration } from "./admin-sms.configuration";
import { normalizeCapEndpoint } from "./cap-endpoint";
import {
  materialNotificationKeys,
  smsMaterialNotificationKeys,
  validateMaterialNotificationConfiguration,
} from "./material-notification.configuration";
import { miniappDebugKeys, validateMiniappDebugConfiguration } from "./miniapp-debug-settings";
import { normalizePlatformLogo } from "./platform-branding";
import { PlatformObjectStorageService, storageReadUrl } from "./platform-object-storage.service";
import {
  type PlatformSettingDefinition,
  type PlatformSettingScalar,
  platformSettingCatalog,
  platformSettingDefinition,
  platformSettingGroups,
  type RuntimePolicyField,
} from "./platform-setting-catalog";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import { validatePlatformSettingValue } from "./platform-setting-values";
import type {
  SaveMiniappDebugSettingsDto,
  UpdatePlatformSettingDto,
} from "./platform-settings.dto";
import { PlatformSettingsReader, type ResolvedPlatformSetting } from "./platform-settings.reader";
import { isProductionCredential, isProductionRandomSecret } from "./production-secret";
import { assertPublicationBrowserProductionReady } from "./publication-browser-production-gate";
import { isProductionHttpsEndpoint } from "./publication-policy-evidence";
import { readbackSettingKeys } from "./publication-readback.configuration";
import { wechatNotificationKeys } from "./wechat-notification.configuration";

@Injectable()
export class PlatformSettingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(PlatformSettingsReader) private readonly reader: PlatformSettingsReader,
    @Inject(PlatformSettingCrypto) private readonly crypto: PlatformSettingCrypto,
    @Inject(RuntimePolicyService) private readonly runtimePolicy: RuntimePolicyService,
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
  ) {}

  async list() {
    this.requirePlatformAdministrator();
    const databaseDefinitions = platformSettingCatalog.filter(
      ({ store }) => store === "PLATFORM_SETTING",
    );
    const [resolved, policy, embeddingModels] = await Promise.all([
      this.reader.resolveMany(databaseDefinitions.map(({ key }) => key)),
      this.runtimePolicy.current(),
      this.prisma.modelDefinition.findMany({
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
        select: {
          capabilities: true,
          displayName: true,
          id: true,
          provider: { select: { name: true } },
        },
        where: {
          capabilities: { hasSome: ["EMBEDDING", "TEXT", "VISION", "MULTIMODAL"] },
          provider: { status: "ACTIVE", synthetic: false },
          status: "ACTIVE",
          synthetic: false,
        },
      }),
    ]);
    const settings = platformSettingCatalog.map((definition) =>
      definition.store === "RUNTIME_POLICY"
        ? runtimeSettingItem(definition, policy, embeddingModels)
        : databaseSettingItem(definition, requireResolved(resolved, definition.key)),
    );
    return {
      groups: platformSettingGroups.map((group) => {
        const groupSettings = settings.filter((setting) => setting.group === group.group);
        return {
          ...group,
          configuredCount: groupSettings.filter(({ configured }) => configured).length,
          settings: groupSettings,
          totalCount: groupSettings.length,
        };
      }),
    };
  }

  async update(key: string, input: UpdatePlatformSettingDto) {
    const principal = this.requirePlatformAdministrator();
    if (readbackSettingKeys.some((item) => item === key))
      throw new ConflictException("自动回读配置必须在发布回读页面一起保存和验证");
    if (miniappDebugKeys.some((item) => item === key)) {
      throw new ConflictException("小程序调试参数必须在小程序设置中一起保存");
    }
    const definition = platformSettingDefinition(key);
    if (!definition) {
      throw new NotFoundException({
        code: "PLATFORM_SETTING_UNKNOWN",
        key,
        message: "Platform setting is not registered",
      });
    }
    const value = validatePlatformSettingValue(
      definition,
      key === "general.platform_logo" ? await normalizePlatformLogo(input.value) : input.value,
    );
    if (definition.store === "RUNTIME_POLICY") {
      if (!definition.runtimeField)
        throw new Error(`Runtime field is missing for ${definition.key}`);
      await this.runtimePolicy.update(
        runtimePolicyUpdate(definition.runtimeField, value, input.reason),
      );
    } else {
      if (value === null) {
        throw new ConflictException("Database-backed platform settings cannot be saved as null");
      }
      await this.validateCrossSettingRules(definition, value);
      const before = await this.reader.resolve(definition.key);
      const secret =
        definition.valueType === "SECRET" ? this.crypto.encrypt(String(value), key) : null;
      const updated = await this.prisma.$transaction(async (transaction) => {
        if (definition.key === "storage.provider") {
          const current = await this.reader.resolveMany(["storage.provider"], transaction);
          if (current.get("storage.provider")?.value !== value)
            await assertStorageSwitchIsEmpty(transaction);
        }
        const notificationSettings = materialNotificationKeys.includes(definition.key)
          ? await this.reader.resolveMany(materialNotificationKeys, transaction)
          : null;
        if (notificationSettings) {
          if (
            notificationSettings.get("notification.enabled")?.value === true &&
            notificationSettings.get("notification.channel")?.value === "WECHAT_TEMPLATE" &&
            definition.key === "miniapp.wechat_app_id" &&
            notificationSettings.get(definition.key)?.value !== value
          )
            throw new ConflictException(
              "请先关闭任务通知，再切换小程序 AppID；员工需在新小程序中重新连接微信并订阅。",
            );
          const existing = notificationSettings.get(definition.key);
          if (existing) notificationSettings.set(definition.key, { ...existing, value });
          if (notificationSettings.get("notification.enabled")?.value === true)
            validateMaterialNotificationConfiguration(notificationSettings);
        }
        if (definition.key === "notification.enabled" && value === true) {
          if (!notificationSettings) throw new Error("Notification settings are missing");
          const dependencyKeys =
            notificationSettings.get("notification.channel")?.value === "ALIYUN_SMS"
              ? smsMaterialNotificationKeys
              : wechatNotificationKeys;
          for (const dependencyKey of dependencyKeys) {
            const dependency = platformSettingDefinition(dependencyKey);
            const resolvedValue = notificationSettings.get(dependencyKey)?.value;
            if (
              !dependency ||
              dependency.valueType === "SECRET" ||
              dependencyKey === "notification.enabled" ||
              resolvedValue === null ||
              resolvedValue === undefined
            )
              continue;
            await transaction.platformSetting.upsert({
              where: { key: dependencyKey },
              create: {
                key: dependencyKey,
                group: dependency.group,
                valueType: dependency.valueType,
                value: resolvedValue as Prisma.InputJsonValue,
                updatedBy: principal.userId,
              },
              update: {},
            });
          }
        }
        const row = await transaction.platformSetting.upsert({
          create: {
            authenticationTag: databaseBytes(secret?.authenticationTag),
            ciphertext: databaseBytes(secret?.ciphertext),
            group: definition.group,
            initializationVector: databaseBytes(secret?.initializationVector),
            key,
            keyVersion: secret?.keyVersion,
            secretLastFour: secret?.secretLastFour,
            updatedBy: principal.userId,
            value: secret ? undefined : (value as Prisma.InputJsonValue),
            valueType: definition.valueType,
          },
          update: {
            authenticationTag: secret ? databaseBytes(secret.authenticationTag) : null,
            ciphertext: secret ? databaseBytes(secret.ciphertext) : null,
            group: definition.group,
            initializationVector: secret ? databaseBytes(secret.initializationVector) : null,
            keyVersion: secret?.keyVersion ?? null,
            secretLastFour: secret?.secretLastFour ?? null,
            updatedBy: principal.userId,
            value: secret ? Prisma.DbNull : (value as Prisma.InputJsonValue),
            valueType: definition.valueType,
            version: { increment: 1 },
          },
          where: { key },
        });
        await transaction.auditLog.create({
          data: {
            action: "platform-setting.update",
            actorType: "USER",
            actorUserId: principal.userId,
            reason: input.reason,
            resourceId: key,
            resourceType: "PlatformSetting",
            stateAfter: safeSettingState(definition, {
              configured: true,
              lastFour: row.secretLastFour,
              source: "DATABASE",
              updatedAt: row.updatedAt,
              updatedBy: row.updatedBy,
              value,
              version: row.version,
            }),
            stateBefore: safeSettingState(definition, before),
          },
        });
        return row;
      });
      if (definition.group === "STORAGE") this.objectStorage.invalidate();
      void updated;
    }
    const response = await this.list();
    const setting = response.groups
      .flatMap(({ settings }) => settings)
      .find((item) => item.key === key);
    if (!setting) throw new Error(`Updated setting disappeared from the catalog: ${key}`);
    return setting;
  }

  async saveMiniappDebug(input: SaveMiniappDebugSettingsDto) {
    const principal = this.requirePlatformAdministrator();
    const values = {
      "miniapp.debug_code_enabled": input.enabled,
      "miniapp.debug_code_phones": input.phones,
      "miniapp.debug_code_ips": input.ips,
      "miniapp.debug_code_until": input.until,
    };
    const definitions = miniappDebugKeys.map((key) => {
      const definition = platformSettingDefinition(key);
      if (!definition) throw new Error(`Missing miniapp setting ${key}`);
      return definition;
    });
    const validated = new Map(
      definitions.map((definition) => [
        definition.key,
        validatePlatformSettingValue(definition, values[definition.key as keyof typeof values]),
      ]),
    );
    validateMiniappDebugConfiguration({
      enabled: validated.get("miniapp.debug_code_enabled") as boolean,
      phones: validated.get("miniapp.debug_code_phones") as string,
      ips: validated.get("miniapp.debug_code_ips") as string,
      until: validated.get("miniapp.debug_code_until") as string,
    });
    await this.prisma.$transaction(async (transaction) => {
      const before = await this.reader.resolveMany(miniappDebugKeys, transaction);
      for (const definition of definitions) {
        const key = definition.key;
        const value = validated.get(key);
        if (value === undefined || value === null) throw new Error(`Missing miniapp value ${key}`);
        const previous = before.get(key);
        if (!previous) throw new Error(`Missing previous miniapp value ${key}`);
        const row = await transaction.platformSetting.upsert({
          create: {
            group: definition.group,
            key,
            updatedBy: principal.userId,
            value: value as Prisma.InputJsonValue,
            valueType: definition.valueType,
          },
          update: {
            updatedBy: principal.userId,
            value: value as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
          where: { key },
        });
        await transaction.auditLog.create({
          data: {
            action: "platform-setting.update",
            actorType: "USER",
            actorUserId: principal.userId,
            reason: input.reason,
            resourceId: key,
            resourceType: "PlatformSetting",
            stateBefore: safeSettingState(definition, previous),
            stateAfter: safeSettingState(definition, {
              configured: true,
              lastFour: null,
              source: "DATABASE",
              updatedAt: row.updatedAt,
              updatedBy: row.updatedBy,
              value,
              version: row.version,
            }),
          },
        });
      }
    });
    return this.list();
  }

  async testStorage(reason: string) {
    const principal = this.requirePlatformAdministrator();
    const { provider, storage } = await this.objectStorage.current();
    const bucket = provider === "LOCAL" ? "LOCAL" : await this.reader.string("storage.bucket");
    const bytes = Buffer.from(`xhs-agentic-storage-test:${randomUUID()}`, "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const key = `platform-settings/storage-test/${randomUUID()}.txt`;
    let step = provider === "LOCAL" ? "检查本机存储目录" : "检查 Bucket 访问";
    let uploadAttempted = false;
    try {
      await storage.ensureBucket(false);
      step = "上传测试文件";
      uploadAttempted = true;
      const stored = await storage.put({ bytes, checksum, key, mimeType: "text/plain" });
      step = "生成签名下载地址";
      const signedUrl = await storage.signedGetUrl(key, 60);
      step = "通过签名地址下载";
      const response = await fetch(storageReadUrl(signedUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        // Preserve only the status; a response body or signed URL can contain credentials.
        throw Object.assign(new Error("Signed storage read failed"), {
          $metadata: { httpStatusCode: response.status },
        });
      }
      step = "校验下载内容";
      const downloaded = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(downloaded).digest("hex") !== checksum) {
        throw new ConflictException({
          code: "STORAGE_TEST_CHECKSUM_MISMATCH",
          message: "存储测试失败：下载内容与上传内容不一致，请检查缓存、代理和对象存储兼容性。",
        });
      }
      step = "保存测试审计记录";
      const checkedAt = new Date();
      await this.prisma.auditLog.create({
        data: {
          action: "platform-setting.storage-test",
          actorType: "USER",
          actorUserId: principal.userId,
          metadata: { bucket, byteSize: stored.byteSize, signedReadVerified: true },
          reason,
          resourceId: "storage",
          resourceType: "PlatformSettingGroup",
        },
      });
      return {
        bucket,
        byteSize: stored.byteSize,
        checkedAt: checkedAt.toISOString(),
        signedReadVerified: true,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const cause = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
      const httpStatus = cause?.$metadata?.httpStatusCode;
      const details = { step, bucket, httpStatus: httpStatus ?? null };
      if (httpStatus === 401 || httpStatus === 403) {
        throw new ConflictException({
          code: "STORAGE_TEST_ACCESS_DENIED",
          message: `存储测试在“${step}”失败（HTTP ${httpStatus}）：当前 Bucket 为 ${bucket}。请填写实际桶名（不是账号名或内部 ID），并检查 Endpoint、Region、访问密钥及该桶的读写权限。`,
          details,
        });
      }
      if (httpStatus === 404) {
        throw new ConflictException({
          code: "STORAGE_TEST_NOT_FOUND",
          message: `存储测试在“${step}”失败（HTTP 404）：桶或测试对象不存在，请核对 S3 API Endpoint 和 Bucket 名称。`,
          details,
        });
      }
      if (
        httpStatus === 501 ||
        cause?.name === "NotImplemented" ||
        cause?.name === "NotSupported"
      ) {
        throw new ConflictException({
          code: "STORAGE_TEST_UNSUPPORTED",
          message: `存储测试在“${step}”失败：供应商不支持此 S3 请求或请求特性，请确认读写及签名下载接口的兼容性。此测试不涉及版本控制。`,
          details,
        });
      }
      throw new BadGatewayException({
        code: "STORAGE_TEST_FAILED",
        message: `存储测试在“${step}”失败${httpStatus ? `（HTTP ${httpStatus}）` : ""}。请检查该步骤对应的服务状态与连接后重试。`,
        details,
      });
    } finally {
      if (uploadAttempted) await storage.delete(key).catch(() => undefined);
    }
  }

  async applyStorageLifecycle(reason: string) {
    const principal = this.requirePlatformAdministrator();
    const current = await this.objectStorage.current();
    if (current.provider === "LOCAL") {
      throw new ConflictException({
        code: "STORAGE_MANAGEMENT_UNSUPPORTED",
        message: "本机存储不提供 S3 版本控制和云端生命周期策略；原文件不会被此操作修改。",
      });
    }
    if (!(await this.reader.boolean("storage.versioning_required"))) {
      throw new ConflictException({
        code: "STORAGE_VERSIONING_NOT_REQUIRED",
        message:
          "强制版本控制已关闭，无需应用历史版本生命周期。若要管理云端版本策略，请先开启并保存此开关。关闭开关不会修改云端已有规则。",
      });
    }
    const [abortIncompleteMultipartUploadDays, noncurrentVersionExpirationDays] = await Promise.all(
      [
        this.reader.number("storage.abort_incomplete_upload_days"),
        this.reader.number("storage.noncurrent_version_expiration_days"),
      ],
    );
    const { storage } = current;
    let state: ObjectStorageLifecycleState;
    try {
      await storage.ensureBucket(false);
      if (!("applyLifecyclePolicy" in storage)) throw new Error("Storage lifecycle is unavailable");
      state = await storage.applyLifecyclePolicy({
        abortIncompleteMultipartUploadDays,
        noncurrentVersionExpirationDays,
      });
    } catch (error) {
      const operation = error instanceof StorageManagementError ? error.operation : "BUCKET";
      const cause = (error instanceof StorageManagementError ? error.cause : error) as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      } | null;
      const operationLabel = {
        BUCKET: "检查 Bucket 访问",
        VERSIONING: "启用 Bucket 版本控制",
        LIFECYCLE: "设置历史版本生命周期",
        READBACK: "读回策略确认",
      }[operation];
      const httpStatus = cause?.$metadata?.httpStatusCode;
      const details = { operation, httpStatus: httpStatus ?? null };
      if (
        httpStatus === 501 ||
        cause?.name === "NotImplemented" ||
        cause?.name === "NotSupported"
      ) {
        throw new ConflictException({
          code: "STORAGE_MANAGEMENT_UNSUPPORTED",
          message: `${operationLabel}失败：存储服务返回 NotImplemented / 不支持此操作或请求特性。请向供应商确认对应 S3 桶管理接口和校验请求头兼容性。上传下载可用不代表支持版本控制；当前不能确认生命周期策略生效。`,
          details,
        });
      }
      if (httpStatus === 401 || httpStatus === 403) {
        throw new ConflictException({
          code: "STORAGE_MANAGEMENT_ACCESS_DENIED",
          message: `${operationLabel}失败：存储认证或权限检查未通过（HTTP ${httpStatus}）。请核对 Endpoint、Region、Bucket、密钥和桶管理权限；对象读写权限不等于桶管理权限。`,
          details,
        });
      }
      if (httpStatus === 404) {
        throw new ConflictException({
          code: "STORAGE_MANAGEMENT_NOT_FOUND",
          message: `${operationLabel}失败：桶或策略接口不存在（HTTP 404），请核对 S3 API Endpoint 和实际 Bucket 名称。`,
          details,
        });
      }
      throw new BadGatewayException({
        code: "STORAGE_MANAGEMENT_FAILED",
        message: `${operationLabel}失败：未能完成存储服务请求${httpStatus ? `（HTTP ${httpStatus}）` : ""}。请检查供应商状态、网络和 S3 接口兼容性，当前不能确认策略生效。`,
        details,
      });
    }
    if (
      state.versioning !== "ENABLED" ||
      !state.enabled ||
      state.noncurrentVersionExpirationDays !== noncurrentVersionExpirationDays
    ) {
      throw new ConflictException({
        code: "STORAGE_LIFECYCLE_NOT_EFFECTIVE",
        message:
          "存储服务已接收请求，但读回结果未达到目标策略，不能确认应用成功。请核对 S3 API Endpoint 与 Bucket 名称，并在存储供应商控制台确认是否支持版本控制及非当前版本生命周期、账号是否有管理权限。若配置传播有延迟，请稍后刷新生产引导；仅支持文件上传下载不足以通过此项治理要求。",
        details: {
          actual: state,
          expected: { versioning: "ENABLED", noncurrentVersionExpirationDays },
        },
      });
    }
    await this.prisma.auditLog.create({
      data: {
        action: "platform-setting.storage-lifecycle.apply",
        actorType: "USER",
        actorUserId: principal.userId,
        metadata: state,
        reason,
        resourceId: "storage-lifecycle",
        resourceType: "PlatformSettingGroup",
      },
    });
    return state;
  }

  private requirePlatformAdministrator() {
    const principal = this.accessContext.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM") {
      throw new ConflictException("Platform settings require platform scope");
    }
    return principal;
  }

  private async validateCrossSettingRules(
    definition: PlatformSettingDefinition,
    value: Exclude<PlatformSettingScalar, null>,
  ): Promise<void> {
    if (definition.key.startsWith("security.cap_")) {
      const values = await this.reader.resolveMany([
        "security.cap_enabled",
        "security.cap_endpoint",
        "security.cap_secret",
      ]);
      const enabled =
        definition.key === "security.cap_enabled"
          ? value === true
          : values.get("security.cap_enabled")?.value === true;
      if (enabled) {
        const endpoint =
          definition.key === "security.cap_endpoint"
            ? value
            : values.get("security.cap_endpoint")?.value;
        const secret =
          definition.key === "security.cap_secret"
            ? value
            : values.get("security.cap_secret")?.value;
        if (
          typeof endpoint !== "string" ||
          !endpoint.trim() ||
          typeof secret !== "string" ||
          !secret.trim()
        )
          throw new ConflictException(
            "启用 Cap 验证前必须配置 Cap 验证服务 Endpoint 和 Cap 验证服务 Secret Key",
          );
        normalizeCapEndpoint(endpoint);
      }
    }
    if (
      definition.key === "security.admin_sms_endpoint" &&
      typeof value === "string" &&
      value !== ""
    ) {
      const endpoint = new URL(value);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new ConflictException("短信网关 Endpoint 不能包含账号、密码、查询参数或 Fragment");
      }
      if (process.env.NODE_ENV === "production" && !isProductionHttpsEndpoint(value)) {
        throw new ConflictException("生产环境的短信网关 Endpoint 必须使用公开 HTTPS");
      }
    }
    if (definition.key === "security.admin_sms_mode" && value === "ALIYUN") {
      await readAliyunSmsConfiguration(this.reader);
    }
    if (definition.key === "security.admin_sms_mode" && value === "HTTP") {
      const resolved = await this.reader.resolveMany([
        "security.admin_sms_api_key",
        "security.admin_sms_endpoint",
        "security.admin_sms_provider",
        "security.admin_sms_sender",
        "security.admin_sms_template_id",
      ]);
      const missing = [
        ["API Key", resolved.get("security.admin_sms_api_key")?.value],
        ["Endpoint", resolved.get("security.admin_sms_endpoint")?.value],
        ["供应商标识", resolved.get("security.admin_sms_provider")?.value],
        ["短信签名", resolved.get("security.admin_sms_sender")?.value],
        ["模板 ID", resolved.get("security.admin_sms_template_id")?.value],
      ]
        .filter(([, configured]) => typeof configured !== "string" || configured.length === 0)
        .map(([label]) => label);
      if (missing.length > 0) {
        throw new ConflictException({
          code: "ADMIN_SMS_SETTINGS_INCOMPLETE",
          message: `启用管理员短信登录前请先配置：${missing.join("、")}`,
        });
      }
      const apiKey = resolved.get("security.admin_sms_api_key")?.value;
      if (
        process.env.NODE_ENV === "production" &&
        (typeof apiKey !== "string" || !isProductionCredential(apiKey, 4))
      ) {
        throw new ConflictException("生产环境的短信网关 API Key 不能使用开发占位值");
      }
    }
    if (
      definition.key === "storage.delivery_base_url" &&
      typeof value === "string" &&
      value !== ""
    ) {
      const baseUrl = new URL(value);
      if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
        throw new ConflictException("CDN 交付域名不能包含账号、密码、查询参数或 Fragment");
      }
      if (process.env.NODE_ENV === "production" && !isProductionHttpsEndpoint(value)) {
        throw new ConflictException("生产环境的 CDN 交付域名必须使用公开 HTTPS");
      }
    }
    if (definition.key === "storage.delivery_mode" && value === "EDGE_SIGNED") {
      const resolved = await this.reader.resolveMany([
        "storage.delivery_base_url",
        "storage.delivery_signing_key",
      ]);
      const baseUrl = resolved.get("storage.delivery_base_url")?.value;
      const signingKey = resolved.get("storage.delivery_signing_key")?.value;
      if (
        typeof baseUrl !== "string" ||
        baseUrl.length === 0 ||
        typeof signingKey !== "string" ||
        (process.env.NODE_ENV === "production"
          ? !isProductionCredential(signingKey, 32)
          : signingKey.length < 32)
      ) {
        throw new ConflictException({
          code: "ASSET_DELIVERY_SETTINGS_INCOMPLETE",
          message: "启用 Edge 交付前必须配置 CDN 交付域名和至少 32 字符的独立签名密钥",
        });
      }
    }
    if (definition.key === "content_safety.endpoint" && typeof value === "string" && value !== "") {
      const endpoint = new URL(value);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new ConflictException("内容安全 Endpoint 不能包含账号、密码、查询参数或 Fragment");
      }
      if (process.env.NODE_ENV === "production" && !isProductionHttpsEndpoint(value)) {
        throw new ConflictException("生产环境的内容安全 Endpoint 必须使用公开 HTTPS");
      }
    }
    if (definition.key === "content_safety.mode" && value === "HTTP") {
      const resolved = await this.reader.resolveMany([
        "content_safety.api_key",
        "content_safety.endpoint",
        "content_safety.provider",
      ]);
      const missing = [
        ["API Key", resolved.get("content_safety.api_key")?.value],
        ["Endpoint", resolved.get("content_safety.endpoint")?.value],
        ["服务标识", resolved.get("content_safety.provider")?.value],
      ]
        .filter(([, configured]) => typeof configured !== "string" || configured.length === 0)
        .map(([label]) => label);
      if (missing.length > 0) {
        throw new ConflictException({
          code: "CONTENT_SAFETY_SETTINGS_INCOMPLETE",
          message: `启用内容安全前请先配置：${missing.join("、")}`,
        });
      }
      const apiKey = resolved.get("content_safety.api_key")?.value;
      if (
        process.env.NODE_ENV === "production" &&
        (typeof apiKey !== "string" || !isProductionCredential(apiKey, 4))
      ) {
        throw new ConflictException("生产环境的内容安全 API Key 不能使用开发占位值");
      }
    }
    if (definition.key === "publication.endpoint" && typeof value === "string" && value !== "") {
      const endpoint = new URL(value);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new ConflictException("发布验真 Endpoint 不能包含账号、密码、查询参数或 Fragment");
      }
      if (process.env.NODE_ENV === "production" && !isProductionHttpsEndpoint(value)) {
        throw new ConflictException("生产环境的发布验真 Endpoint 必须使用公开 HTTPS");
      }
    }
    if (definition.key === "publication.mode" && value === "HTTP") {
      const resolved = await this.reader.resolveMany([
        "publication.api_key",
        "publication.endpoint",
        "publication.provider",
      ]);
      const missing = [
        ["API Key", resolved.get("publication.api_key")?.value],
        ["Endpoint", resolved.get("publication.endpoint")?.value],
        ["服务标识", resolved.get("publication.provider")?.value],
      ]
        .filter(([, configured]) => typeof configured !== "string" || configured.length === 0)
        .map(([label]) => label);
      if (missing.length > 0) {
        throw new ConflictException({
          code: "PUBLICATION_VERIFICATION_SETTINGS_INCOMPLETE",
          message: `启用发布验真前请先配置：${missing.join("、")}`,
        });
      }
      const apiKey = resolved.get("publication.api_key")?.value;
      if (
        process.env.NODE_ENV === "production" &&
        (typeof apiKey !== "string" || !isProductionCredential(apiKey, 4))
      ) {
        throw new ConflictException("生产环境的发布验真 API Key 不能使用开发占位值");
      }
    }
    if (definition.key === "publication.mode" && value === "BROWSER") {
      assertPublicationBrowserProductionReady(value);
      const collectorId = process.env.PUBLICATION_COLLECTOR_ID ?? "";
      const collectorKey = process.env.PUBLICATION_COLLECTOR_HMAC_KEY ?? "";
      const imageRequired = await this.reader.boolean("publication.require_image_match");
      if (
        !/^[a-zA-Z0-9_.-]{3,80}$/u.test(collectorId) ||
        collectorKey.length < 32 ||
        (process.env.NODE_ENV === "production" && !isProductionRandomSecret(collectorKey, 32)) ||
        !imageRequired
      ) {
        throw new ConflictException({
          code: "PUBLICATION_COLLECTOR_NOT_CONFIGURED",
          message: "浏览器验真须先配置独立采集器 ID、随机 HMAC 密钥及强制图片匹配策略",
        });
      }
    }
    if (
      definition.key === "worker.generation_heartbeat_interval_ms" ||
      definition.key === "worker.generation_lease_duration_ms"
    ) {
      const [heartbeat, lease] = await Promise.all([
        definition.key === "worker.generation_heartbeat_interval_ms"
          ? Promise.resolve(Number(value))
          : this.reader.number("worker.generation_heartbeat_interval_ms"),
        definition.key === "worker.generation_lease_duration_ms"
          ? Promise.resolve(Number(value))
          : this.reader.number("worker.generation_lease_duration_ms"),
      ]);
      if (heartbeat >= lease / 2) {
        throw new ConflictException(
          "Generation heartbeat interval must be less than half the lease duration",
        );
      }
    }
  }
}

async function assertStorageSwitchIsEmpty(transaction: Prisma.TransactionClient): Promise<void> {
  const counts = await Promise.all([
    transaction.materialArtifact.count({ where: { objectKey: { not: null } } }),
    transaction.generatedImage.count({ where: { storageKey: { not: null } } }),
    transaction.storageReservation.count({
      where: {
        OR: [{ status: "RESERVED" }, { status: { not: "RELEASED" }, storageKey: { not: null } }],
      },
    }),
    transaction.employeeContentRevision.count({
      // Historical images can retain files after the current image rows are replaced.
      where: { snapshot: { path: ["images"], not: Prisma.DbNull } },
    }),
    transaction.generationRun.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    transaction.generationWorkItem.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    transaction.materialIngestionJob.count({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
    }),
    transaction.generationLabRun.count({
      where: {
        OR: [
          { status: { in: ["CHECKING", "QUEUED", "RUNNING"] } },
          { reviewStatus: { in: ["QUEUED", "RUNNING"] } },
        ],
      },
    }),
  ]);
  if (counts.some((count) => count > 0)) {
    throw new ConflictException({
      code: "OBJECT_STORAGE_SWITCH_REQUIRES_MIGRATION",
      message:
        "已有文件或进行中的任务，不能直接切换存储类型。请先停止相关任务并完成离线迁移；原文件保留，存储类型未修改。",
    });
  }
}

function databaseSettingItem(
  definition: PlatformSettingDefinition,
  resolved: ResolvedPlatformSetting,
) {
  const secret = definition.valueType === "SECRET";
  return {
    configured: resolved.configured,
    description: definition.description,
    group: definition.group,
    key: definition.key,
    label: definition.label,
    maskedValue: secret && resolved.configured ? `••••••••${resolved.lastFour ?? ""}` : null,
    max: definition.max ?? null,
    maxLength: definition.maxLength ?? null,
    min: definition.min ?? null,
    minLength: definition.minLength ?? null,
    nullable: definition.nullable ?? false,
    options: [...(definition.options ?? [])],
    restartRequired: definition.restartRequired ?? false,
    secret,
    source: resolved.source,
    step: definition.step ?? 1,
    store: definition.store,
    unit: definition.unit ?? null,
    updatedAt: resolved.updatedAt?.toISOString() ?? null,
    updatedBy: resolved.updatedBy,
    value: secret ? null : resolved.value,
    valueType: definition.valueType,
    version: resolved.version,
  };
}

function runtimeSettingItem(
  definition: PlatformSettingDefinition,
  policy: Awaited<ReturnType<RuntimePolicyService["current"]>>,
  embeddingModels: readonly Readonly<{
    capabilities: readonly string[];
    displayName: string;
    id: string;
    provider: Readonly<{ name: string }>;
  }>[],
) {
  if (!definition.runtimeField) throw new Error(`Runtime field is missing for ${definition.key}`);
  const raw = policy[definition.runtimeField];
  const value = raw instanceof Prisma.Decimal ? Number(raw) : raw;
  return {
    configured: true,
    description: definition.description,
    group: definition.group,
    key: definition.key,
    label: definition.label,
    maskedValue: null,
    max: definition.max ?? null,
    maxLength: definition.maxLength ?? null,
    min: definition.min ?? null,
    minLength: definition.minLength ?? null,
    nullable: definition.nullable ?? false,
    options:
      definition.key === "retrieval.embedding_model_id" ||
      definition.key === "retrieval.material_analysis_model_id"
        ? embeddingModels
            .filter((model) =>
              definition.key === "retrieval.embedding_model_id"
                ? model.capabilities.includes("EMBEDDING")
                : model.capabilities.includes("MULTIMODAL") ||
                  (model.capabilities.includes("TEXT") && model.capabilities.includes("VISION")),
            )
            .map((model) => ({
              label: `${model.displayName} · ${model.provider.name}`,
              value: model.id,
            }))
        : [...(definition.options ?? [])],
    restartRequired: false,
    secret: false,
    source: "DATABASE" as const,
    step: definition.step ?? 1,
    store: definition.store,
    unit: definition.unit ?? null,
    updatedAt: policy.updatedAt.toISOString(),
    updatedBy: policy.updatedBy,
    value: value as PlatformSettingScalar,
    valueType: definition.valueType,
    version: null,
  };
}

function runtimePolicyUpdate(
  field: RuntimePolicyField,
  value: PlatformSettingScalar,
  reason: string,
): UpdateRuntimePolicyDto {
  switch (field) {
    case "costCurrency":
      return { costCurrency: String(value), reason };
    case "costWarningThreshold":
      return { costWarningThreshold: Number(value), reason };
    case "embeddingModelId":
      return { embeddingModelId: value === null || value === "" ? null : String(value), reason };
    case "materialAnalysisModelId":
      return {
        materialAnalysisModelId: value === null || value === "" ? null : String(value),
        reason,
      };
    case "materialChunkOverlapCharacters":
      return { materialChunkOverlapCharacters: Number(value), reason };
    case "materialChunkSizeCharacters":
      return { materialChunkSizeCharacters: Number(value), reason };
    case "maxActiveGenerationJobs":
      return { maxActiveGenerationJobs: Number(value), reason };
    case "maxProviderConcurrentInvocations":
      return { maxProviderConcurrentInvocations: Number(value), reason };
    case "maxQueueBacklog":
      return { maxQueueBacklog: Number(value), reason };
    case "minimumGenerationWorkers":
      return { minimumGenerationWorkers: Number(value), reason };
    case "providerHealthMaxAgeSeconds":
      return { providerHealthMaxAgeSeconds: Number(value), reason };
    case "retrievalMaxContextCharacters":
      return { retrievalMaxContextCharacters: Number(value), reason };
    case "retrievalStrategyVersion":
      return { reason, retrievalStrategyVersion: String(value) };
    case "retrievalTopK":
      return { reason, retrievalTopK: Number(value) };
    case "routeQualificationMaxAgeSeconds":
      return { reason, routeQualificationMaxAgeSeconds: Number(value) };
  }
}

function safeSettingState(
  definition: PlatformSettingDefinition,
  resolved: ResolvedPlatformSetting,
): Prisma.InputJsonValue {
  return {
    configured: resolved.configured,
    key: definition.key,
    lastFour: definition.valueType === "SECRET" ? resolved.lastFour : null,
    source: resolved.source,
    value: definition.valueType === "SECRET" ? "[REDACTED]" : resolved.value,
    version: resolved.version,
  } as Prisma.InputJsonValue;
}

function requireResolved(
  values: ReadonlyMap<string, ResolvedPlatformSetting>,
  key: string,
): ResolvedPlatformSetting {
  const value = values.get(key);
  if (!value) throw new Error(`Resolved platform setting is missing: ${key}`);
  return value;
}

function databaseBytes(value: Uint8Array | undefined): Uint8Array<ArrayBuffer> | undefined {
  return value ? new Uint8Array(value) : undefined;
}
