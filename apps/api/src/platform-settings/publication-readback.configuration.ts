import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import {
  fetchNoteDetail,
  normalizeNoteDetailAuthorization,
  normalizeNoteDetailEndpoint,
} from "@xhs-agentic/xhs-api-collector";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { managedReadbackNodeKey } from "../publication/publication-readback-node-key";
import { recoverDisabledReadbackLeases } from "../publication/publication-readback-recovery";
import { resolvePublicationShortUrl } from "../publication/publication-short-url";
import { normalizePublicationUrl } from "../publication/publication-url";
import { PlatformSettingCrypto } from "./platform-setting-crypto";
import { PlatformSettingsReader } from "./platform-settings.reader";

export const readbackSettingKeys = [
  "publication.readback_enabled",
  "publication.readback_endpoint",
  "publication.readback_token",
] as const;

type Client = PrismaService | Prisma.TransactionClient;
type SaveConfiguration = {
  enabled: boolean;
  endpoint: string;
  token?: string;
  reason: string;
};

@Injectable()
export class PublicationReadbackConfigurationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(PlatformSettingCrypto) private readonly crypto: PlatformSettingCrypto,
  ) {}

  async runtime(client: Client = this.prisma) {
    const values = await this.settings.resolveMany(readbackSettingKeys.slice(0, 2), client);
    const enabledSetting = values.get("publication.readback_enabled");
    const enabled = enabledSetting?.value === true;
    const endpoint = stringValue(values.get("publication.readback_endpoint")?.value);
    let token = "";
    let tokenConfigured = false;
    try {
      const credential = (
        await this.settings.resolveMany(["publication.readback_token"], client)
      ).get("publication.readback_token");
      token = stringValue(credential?.value);
      tokenConfigured = Boolean(token);
    } catch {
      // A broken optional credential must not prevent turning automatic readback off.
      tokenConfigured = Boolean(
        (
          await client.platformSetting.findUnique({
            where: { key: "publication.readback_token" },
            select: { ciphertext: true },
          })
        )?.ciphertext,
      );
    }
    const externalMode = !tokenConfigured && process.env.PUBLICATION_READBACK_ENABLED === "true";
    const receipt =
      endpoint && token
        ? await client.auditLog.findFirst({
            select: { metadata: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            where: {
              action: "publication.readback.sample-test",
              metadata: { path: ["fingerprint"], equals: fingerprint(endpoint, token) },
            },
          })
        : null;
    return {
      enabled,
      endpoint,
      token,
      tokenConfigured,
      verified: Boolean(
        receipt?.metadata &&
          typeof receipt.metadata === "object" &&
          !Array.isArray(receipt.metadata) &&
          receipt.metadata.success === true,
      ),
      externalMode,
      managedNodeConfigured: managedReadbackNodeKey() !== null,
    };
  }

  async configuration() {
    this.requireAdministrator();
    return publicConfiguration(await this.runtime());
  }

  async enabled(client: Client = this.prisma) {
    return (
      (await this.settings.resolveMany(["publication.readback_enabled"], client)).get(
        "publication.readback_enabled",
      )?.value === true
    );
  }

  async recoverExpiredLeases() {
    return recoverDisabledReadbackLeases(this.prisma, this.settings);
  }

  async save(input: SaveConfiguration) {
    const principal = this.requireAdministrator();
    const rawEndpoint = input.endpoint.trim();
    const replacement = input.token?.trim();
    if (replacement) normalizeToken(input.token ?? replacement);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910102::bigint)`;
      const current = await this.runtime(transaction);
      let endpoint = "";
      try {
        endpoint = rawEndpoint ? normalizeEndpoint(rawEndpoint) : "";
      } catch (error) {
        if (input.enabled || rawEndpoint !== current.endpoint) throw error;
        endpoint = rawEndpoint;
      }
      if (
        current.tokenConfigured &&
        !replacement &&
        endpoint &&
        endpoint !== current.endpoint &&
        origin(endpoint) !== origin(current.endpoint)
      )
        throw new ConflictException(
          "更换接口主机时请重新输入 Token；已保存的凭据不会沿用到其他主机",
        );
      const token = replacement || current.token;
      const unchanged = endpoint === current.endpoint && token === current.token;
      if (input.enabled && !(current.externalMode && unchanged)) {
        if (!current.managedNodeConfigured)
          throw new ConflictException("请先部署同机回读容器并准备独立签名密钥");
        if (!endpoint || !token || !unchanged || !current.verified)
          throw new ConflictException("请先保存当前接口与凭据，并完成真实样本验证后再启用自动回读");
      }
      if (!input.enabled && current.enabled) {
        // Fence unclaimed jobs with the same short lock used by claim reservations.
        await transaction.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910101::bigint)`;
        const queued = await transaction.publicationCollectionJob.findMany({
          where: { kind: "READBACK", status: "QUEUED" },
          select: { id: true, submissionId: true },
        });
        if (queued.length) {
          await transaction.publicationCollectionJob.updateMany({
            where: { id: { in: queued.map((job) => job.id) }, kind: "READBACK", status: "QUEUED" },
            data: {
              status: "NEEDS_REVIEW",
              errorCode: "READBACK_DISABLED_BY_ADMIN",
              completedAt: new Date(),
            },
          });
          await transaction.publishSubmission.updateMany({
            where: { id: { in: queued.map((job) => job.submissionId) }, status: "VERIFYING" },
            data: { status: "MANUAL_REVIEW", failureReason: "自动回读已停用，等待管理员人工复核" },
          });
        }
      }
      for (const [key, value, valueType] of [
        ["publication.readback_enabled", input.enabled, "BOOLEAN"],
        ["publication.readback_endpoint", endpoint, "STRING"],
      ] as const) {
        await transaction.platformSetting.upsert({
          where: { key },
          create: { key, group: "PUBLICATION", valueType, value, updatedBy: principal.userId },
          update: { value, updatedBy: principal.userId, version: { increment: 1 } },
        });
      }
      if (replacement) {
        const key = "publication.readback_token";
        const secret = this.crypto.encrypt(replacement, key);
        const data = {
          authenticationTag: new Uint8Array(secret.authenticationTag),
          ciphertext: new Uint8Array(secret.ciphertext),
          initializationVector: new Uint8Array(secret.initializationVector),
          keyVersion: secret.keyVersion,
          secretLastFour: secret.secretLastFour,
          updatedBy: principal.userId,
        };
        await transaction.platformSetting.upsert({
          where: { key },
          create: { key, group: "PUBLICATION", valueType: "SECRET", ...data },
          update: { ...data, value: Prisma.DbNull, version: { increment: 1 } },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: "publication.readback.configuration.update",
          actorType: "USER",
          actorUserId: principal.userId,
          reason: input.reason,
          resourceType: "PlatformSettingGroup",
          resourceId: "publication-readback",
          metadata: {
            enabled: input.enabled,
            endpointChanged: endpoint !== current.endpoint,
            credentialChanged: Boolean(replacement && replacement !== current.token),
          },
        },
      });
    });
    return this.configuration();
  }

  async test(noteUrl: string, reason: string) {
    const principal = this.requireAdministrator();
    const current = await this.runtime();
    if (!current.endpoint || !current.token)
      throw new ConflictException("请先保存笔记详情接口和 Token");
    let noteId = noteUrl.trim();
    if (!/^[a-zA-Z0-9_-]{6,128}$/u.test(noteId)) {
      let target = normalizePublicationUrl(noteUrl);
      if (target.classification === "XHS_SHORT") target = await resolvePublicationShortUrl(noteUrl);
      if (target.classification !== "XHS_NOTE")
        throw new ConflictException("样本必须是小红书笔记链接或笔记 ID");
      noteId = new URL(target.normalizedUrl).pathname.split("/").at(-1) ?? "";
    }
    const reservation = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(7100910102::bigint)`;
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      const attempts = await transaction.auditLog.count({
        where: { action: "publication.readback.sample-test", createdAt: { gte: day } },
      });
      if (attempts >= 3)
        throw new ConflictException("今日样本验证已达 3 次上限，失败和超时也计入次数，请明日再试");
      return transaction.auditLog.create({
        select: { id: true },
        data: {
          action: "publication.readback.sample-test",
          actorType: "USER",
          actorUserId: principal.userId,
          reason,
          resourceType: "PlatformSettingGroup",
          resourceId: "publication-readback",
          metadata: { fingerprint: fingerprint(current.endpoint, current.token), success: false },
        },
      });
    });
    let success = false;
    try {
      const result = await fetchNoteDetail({
        endpoint: current.endpoint,
        token: current.token,
        noteId,
      });
      success =
        result.status === "AVAILABLE" &&
        result.note.noteId.toLowerCase() === noteId.toLowerCase() &&
        result.note.title.trim().length > 0 &&
        result.note.body.trim().length > 0 &&
        result.note.likes !== null &&
        result.note.comments !== null &&
        result.note.favorites !== null;
    } catch {
      // Provider response bodies and credentials must not enter logs or UI errors.
    }
    const checkedAt = new Date().toISOString();
    await this.prisma.auditLog.update({
      where: { id: reservation.id },
      data: {
        metadata: {
          fingerprint: fingerprint(current.endpoint, current.token),
          success,
        },
      },
    });
    return {
      success,
      checkedAt,
      message: success
        ? "样本已返回匹配笔记、正文及点赞、评论、收藏，可启用自动回读。"
        : "样本未通过，请检查接口、凭据、笔记 ID 和必要的互动指标；自动回读保持原状态。",
    };
  }

  private requireAdministrator() {
    const principal = this.access.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM")
      throw new ConflictException("只有系统管理员可以配置自动回读");
    return principal;
  }
}

function publicConfiguration(
  value: Awaited<ReturnType<PublicationReadbackConfigurationService["runtime"]>>,
) {
  return {
    enabled: value.enabled,
    endpoint: value.endpoint,
    tokenConfigured: value.tokenConfigured,
    verified: value.verified,
    managedNodeConfigured: value.managedNodeConfigured,
    externalMode: value.externalMode,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fingerprint(endpoint: string, token: string): string {
  return createHash("sha256").update(JSON.stringify({ endpoint, token })).digest("hex");
}

function normalizeEndpoint(value: string): string {
  try {
    return normalizeNoteDetailEndpoint(value);
  } catch {
    throw new ConflictException("笔记详情接口必须是无密钥参数的公开 HTTPS 地址");
  }
}

function normalizeToken(value: string): string {
  try {
    return normalizeNoteDetailAuthorization(value);
  } catch {
    throw new ConflictException("Token 格式无效，不得包含换行");
  }
}

function origin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
