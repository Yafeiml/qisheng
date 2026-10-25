import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Put,
  Req,
  Res,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { LocalObjectStorage } from "@xhs-agentic/object-storage";
import { safeContentType } from "./platform-asset-delivery.service";
import { PlatformObjectStorageService } from "./platform-object-storage.service";

const MAX_OBJECT_BYTES = 26_214_400;
type UploadRequest = IncomingMessage & { body?: unknown; rawBody?: Buffer };
type ObjectResponse = {
  setHeader(name: string, value: number | string): void;
  status(code: number): ObjectResponse;
  send(body?: Uint8Array): void;
};

@ApiExcludeController()
@Controller("storage/objects")
export class LocalObjectStorageController {
  constructor(
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
  ) {}

  @Get(":token")
  async get(@Param("token") token: string, @Res() response: ObjectResponse): Promise<void> {
    try {
      const storage = await this.localStorage();
      const request = storage.verifySignedRequest(token, "GET");
      const metadata = await storage.head(request.key);
      const bytes = await storage.get(request.key, MAX_OBJECT_BYTES);
      const contentType = safeContentType(metadata.contentType);
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Content-Type", contentType);
      response.setHeader("Content-Length", bytes.byteLength);
      response.setHeader(
        "Content-Disposition",
        contentType === "application/octet-stream" ? "attachment" : "inline",
      );
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      if (metadata.etag) response.setHeader("ETag", `"${metadata.etag}"`);
      response.status(200).send(bytes);
    } catch {
      throw new NotFoundException("Object was not found");
    }
  }

  @Put(":token")
  async put(
    @Param("token") token: string,
    @Req() request: UploadRequest,
    @Res() response: ObjectResponse,
  ): Promise<void> {
    let storage: LocalObjectStorage;
    let signed: ReturnType<LocalObjectStorage["verifySignedRequest"]>;
    try {
      storage = await this.localStorage();
      signed = storage.verifySignedRequest(token, "PUT");
    } catch {
      throw new NotFoundException("Upload was not found");
    }
    if (signed.method !== "PUT") throw new NotFoundException("Upload was not found");
    if (signed.byteSize > MAX_OBJECT_BYTES) throw new PayloadTooLargeException();
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== signed.mimeType.toLowerCase())
      throw new BadRequestException("Upload content type does not match its signed request");
    const declared = request.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^\d+$/u.test(declared) || Number(declared) !== signed.byteSize)
    )
      throw new BadRequestException("Upload length does not match its signed request");
    const bytes = await readUpload(request, signed.byteSize);
    await storage.put({
      bytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      key: signed.key,
      mimeType: signed.mimeType,
    });
    response.setHeader("Cache-Control", "no-store");
    response.status(204).send();
  }

  private async localStorage(): Promise<LocalObjectStorage> {
    const { storage } = await this.objectStorage.current();
    if (!(storage instanceof LocalObjectStorage)) throw new NotFoundException();
    return storage;
  }
}

async function readUpload(request: UploadRequest, expectedBytes: number): Promise<Buffer> {
  const parsed = request.rawBody ?? request.body;
  if (Buffer.isBuffer(parsed)) {
    if (parsed.length > expectedBytes) throw new PayloadTooLargeException();
    if (parsed.length !== expectedBytes) throw new BadRequestException("Upload length mismatch");
    return parsed;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > expectedBytes) throw new PayloadTooLargeException();
    chunks.push(bytes);
  }
  if (size !== expectedBytes) throw new BadRequestException("Upload length mismatch");
  return Buffer.concat(chunks, size);
}
