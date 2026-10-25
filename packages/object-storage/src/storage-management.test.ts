import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3CompatibleObjectStorage, StorageManagementError } from "./s3-compatible-storage";

afterEach(() => vi.restoreAllMocks());

describe("storage management errors", () => {
  it.each(["VERSIONING", "LIFECYCLE", "READBACK"] as const)(
    "preserves the failed %s operation",
    async (operation) => {
      const failure = Object.assign(new Error("Not implemented"), {
        name: "NotImplemented",
        $metadata: { httpStatusCode: 501 },
      });
      const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue(undefined);
      if (operation !== "VERSIONING") send.mockResolvedValueOnce(undefined);
      if (operation === "READBACK") send.mockResolvedValueOnce(undefined);
      send.mockRejectedValueOnce(failure);
      const storage = new S3CompatibleObjectStorage({
        accessKeyId: "test",
        secretAccessKey: "test",
        bucket: "test",
        region: "us-east-1",
      });
      const result = storage.applyLifecyclePolicy({
        abortIncompleteMultipartUploadDays: 7,
        noncurrentVersionExpirationDays: 30,
      });
      await expect(result).rejects.toBeInstanceOf(StorageManagementError);
      await expect(result).rejects.toMatchObject({ operation, cause: failure });
      if (operation === "VERSIONING") expect(send).toHaveBeenCalledTimes(1);
    },
  );
});
