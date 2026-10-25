import { Inject, Injectable } from "@nestjs/common";
import { materialArtifactObjectKey } from "@xhs-agentic/object-storage";
import { PlatformAssetDeliveryService } from "../platform-settings/platform-asset-delivery.service";
import { PlatformObjectStorageService } from "../platform-settings/platform-object-storage.service";

@Injectable()
export class MaterialStorageService {
  constructor(
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
    @Inject(PlatformAssetDeliveryService)
    private readonly assetDelivery: PlatformAssetDeliveryService,
  ) {}

  objectKey(input: {
    artifactId: string;
    fileName: string;
    materialId: string;
    tenantId: string;
  }): string {
    return materialArtifactObjectKey(input);
  }

  async signedUpload(input: { byteSize: number; key: string; mimeType: string }): Promise<string> {
    const { signedUrlTtlSeconds, storage } = await this.objectStorage.current();
    await storage.ensureBucket(process.env.NODE_ENV !== "production");
    return storage.signedPutUrl(input, signedUrlTtlSeconds);
  }

  async head(key: string) {
    const { storage } = await this.objectStorage.current();
    return storage.head(key);
  }

  async delete(key: string): Promise<void> {
    const { storage } = await this.objectStorage.current();
    await storage.delete(key);
  }

  async signedPreview(key: string): Promise<string> {
    return this.assetDelivery.signedUrl(key);
  }

  async readPreviewSource(key: string, maxBytes: number): Promise<Uint8Array> {
    const { storage } = await this.objectStorage.current();
    return storage.get(key, maxBytes);
  }
}
