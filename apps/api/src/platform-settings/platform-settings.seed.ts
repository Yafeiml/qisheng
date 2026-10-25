import type { Prisma, PrismaClient } from "@xhs-agentic/database";
import { platformSettingCatalog } from "./platform-setting-catalog";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import {
  parsePlatformSettingEnvironmentValue,
  validatePlatformSettingValue,
} from "./platform-setting-values";

export async function seedPlatformSettings(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<number> {
  const crypto = new PlatformSettingCrypto();
  let seeded = 0;
  for (const definition of platformSettingCatalog) {
    if (definition.store !== "PLATFORM_SETTING") continue;
    const rawEnvironment = definition.environmentVariable
      ? process.env[definition.environmentVariable]
      : undefined;
    // Keep the compatibility fallback distinguishable from an explicit storage choice.
    if (definition.key === "storage.provider" && !rawEnvironment) continue;
    const value =
      rawEnvironment !== undefined && rawEnvironment !== ""
        ? parsePlatformSettingEnvironmentValue(definition, rawEnvironment)
        : definition.defaultValue === null
          ? null
          : validatePlatformSettingValue(definition, definition.defaultValue);
    if (value === null) continue;
    const secret =
      definition.valueType === "SECRET" ? crypto.encrypt(String(value), definition.key) : null;
    await prisma.platformSetting.upsert({
      create: {
        authenticationTag: databaseBytes(secret?.authenticationTag),
        ciphertext: databaseBytes(secret?.ciphertext),
        group: definition.group,
        initializationVector: databaseBytes(secret?.initializationVector),
        key: definition.key,
        keyVersion: secret?.keyVersion,
        secretLastFour: secret?.secretLastFour,
        updatedBy: "system:seed",
        value: secret ? undefined : (value as Prisma.InputJsonValue),
        valueType: definition.valueType,
      },
      update: {
        group: definition.group,
        valueType: definition.valueType,
      },
      where: { key: definition.key },
    });
    seeded += 1;
  }
  return seeded;
}

function databaseBytes(value: Uint8Array | undefined): Uint8Array<ArrayBuffer> | undefined {
  return value ? new Uint8Array(value) : undefined;
}
