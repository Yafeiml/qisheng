import { Inject, Injectable } from "@nestjs/common";
import { PlatformAssetDeliveryService } from "../platform-settings/platform-asset-delivery.service";
import { PlatformObjectStorageService } from "../platform-settings/platform-object-storage.service";

type DeliverableImage = Readonly<{
  byteSize?: bigint | null;
  imageUrl: string;
  storageKey?: string | null;
}>;

@Injectable()
export class ImageDeliveryService {
  constructor(
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
    @Inject(PlatformAssetDeliveryService)
    private readonly assetDelivery: PlatformAssetDeliveryService,
  ) {}

  async checkReadiness(): Promise<void> {
    const { storage } = await this.objectStorage.current();
    await storage.ensureBucket(false);
  }

  async signImages<T extends DeliverableImage>(images: readonly T[]) {
    return Promise.all(
      images.map(async (image) => ({
        ...image,
        byteSize: image.byteSize?.toString() ?? null,
        imageUrl: image.storageKey
          ? await this.assetDelivery.signedUrl(image.storageKey)
          : image.imageUrl,
      })),
    );
  }
}
