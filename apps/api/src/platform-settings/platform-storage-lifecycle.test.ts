import { ConflictException } from "@nestjs/common";
import {
  type ObjectStorageLifecycleState,
  StorageManagementError,
} from "@xhs-agentic/object-storage";
import { describe, expect, it, vi } from "vitest";
import { PlatformSettingsService } from "./platform-settings.service";

describe("storage lifecycle application", () => {
  const ready: ObjectStorageLifecycleState = {
    enabled: true,
    versioning: "ENABLED",
    noncurrentVersionExpirationDays: 30,
    abortIncompleteMultipartUploadDays: 7,
  };

  function fixture(state: ObjectStorageLifecycleState, versioningRequired = true) {
    const audit = vi.fn();
    const storage = {
      ensureBucket: vi.fn(),
      applyLifecyclePolicy: vi.fn().mockResolvedValue(state),
    };
    const service = new PlatformSettingsService(
      { auditLog: { create: audit } } as never,
      { requireSaasAdmin: () => ({ userId: "admin", scope: { type: "PLATFORM" } }) } as never,
      {
        boolean: () => versioningRequired,
        number: (key: string) => (key === "storage.abort_incomplete_upload_days" ? 7 : 30),
      } as never,
      {} as never,
      {} as never,
      { current: async () => ({ storage }) } as never,
    );
    return { audit, service, storage };
  }

  it.each([
    { ...ready, enabled: false, versioning: "DISABLED", noncurrentVersionExpirationDays: null },
    { ...ready, versioning: "SUSPENDED" },
    { ...ready, enabled: false },
    { ...ready, noncurrentVersionExpirationDays: 7 },
  ])("rejects a successful request whose readback does not match: %j", async (state) => {
    const { service, audit } = fixture(state as ObjectStorageLifecycleState);
    const application = service.applyStorageLifecycle("test");
    await expect(application).rejects.toBeInstanceOf(ConflictException);
    await expect(application).rejects.toMatchObject({
      response: {
        code: "STORAGE_LIFECYCLE_NOT_EFFECTIVE",
        message: expect.stringContaining("不能确认应用成功"),
      },
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("records success only when versioning and retention are confirmed", async () => {
    const { service, audit, storage } = fixture(ready);
    await expect(service.applyStorageLifecycle("confirmed")).resolves.toEqual(ready);
    expect(storage.ensureBucket).toHaveBeenCalledWith(false);
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "platform-setting.storage-lifecycle.apply",
        metadata: ready,
      }),
    });
  });

  it("does not call cloud management APIs when versioning is optional", async () => {
    const { service, storage, audit } = fixture(ready, false);
    await expect(service.applyStorageLifecycle("test")).rejects.toMatchObject({
      response: { code: "STORAGE_VERSIONING_NOT_REQUIRED" },
    });
    expect(storage.ensureBucket).not.toHaveBeenCalled();
    expect(storage.applyLifecyclePolicy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    [501, "STORAGE_MANAGEMENT_UNSUPPORTED"],
    [401, "STORAGE_MANAGEMENT_ACCESS_DENIED"],
    [403, "STORAGE_MANAGEMENT_ACCESS_DENIED"],
    [404, "STORAGE_MANAGEMENT_NOT_FOUND"],
    [503, "STORAGE_MANAGEMENT_FAILED"],
  ])("translates provider HTTP %s without exposing its response", async (httpStatus, code) => {
    const { service, audit, storage } = fixture(ready);
    storage.applyLifecyclePolicy.mockRejectedValue(
      new StorageManagementError(
        "VERSIONING",
        Object.assign(new Error("private-provider-response-with-credentials"), {
          $metadata: { httpStatusCode: httpStatus },
        }),
      ),
    );
    const error = await service
      .applyStorageLifecycle("test")
      .catch((value: { getResponse(): unknown }) => value);
    expect(error).toMatchObject({
      response: {
        code,
        message: expect.stringContaining("启用 Bucket 版本控制失败"),
        details: { operation: "VERSIONING", httpStatus },
      },
    });
    expect(JSON.stringify(error)).not.toContain("private-provider-response");
    expect(audit).not.toHaveBeenCalled();
  });
});
