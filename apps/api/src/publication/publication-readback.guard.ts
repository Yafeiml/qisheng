import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { PrismaService } from "../database/prisma.service";
import { isProductionRandomSecret } from "../platform-settings/production-secret";
import { MANAGED_READBACK_NODE_ID, managedReadbackNodeKey } from "./publication-readback-node-key";
import { readbackPanelUrl } from "./publication-readback-panel-url";

type SignedRequest = {
  headers: Record<string, string | undefined>;
  method: string;
  originalUrl: string;
  rawBody?: Buffer;
};

// Node identities remain separate; only the managed route can return provider credentials.
@Injectable()
export class PublicationReadbackGuard implements CanActivate {
  private lastNonceCleanup = 0;
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SignedRequest>();
    const id = request.headers["x-collector-id"] ?? "";
    const timestamp = request.headers["x-collector-timestamp"] ?? "";
    const requestId = request.headers["x-collector-request-id"] ?? "";
    const signature = request.headers["x-collector-signature"] ?? "";
    const reportedPanelUrl = request.headers["x-collector-panel-url"];
    const panelUrl = readbackPanelUrl(reportedPanelUrl);
    const keys = readNodeKeys();
    const secret = Object.hasOwn(keys, id) ? keys[id] : undefined;
    const seconds = Number(timestamp);
    if (
      !/^[a-zA-Z0-9_.-]{3,80}$/u.test(id) ||
      typeof secret !== "string" ||
      !/^\d{10}$/u.test(timestamp) ||
      !Number.isSafeInteger(seconds) ||
      Math.abs(Math.floor(Date.now() / 1000) - seconds) > 300 ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(requestId) ||
      !/^[a-f\d]{64}$/iu.test(signature) ||
      request.originalUrl.includes("?") ||
      (reportedPanelUrl !== undefined && !panelUrl)
    )
      throw new UnauthorizedException("回读节点身份校验失败");
    const digest = createHash("sha256")
      .update(request.rawBody ?? Buffer.alloc(0))
      .digest("hex");
    const fields = [request.method, request.originalUrl, timestamp, requestId, digest];
    if (reportedPanelUrl !== undefined) fields.push(reportedPanelUrl);
    const data = fields.join("\n");
    const expected = createHmac("sha256", secret).update(data).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
      throw new UnauthorizedException("回读节点身份校验失败");
    try {
      await this.prisma.publicationCollectorRequestNonce.create({ data: { id: requestId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new UnauthorizedException("回读节点请求已处理");
      throw error;
    }
    if (Date.now() - this.lastNonceCleanup > 60 * 60_000) {
      this.lastNonceCleanup = Date.now();
      await this.prisma.publicationCollectorRequestNonce.deleteMany({
        where: { receivedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) } },
      });
    }
    const reportedHost = request.headers["x-collector-panel-host"];
    const panelHost = reportedHost && isIP(reportedHost) === 4 ? reportedHost : null;
    await this.prisma.publicationReadbackNode.upsert({
      create: { id, lastSeenAt: new Date(), panelHost, panelUrl: panelUrl?.href ?? null },
      update: {
        lastSeenAt: new Date(),
        ...(panelHost ? { panelHost } : {}),
        ...(panelUrl ? { panelUrl: panelUrl.href } : {}),
      },
      where: { id },
    });
    return true;
  }
}

function readNodeKeys(): Record<string, string> {
  let configured: Record<string, string> = {};
  try {
    const value: unknown = JSON.parse(process.env.PUBLICATION_READBACK_NODE_KEYS_JSON ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      configured = Object.fromEntries(
        Object.entries(value).filter(
          ([id, secret]) =>
            /^[a-zA-Z0-9_.-]{3,80}$/u.test(id) &&
            typeof secret === "string" &&
            secret.length >= 32 &&
            (process.env.NODE_ENV !== "production" || isProductionRandomSecret(secret, 32)),
        ),
      );
  } catch {
    // Malformed external-node configuration cannot grant an external identity.
  }
  const managed = managedReadbackNodeKey();
  if (managed) configured[MANAGED_READBACK_NODE_ID] = managed;
  else delete configured[MANAGED_READBACK_NODE_ID];
  return configured;
}
