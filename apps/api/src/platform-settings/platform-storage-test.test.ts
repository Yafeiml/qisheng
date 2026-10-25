import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformSettingsService } from "./platform-settings.service";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let uploaded = Buffer.alloc(0);
  const storage = {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(async ({ bytes }: { bytes: Buffer }) => {
      uploaded = Buffer.from(bytes);
      return { byteSize: bytes.length };
    }),
    signedGetUrl: vi
      .fn()
      .mockResolvedValue("https://storage.example/test?private-signed-credential"),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const fetcher = vi.fn(async () => new Response(uploaded));
  vi.stubGlobal("fetch", fetcher);
  const audit = vi.fn().mockResolvedValue({});
  const service = new PlatformSettingsService(
    { auditLog: { create: audit } } as never,
    { requireSaasAdmin: () => ({ userId: "admin", scope: { type: "PLATFORM" } }) } as never,
    { string: () => "actual-bucket" } as never,
    {} as never,
    {} as never,
    { current: async () => ({ storage }) } as never,
  );
  return { service, storage, audit, fetcher };
}

describe("storage connection test diagnostics", () => {
  it("identifies a denied bucket without attempting upload or deletion", async () => {
    const { service, storage, audit } = fixture();
    storage.ensureBucket.mockRejectedValue(
      Object.assign(new Error("private-provider-response"), { $metadata: { httpStatusCode: 403 } }),
    );
    const error = await service.testStorage("test").catch((e: unknown) => e);
    expect(error).toMatchObject({
      response: {
        code: "STORAGE_TEST_ACCESS_DENIED",
        message: expect.stringContaining("检查 Bucket 访问"),
        details: { httpStatus: 403, bucket: "actual-bucket" },
      },
    });
    expect(JSON.stringify(error)).not.toContain("private-provider-response");
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("identifies unsupported uploads and cleans up only the generated test key", async () => {
    const { service, storage, audit } = fixture();
    storage.put.mockRejectedValue(
      Object.assign(new Error("unsupported"), {
        name: "NotImplemented",
        $metadata: { httpStatusCode: 501 },
      }),
    );
    await expect(service.testStorage("test")).rejects.toMatchObject({
      response: {
        code: "STORAGE_TEST_UNSUPPORTED",
        message: expect.stringContaining("上传测试文件"),
      },
    });
    expect(storage.delete).toHaveBeenCalledWith(
      expect.stringMatching(/^platform-settings\/storage-test\/[\w-]+\.txt$/),
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it("identifies signed download failures without leaking the signed URL", async () => {
    const { service, storage, fetcher } = fixture();
    fetcher.mockResolvedValue(new Response("private-provider-response", { status: 403 }));
    const error = await service.testStorage("test").catch((e: unknown) => e);
    expect(error).toMatchObject({
      response: {
        code: "STORAGE_TEST_ACCESS_DENIED",
        message: expect.stringContaining("通过签名地址下载"),
      },
    });
    expect(JSON.stringify(error)).not.toContain("private-provider-response");
    expect(JSON.stringify(error)).not.toContain("private-signed-credential");
    expect(storage.delete).toHaveBeenCalledOnce();
  });

  it("rejects mismatched content without recording success", async () => {
    const { service, storage, audit, fetcher } = fixture();
    fetcher.mockResolvedValue(new Response("different content"));
    await expect(service.testStorage("test")).rejects.toMatchObject({
      response: { code: "STORAGE_TEST_CHECKSUM_MISMATCH" },
    });
    expect(audit).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledOnce();
  });

  it("records success only after completing the signed round trip", async () => {
    const { service, storage, audit } = fixture();
    await expect(service.testStorage("test")).resolves.toMatchObject({
      bucket: "actual-bucket",
      signedReadVerified: true,
    });
    expect(audit).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledOnce();
  });
});
