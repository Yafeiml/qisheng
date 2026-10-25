import DysmsClient, { QuerySendDetailsRequest, SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@darabonba/typescript";

export type AliyunSmsConfiguration = Readonly<{
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
}>;

export class AliyunSmsError extends Error {
  constructor(
    readonly providerCode: string,
    readonly uncertain: boolean,
    readonly retryable: boolean,
  ) {
    super(`Aliyun SMS: ${providerCode}`);
    this.name = "AliyunSmsError";
  }
}

export type AliyunSmsDeliveryResult = Readonly<{
  status: "PENDING" | "DELIVERED" | "FAILED";
  code: string | null;
  deliveredAt: Date | null;
}>;

export async function queryAliyunSmsDelivery(
  configuration: Pick<AliyunSmsConfiguration, "accessKeyId" | "accessKeySecret">,
  input: Readonly<{
    phone: string;
    bizId: string;
    requestId: string;
    templateCode: string;
    sentAt: Date;
  }>,
): Promise<AliyunSmsDeliveryResult | null> {
  const client = new DysmsClient(
    new $OpenApiUtil.Config({
      ...configuration,
      endpoint: "dysmsapi.aliyuncs.com",
      regionId: "cn-hangzhou",
      protocol: "https",
    }),
  );
  const sendDate = new Date(input.sentAt.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  try {
    const response = await client.querySendDetailsWithOptions(
      new QuerySendDetailsRequest({
        bizId: input.bizId,
        phoneNumber: input.phone,
        sendDate: sendDate.replaceAll("-", ""),
        currentPage: 1,
        pageSize: 50,
      }),
      new RuntimeOptions({
        autoretry: false,
        maxAttempts: 1,
        connectTimeout: 5000,
        readTimeout: 10000,
      }),
    );
    if (response.body?.code !== "OK") throw smsError(response.body?.code, false);
    const matches = (response.body.smsSendDetailDTOs?.smsSendDetailDTO ?? []).filter(
      (detail) =>
        detail.phoneNum === input.phone &&
        detail.outId === input.requestId &&
        detail.templateCode === input.templateCode &&
        detail.sendDate?.slice(0, 10) === sendDate,
    );
    // Require all identifiers; a phone-only match could be a login verification SMS.
    if (matches.length !== 1 || ![1, 2, 3].includes(matches[0]?.sendStatus ?? 0)) return null;
    const detail = matches[0];
    if (!detail) return null;
    const code =
      typeof detail.errCode === "string" && /^[A-Za-z0-9_.:-]{1,100}$/u.test(detail.errCode)
        ? detail.errCode
        : null;
    const received =
      detail.receiveDate && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(detail.receiveDate)
        ? new Date(`${detail.receiveDate.replace(" ", "T")}+08:00`)
        : null;
    return {
      status:
        detail.sendStatus === 3 ? "DELIVERED" : detail.sendStatus === 2 ? "FAILED" : "PENDING",
      code,
      deliveredAt: received && Number.isFinite(received.getTime()) ? received : null,
    };
  } catch (error) {
    if (error instanceof AliyunSmsError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    throw smsError(code, true);
  }
}

export function isInvalidAliyunSmsNumber(code: string | null | undefined): boolean {
  // Only unambiguous documented codes; INVALID_NUMBER also includes switched-off phones.
  return [
    "isv.MOBILE_NUMBER_ILLEGAL",
    "MX:0010",
    "MK:0001",
    "MK:0012",
    "SMGP640",
    "SMGP840",
  ].includes(code ?? "");
}

export async function sendAliyunSms(
  configuration: AliyunSmsConfiguration,
  input: Readonly<{
    phone: string;
    requestId: string;
    templateCode: string;
    templateParams: Record<string, string>;
  }>,
) {
  const client = new DysmsClient(
    new $OpenApiUtil.Config({
      ...configuration,
      endpoint: "dysmsapi.aliyuncs.com",
      regionId: "cn-hangzhou",
      protocol: "https",
      connectTimeout: 5000,
      readTimeout: 10000,
    }),
  );
  try {
    const response = await client.sendSmsWithOptions(
      new SendSmsRequest({
        phoneNumbers: input.phone,
        signName: configuration.signName,
        templateCode: input.templateCode,
        templateParam: JSON.stringify(input.templateParams),
        outId: input.requestId,
      }),
      new RuntimeOptions({
        autoretry: false,
        maxAttempts: 1,
        connectTimeout: 5000,
        readTimeout: 10000,
      }),
    );
    if (response.body?.code !== "OK") throw smsError(response.body?.code, false);
    if (!response.body.bizId || !response.body.requestId) throw smsError("INVALID_RESPONSE", true);
    return {
      messageId: response.body.bizId,
      requestId: response.body.requestId,
      provider: "ALIYUN" as const,
    };
  } catch (error) {
    if (error instanceof AliyunSmsError) throw error;
    // SDK errors may contain signed requests and personal data; retain only a bounded code.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    throw smsError(code, true);
  }
}

function smsError(rawCode: unknown, uncertain: boolean) {
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,100}$/u.test(rawCode)
      ? rawCode
      : "REQUEST_FAILED";
  return new AliyunSmsError(
    code,
    uncertain || code === "REQUEST_FAILED",
    !uncertain && ["isv.BUSINESS_LIMIT_CONTROL", "SYSTEM_ERROR", "isv.SYSTEM_ERROR"].includes(code),
  );
}
