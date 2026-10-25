import { LocalObjectStorage, type LocalObjectStorageOptions } from "./local-storage";
import {
  S3CompatibleObjectStorage,
  type S3CompatibleStorageOptions,
} from "./s3-compatible-storage";

export type ConfiguredObjectStorageOptions =
  | (S3CompatibleStorageOptions & Readonly<{ provider?: "S3" }>)
  | (LocalObjectStorageOptions & Readonly<{ provider: "LOCAL" }>);

export function createObjectStorage(
  options: ConfiguredObjectStorageOptions,
): LocalObjectStorage | S3CompatibleObjectStorage {
  return options.provider === "LOCAL"
    ? new LocalObjectStorage(options)
    : new S3CompatibleObjectStorage(options);
}
