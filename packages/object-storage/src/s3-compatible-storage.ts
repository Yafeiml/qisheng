import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  ObjectStorage,
  PutObjectRequest,
  SignedPutObjectRequest,
  StoredObject,
  StoredObjectMetadata,
} from "./types";

export interface S3CompatibleStorageOptions {
  accessKeyId: string;
  bucket: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  region: string;
  secretAccessKey: string;
}

export type ObjectStorageLifecyclePolicy = Readonly<{
  abortIncompleteMultipartUploadDays: number;
  noncurrentVersionExpirationDays: number;
}>;

export type ObjectStorageLifecycleState = Readonly<{
  abortIncompleteMultipartUploadDays: number | null;
  enabled: boolean;
  noncurrentVersionExpirationDays: number | null;
  versioning: "DISABLED" | "ENABLED" | "SUSPENDED";
}>;

export class StorageManagementError extends Error {
  constructor(
    readonly operation: "VERSIONING" | "LIFECYCLE" | "READBACK",
    cause: unknown,
  ) {
    super(`Storage management failed: ${operation}`, { cause });
    this.name = "StorageManagementError";
  }
}

async function manageStorage<T>(
  operation: StorageManagementError["operation"],
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new StorageManagementError(operation, error);
  }
}

export class S3CompatibleObjectStorage implements ObjectStorage {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3CompatibleStorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      region: options.region,
    });
  }

  async ensureBucket(createWhenMissing = false): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!createWhenMissing) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async lifecycleState(): Promise<ObjectStorageLifecycleState> {
    const [versioning, lifecycle] = await Promise.all([
      this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket })),
      this.client
        .send(new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }))
        .catch((error: unknown) => (missingLifecycle(error) ? undefined : Promise.reject(error))),
    ]);
    const versionRule = lifecycle?.Rules?.find(
      ({ ID }) => ID === "xhs-agentic-version-governance-v1",
    );
    const uploadRule = lifecycle?.Rules?.find(
      ({ ID }) => ID === "xhs-agentic-incomplete-upload-cleanup-v1",
    );
    return {
      abortIncompleteMultipartUploadDays:
        uploadRule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
      enabled: versionRule?.Status === "Enabled",
      noncurrentVersionExpirationDays:
        versionRule?.NoncurrentVersionExpiration?.NoncurrentDays ?? null,
      versioning:
        versioning.Status === "Enabled"
          ? "ENABLED"
          : versioning.Status === "Suspended"
            ? "SUSPENDED"
            : "DISABLED",
    };
  }

  async applyLifecyclePolicy(
    policy: ObjectStorageLifecyclePolicy,
  ): Promise<ObjectStorageLifecycleState> {
    assertLifecycleDays(
      policy.abortIncompleteMultipartUploadDays,
      "Incomplete multipart upload retention",
      1,
      30,
    );
    assertLifecycleDays(
      policy.noncurrentVersionExpirationDays,
      "Noncurrent object version retention",
      1,
      3650,
    );
    await manageStorage("VERSIONING", () =>
      this.client.send(
        new PutBucketVersioningCommand({
          Bucket: this.bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      ),
    );
    const versionRule = {
      Expiration: { ExpiredObjectDeleteMarker: true },
      Filter: { Prefix: "" },
      ID: "xhs-agentic-version-governance-v1",
      NoncurrentVersionExpiration: {
        NoncurrentDays: policy.noncurrentVersionExpirationDays,
      },
      Status: "Enabled" as const,
    };
    await manageStorage("LIFECYCLE", async () => {
      try {
        await this.client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: this.bucket,
            LifecycleConfiguration: {
              Rules: [
                versionRule,
                {
                  AbortIncompleteMultipartUpload: {
                    DaysAfterInitiation: policy.abortIncompleteMultipartUploadDays,
                  },
                  Filter: { Prefix: "" },
                  ID: "xhs-agentic-incomplete-upload-cleanup-v1",
                  Status: "Enabled",
                },
              ],
            },
          }),
        );
      } catch (error) {
        if (!unsupportedIncompleteUploadLifecycle(error)) throw error;
        await this.client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: this.bucket,
            LifecycleConfiguration: { Rules: [versionRule] },
          }),
        );
      }
    });
    return manageStorage("READBACK", () => this.lifecycleState());
  }

  async get(key: string, maxBytes = 26_214_400): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error("Object response did not contain a body");
    if (response.ContentLength && response.ContentLength > maxBytes) {
      throw new Error("Object exceeds the permitted read size");
    }
    const bytes = await response.Body.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new Error("Object exceeds the permitted read size");
    return bytes;
  }

  async head(key: string): Promise<StoredObjectMetadata> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return {
      byteSize: response.ContentLength ?? 0,
      checksum: response.Metadata?.sha256,
      contentType: response.ContentType,
      etag: response.ETag?.replaceAll('"', ""),
      key,
    };
  }

  async put(request: PutObjectRequest): Promise<StoredObject> {
    assertChecksum(request.bytes, request.checksum);
    const response = await this.client.send(
      new PutObjectCommand({
        Body: request.bytes,
        Bucket: this.bucket,
        ChecksumSHA256: Buffer.from(request.checksum, "hex").toString("base64"),
        ContentLength: request.bytes.byteLength,
        ContentType: request.mimeType,
        Key: request.key,
        Metadata: { sha256: request.checksum },
      }),
    );
    return {
      byteSize: request.bytes.byteLength,
      checksum: request.checksum,
      etag: response.ETag?.replaceAll('"', "") ?? request.checksum,
      key: request.key,
    };
  }

  async signedGetUrl(key: string, expiresInSeconds = 900): Promise<string> {
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 60 ||
      expiresInSeconds > 3600
    ) {
      throw new Error("Signed object URL expiry must be between 60 and 3600 seconds");
    }
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async signedPutUrl(request: SignedPutObjectRequest, expiresInSeconds = 900): Promise<string> {
    assertSignedUrlExpiry(expiresInSeconds);
    if (!Number.isSafeInteger(request.byteSize) || request.byteSize < 1) {
      throw new Error("Signed object upload requires a positive byte size");
    }
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        ContentLength: request.byteSize,
        ContentType: request.mimeType,
        Key: request.key,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}

function assertSignedUrlExpiry(expiresInSeconds: number): void {
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3600) {
    throw new Error("Signed object URL expiry must be between 60 and 3600 seconds");
  }
}

function assertChecksum(bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("Object bytes do not match the declared checksum");
}

function assertLifecycleDays(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max} days`);
  }
}

function missingLifecycle(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code =
    "name" in error && typeof error.name === "string"
      ? error.name
      : "Code" in error && typeof error.Code === "string"
        ? error.Code
        : undefined;
  return code === "NoSuchLifecycleConfiguration";
}

function unsupportedIncompleteUploadLifecycle(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status =
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
      ? error.$metadata.httpStatusCode
      : undefined;
  const code = "Code" in error && typeof error.Code === "string" ? error.Code : undefined;
  return status === 400 && code === "InvalidArgument";
}
