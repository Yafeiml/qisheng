import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

type SignedRequest = {
  headers: Record<string, string | undefined>;
  method: string;
  originalUrl: string;
  rawBody?: Buffer;
};

/** The collector key never enters platform settings, browser pages or an LLM tool result. */
@Injectable()
export class PublicationCollectorGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SignedRequest>();
    const secret = process.env.PUBLICATION_COLLECTOR_HMAC_KEY ?? "";
    const collectorId = process.env.PUBLICATION_COLLECTOR_ID ?? "";
    const id = request.headers["x-collector-id"];
    const timestamp = request.headers["x-collector-timestamp"];
    const requestId = request.headers["x-collector-request-id"];
    const signature = request.headers["x-collector-signature"];
    const seconds = Number(timestamp);
    if (
      secret.length < 32 ||
      (process.env.NODE_ENV === "production" && !isProductionRandomSecret(secret, 32)) ||
      !/^[a-zA-Z0-9_.-]{3,80}$/u.test(collectorId) ||
      id !== collectorId ||
      !/^\d{10}$/u.test(timestamp ?? "") ||
      !Number.isSafeInteger(seconds) ||
      Math.abs(Math.floor(Date.now() / 1000) - seconds) > 300 ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(requestId ?? "") ||
      !/^[a-f\d]{64}$/iu.test(signature ?? "") ||
      request.originalUrl.includes("?")
    ) {
      throw new UnauthorizedException("采集端身份校验失败");
    }
    const bodyDigest = createHash("sha256")
      .update(request.rawBody ?? Buffer.alloc(0))
      .digest("hex");
    const signed = [request.method, request.originalUrl, timestamp, requestId, bodyDigest].join(
      "\n",
    );
    const expected = createHmac("sha256", secret).update(signed).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature ?? "", "hex"))) {
      throw new UnauthorizedException("采集端身份校验失败");
    }
    if (!requestId) throw new UnauthorizedException("采集端请求 ID 缺失");
    try {
      // A durable unique key closes replay across processes and restarts.
      await this.prisma.publicationCollectorRequestNonce.create({ data: { id: requestId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new UnauthorizedException("采集端请求已处理");
      }
      throw error;
    }
    return true;
  }
}
