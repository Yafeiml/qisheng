import DysmsClient, {
  QuerySendDetailsResponse,
  QuerySendDetailsResponseBody,
  SendSmsResponse,
  SendSmsResponseBody,
} from "@alicloud/dysmsapi20170525";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInvalidAliyunSmsNumber, queryAliyunSmsDelivery, sendAliyunSms } from "./index";

const configuration = {
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  signName: "测试签名",
};
const input = {
  phone: "13800138000",
  requestId: "notification-id",
  templateCode: "SMS_123",
  templateParams: {},
};
afterEach(() => vi.restoreAllMocks());

describe("shared Aliyun SMS transport", () => {
  it("sends the notification template with empty parameters instead of a verification code", async () => {
    const send = vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockResolvedValue(
      new SendSmsResponse({
        body: new SendSmsResponseBody({ code: "OK", bizId: "biz", requestId: "request" }),
      }),
    );
    await expect(sendAliyunSms(configuration, input)).resolves.toMatchObject({ messageId: "biz" });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      templateCode: "SMS_123",
      templateParam: "{}",
      outId: input.requestId,
    });
    expect(send.mock.calls[0]?.[1]).toMatchObject({ autoretry: false, maxAttempts: 1 });
  });

  it("allows bounded retries only after an explicit transient rejection", async () => {
    vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockResolvedValue(
      new SendSmsResponse({
        body: new SendSmsResponseBody({ code: "isv.BUSINESS_LIMIT_CONTROL" }),
      }),
    );
    await expect(sendAliyunSms(configuration, input)).rejects.toMatchObject({
      uncertain: false,
      retryable: true,
    });
  });

  it("keeps timeouts uncertain and removes SDK request data from the error", async () => {
    vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockRejectedValue({
      code: "ReadTimeout",
      data: { configuration, input },
    });
    const error = await sendAliyunSms(configuration, input).catch((error: unknown) => error);
    expect(error).toMatchObject({ providerCode: "ReadTimeout", uncertain: true, retryable: false });
    for (const secret of [configuration.accessKeySecret, input.phone])
      expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("never retries an accepted response with missing delivery identifiers", async () => {
    vi.spyOn(DysmsClient.prototype, "sendSmsWithOptions").mockResolvedValue(
      new SendSmsResponse({ body: new SendSmsResponseBody({ code: "OK" }) }),
    );
    await expect(sendAliyunSms(configuration, input)).rejects.toMatchObject({
      uncertain: true,
      retryable: false,
    });
  });
});

describe("Aliyun delivery queries", () => {
  const queryInput = { ...input, bizId: "biz", sentAt: new Date("2026-10-12T23:59:00Z") };
  function response(overrides: Record<string, unknown> = {}) {
    return new QuerySendDetailsResponse({
      body: new QuerySendDetailsResponseBody({
        code: "OK",
        smsSendDetailDTOs: {
          smsSendDetailDTO: [
            {
              phoneNum: input.phone,
              outId: input.requestId,
              templateCode: input.templateCode,
              sendDate: "2026-10-13 07:59:01",
              receiveDate: "2026-10-13 08:00:00",
              sendStatus: 3,
              errCode: "DELIVERED",
              content: "验证码不应外泄",
              ...overrides,
            },
          ],
        },
      }),
    });
  }
  it("queries the BizId and Shanghai date, returns only the matching notification result", async () => {
    const query = vi
      .spyOn(DysmsClient.prototype, "querySendDetailsWithOptions")
      .mockResolvedValue(response());
    expect(await queryAliyunSmsDelivery(configuration, queryInput)).toEqual({
      status: "DELIVERED",
      code: "DELIVERED",
      deliveredAt: new Date("2026-10-13T00:00:00Z"),
    });
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      bizId: "biz",
      phoneNumber: input.phone,
      sendDate: "20261013",
    });
    expect(query.mock.calls[0]?.[1]).toMatchObject({ autoretry: false, maxAttempts: 1 });
  });
  it.each([
    { phoneNum: "13900000000" },
    { outId: "otp-id" },
    { templateCode: "SMS_OTP" },
    { sendDate: "2026-10-12 07:59:01" },
  ])(
    "ignores records belonging to another recipient, event, template or date: %j",
    async (mismatch) => {
      vi.spyOn(DysmsClient.prototype, "querySendDetailsWithOptions").mockResolvedValue(
        response(mismatch),
      );
      expect(await queryAliyunSmsDelivery(configuration, queryInput)).toBeNull();
    },
  );
  it("does not classify broad status, temporary failures or channel errors as a wrong phone", () => {
    for (const code of [
      "INVALID_NUMBER",
      "MOBILE_NOT_ON_SERVICE",
      "PORT_NOT_REGISTERED",
      "NO_ROUTE",
      "R:00004",
      "R:00014",
      "UNKNOWN",
    ])
      expect(isInvalidAliyunSmsNumber(code)).toBe(false);
    for (const code of ["isv.MOBILE_NUMBER_ILLEGAL", "MK:0001", "SMGP640", "MX:0010"])
      expect(isInvalidAliyunSmsNumber(code)).toBe(true);
  });
  it("sanitizes SDK query failures without exposing signed requests or content", async () => {
    vi.spyOn(DysmsClient.prototype, "querySendDetailsWithOptions").mockRejectedValue({
      code: "ReadTimeout",
      data: configuration,
    });
    const error = await queryAliyunSmsDelivery(configuration, queryInput).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ providerCode: "ReadTimeout", uncertain: true });
    expect(JSON.stringify(error)).not.toContain(configuration.accessKeySecret);
  });
});
