import { randomInt, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { AliyunSmsClient } from "../identity/aliyun-sms.client";
import {
  ADMIN_SMS_MODE_KEY,
  ALIYUN_SMS_KEYS,
  type AliyunSmsConfiguration,
  readAliyunSmsConfiguration,
  validateAliyunSmsConfiguration,
} from "./admin-sms.configuration";
import type { SaveAdminSmsSettingsDto } from "./admin-sms-settings.dto";
import { platformSettingDefinition } from "./platform-setting-catalog";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import { PlatformSettingsReader } from "./platform-settings.reader";

@Injectable()
export class AdminSmsSettingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
    @Inject(PlatformSettingsReader) private readonly reader: PlatformSettingsReader,
    @Inject(PlatformSettingCrypto) private readonly crypto: PlatformSettingCrypto,
    @Inject(AliyunSmsClient) private readonly aliyun: AliyunSmsClient,
  ) {}

  async current(transaction?: Prisma.TransactionClient) {
    this.requirePlatform();
    const rows = await this.reader.resolveMany(
      [...Object.values(ALIYUN_SMS_KEYS), ADMIN_SMS_MODE_KEY],
      transaction,
    );
    const text = (key: string) => String(rows.get(key)?.value ?? "").trim();
    const accessKeyIdConfigured = Boolean(text(ALIYUN_SMS_KEYS.accessKeyId));
    const accessKeySecretConfigured = Boolean(text(ALIYUN_SMS_KEYS.accessKeySecret));
    const signName = text(ALIYUN_SMS_KEYS.signName);
    const templateCode = text(ALIYUN_SMS_KEYS.templateCode);
    return {
      accessKeyIdConfigured,
      accessKeySecretConfigured,
      accessKeyIdHint: accessKeyIdConfigured
        ? `••••${text(ALIYUN_SMS_KEYS.accessKeyId).slice(-4)}`
        : null,
      signName,
      templateCode,
      configured:
        accessKeyIdConfigured && accessKeySecretConfigured && Boolean(signName && templateCode),
      enabled: text(ADMIN_SMS_MODE_KEY) === "ALIYUN",
    };
  }

  async save(input: SaveAdminSmsSettingsDto) {
    const principal = this.requirePlatform();
    return this.prisma.$transaction(async (transaction) => {
      const old = await this.reader.resolveMany(Object.values(ALIYUN_SMS_KEYS), transaction);
      const effective: AliyunSmsConfiguration = {
        accessKeyId: input.accessKeyId ?? String(old.get(ALIYUN_SMS_KEYS.accessKeyId)?.value ?? ""),
        accessKeySecret:
          input.accessKeySecret ?? String(old.get(ALIYUN_SMS_KEYS.accessKeySecret)?.value ?? ""),
        signName: input.signName,
        templateCode: input.templateCode,
      };
      try {
        validateAliyunSmsConfiguration(effective);
      } catch (error) {
        if (error instanceof ServiceUnavailableException)
          throw new ConflictException(error.getResponse());
        throw error;
      }
      const changes = [
        ...Object.entries(ALIYUN_SMS_KEYS).flatMap(([field, key]) => {
          const value = input[field as keyof SaveAdminSmsSettingsDto];
          return value === undefined ? [] : [{ key, value }];
        }),
        { key: ADMIN_SMS_MODE_KEY, value: "ALIYUN" },
      ];
      for (const { key, value } of changes) {
        const definition = platformSettingDefinition(key);
        if (!definition) throw new Error("SMS setting definition is missing");
        const secret = definition.valueType === "SECRET" ? this.crypto.encrypt(value, key) : null;
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
          action: "platform-setting.admin-sms.save",
          actorType: "USER",
          actorUserId: principal.userId,
          resourceType: "PlatformSettingGroup",
          resourceId: "admin-sms",
          reason: "保存阿里云管理员短信登录配置",
          stateAfter: { mode: "ALIYUN", changedKeys: changes.map(({ key }) => key) },
        },
      });
      return this.current(transaction);
    });
  }

  async test(phone: string) {
    const principal = this.requirePlatform();
    const configuration = await readAliyunSmsConfiguration(this.reader);
    // Test messages deliberately never enter the login-code Redis namespace.
    const delivery = await this.aliyun.send(configuration, {
      phone,
      code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
      requestId: `admin-sms-test:${randomUUID()}`,
    });
    const phoneMasked = `${phone.slice(0, 3)}****${phone.slice(-4)}`;
    await this.prisma.auditLog.create({
      data: {
        action: "platform-setting.admin-sms.test",
        actorType: "USER",
        actorUserId: principal.userId,
        resourceType: "AdminSmsTest",
        resourceId: delivery.requestId,
        metadata: {
          phoneMasked,
          provider: delivery.provider,
          requestId: delivery.requestId,
          messageId: delivery.messageId,
        },
        reason: "管理员发送阿里云短信测试",
      },
    });
    return { ...delivery, status: "ACCEPTED" as const, phoneMasked };
  }

  private requirePlatform() {
    const principal = this.access.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM")
      throw new ForbiddenException("仅平台管理员可以配置或测试短信");
    return principal;
  }
}
