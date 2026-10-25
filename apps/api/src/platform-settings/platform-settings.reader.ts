import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { PlatformSetting, Prisma } from "@xhs-agentic/database";
import { PrismaService } from "../database/prisma.service";
import {
  type PlatformSettingDefinition,
  type PlatformSettingScalar,
  platformSettingDefinition,
} from "./platform-setting-catalog";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import {
  parsePlatformSettingEnvironmentValue,
  validatePlatformSettingValue,
} from "./platform-setting-values";

export type ResolvedPlatformSetting = Readonly<{
  configured: boolean;
  lastFour: string | null;
  source: "DATABASE" | "DEFAULT" | "ENVIRONMENT" | "UNCONFIGURED";
  updatedAt: Date | null;
  updatedBy: string | null;
  value: PlatformSettingScalar;
  version: number | null;
}>;

@Injectable()
export class PlatformSettingsReader {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlatformSettingCrypto) private readonly crypto: PlatformSettingCrypto,
  ) {}

  async resolve(key: string): Promise<ResolvedPlatformSetting> {
    const definition = requireDatabaseDefinition(key);
    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    return this.resolveDefinition(definition, row);
  }

  async resolveMany(
    keys: readonly string[],
    client: Pick<PrismaService, "platformSetting"> | Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, ResolvedPlatformSetting>> {
    const definitions = keys.map(requireDatabaseDefinition);
    const rows = await client.platformSetting.findMany({ where: { key: { in: [...keys] } } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return new Map(
      definitions.map((definition) => [
        definition.key,
        this.resolveDefinition(definition, byKey.get(definition.key) ?? null),
      ]),
    );
  }

  async boolean(key: string): Promise<boolean> {
    const value = (await this.resolve(key)).value;
    if (typeof value !== "boolean") throw typeError(key, "boolean");
    return value;
  }

  async number(key: string): Promise<number> {
    const value = (await this.resolve(key)).value;
    if (typeof value !== "number") throw typeError(key, "number");
    return value;
  }

  async string(key: string): Promise<string> {
    const value = (await this.resolve(key)).value;
    if (typeof value !== "string") throw typeError(key, "string");
    return value;
  }

  private resolveDefinition(
    definition: PlatformSettingDefinition,
    row: PlatformSetting | null,
  ): ResolvedPlatformSetting {
    if (row) {
      const value =
        definition.valueType === "SECRET"
          ? this.decryptSecret(row)
          : validatePlatformSettingValue(definition, row.value);
      return {
        configured: true,
        lastFour: row.secretLastFour,
        source: "DATABASE",
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        value,
        version: row.version,
      };
    }
    const environmentValue = environmentFallback(definition);
    if (environmentValue !== undefined) {
      return {
        configured: true,
        lastFour:
          definition.valueType === "SECRET" && typeof environmentValue === "string"
            ? environmentValue.slice(-4)
            : null,
        source: "ENVIRONMENT",
        updatedAt: null,
        updatedBy: null,
        value: environmentValue,
        version: null,
      };
    }
    if (definition.defaultValue !== null) {
      return {
        configured: true,
        lastFour: null,
        source: "DEFAULT",
        updatedAt: null,
        updatedBy: null,
        value: validatePlatformSettingValue(definition, definition.defaultValue),
        version: null,
      };
    }
    return {
      configured: false,
      lastFour: null,
      source: "UNCONFIGURED",
      updatedAt: null,
      updatedBy: null,
      value: null,
      version: null,
    };
  }

  private decryptSecret(row: PlatformSetting): string {
    if (!row.authenticationTag || !row.ciphertext || !row.initializationVector || !row.keyVersion) {
      throw new ConflictException({
        code: "PLATFORM_SETTING_SECRET_CORRUPT",
        key: row.key,
        message: "Platform setting secret is incomplete",
      });
    }
    return this.crypto.decrypt({
      authenticationTag: row.authenticationTag,
      ciphertext: row.ciphertext,
      initializationVector: row.initializationVector,
      key: row.key,
      keyVersion: row.keyVersion,
    });
  }
}

function requireDatabaseDefinition(key: string): PlatformSettingDefinition {
  const definition = platformSettingDefinition(key);
  if (definition?.store !== "PLATFORM_SETTING") {
    throw new ConflictException({
      code: "PLATFORM_SETTING_UNKNOWN",
      key,
      message: "Platform setting is not registered",
    });
  }
  return definition;
}

function environmentFallback(
  definition: PlatformSettingDefinition,
): PlatformSettingScalar | undefined {
  if (!definition.environmentVariable) return undefined;
  const raw = process.env[definition.environmentVariable];
  if (raw === undefined || raw === "") return undefined;
  return parsePlatformSettingEnvironmentValue(definition, raw);
}

function typeError(key: string, expected: string): ConflictException {
  return new ConflictException({
    code: "PLATFORM_SETTING_TYPE_MISMATCH",
    key,
    message: `Platform setting must resolve to ${expected}`,
  });
}
