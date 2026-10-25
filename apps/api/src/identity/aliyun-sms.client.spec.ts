import DysmsClient, { SendSmsResponse, SendSmsResponseBody } from "@alicloud/dysmsapi20170525";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AliyunSmsClient } from "./aliyun-sms.client";

const config = {
  accessKeyId: "LTAI-test-access-id",
  accessKeySecret: "private-access-secret",
  signName: "测试签名",
  templateCode: "SMS_123456",
};
const input = { phone: "13800138000", code: "527193", requestId: "request-correlation" };
afterEach(() => vi.restoreAllMocks());

describe("Aliyun administrator SMS", () => {
  it("uses the official SendSms API and the approved code template without retries", async () => {
    const send = vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockResolvedValue(
      new SendSmsResponse({
        body: new SendSmsResponseBody({
          code: "OK",
          bizId: "message-id",
          requestId: "request-id",
        }),
      }),
    );
    const result = await new AliyunSmsClient().send(config, input);
    expect(send).toHaveBeenCalledOnce();
    const [request, runtime] = send.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      phoneNumbers: input.phone,
      signName: config.signName,
      templateCode: config.templateCode,
      templateParam: JSON.stringify({ code: input.code }),
      outId: input.requestId,
    });
    expect(runtime).toMatchObject({ autoretry: false, maxAttempts: 1 });
    expect(result).toEqual({
      messageId: "message-id",
      requestId: "request-id",
      provider: "ALIYUN",
    });
  });
  it("treats an Aliyun business error in a successful HTTP response as a failure", async () => {
    vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockResolvedValue(
      new SendSmsResponse({
        statusCode: 200,
        body: new SendSmsResponseBody({
          code: "isv.SMS_TEMPLATE_ILLEGAL",
          message: "raw vendor response",
        }),
      }),
    );
    await expect(new AliyunSmsClient().send(config, input)).rejects.toThrow("TEMPLATE_CODE");
  });
  it("does not leak SDK requests, credentials, phone numbers or codes in errors", async () => {
    vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockRejectedValue({
      code: "SignatureDoesNotMatch",
      message: JSON.stringify({ config, input }),
      data: { config, input },
    });
    try {
      await new AliyunSmsClient().send(config, input);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).toContain("签名校验失败");
      const serialized = JSON.stringify(error);
      for (const secret of [config.accessKeyId, config.accessKeySecret, input.phone, input.code])
        expect(serialized).not.toContain(secret);
    }
  });
});
