import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { PlatformAssetDeliveryService } from "./platform-asset-delivery.service";

type AssetResponse = Readonly<{
  send(body: Uint8Array): void;
  setHeader(name: string, value: number | string): void;
  status(code: number): AssetResponse;
}>;

@ApiExcludeController()
@Controller()
export class AssetDeliveryController {
  constructor(
    @Inject(PlatformAssetDeliveryService)
    private readonly delivery: PlatformAssetDeliveryService,
  ) {}

  @Get("assets/:token")
  async get(@Param("token") token: string, @Res() response: AssetResponse): Promise<void> {
    const asset = await this.delivery.read(token);
    response.setHeader("Cache-Control", `public, max-age=${asset.cacheSeconds}, immutable`);
    response.setHeader("Content-Length", asset.byteSize);
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (asset.etag) response.setHeader("ETag", `"${asset.etag}"`);
    response.status(200).send(asset.bytes);
  }
}
