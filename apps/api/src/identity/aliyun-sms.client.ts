import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AliyunSmsError, sendAliyunSms } from "@xhs-agentic/sms";
import type { AliyunSmsConfiguration } from "../platform-settings/admin-sms.configuration";

@Injectable()
export class AliyunSmsClient {
  async send(
    configuration: AliyunSmsConfiguration,
    input: Readonly<{
      phone: string;
      code?: string;
      requestId: string;
      templateCode?: string;
      templateParams?: Record<string, string>;
    }>,
  ) {
    try {
      return await sendAliyunSms(configuration, {
        phone: input.phone,
        requestId: input.requestId,
        templateCode: input.templateCode ?? configuration.templateCode,
        templateParams: input.templateParams ?? { code: input.code ?? "" },
      });
    } catch (error) {
      throw smsFailure(error instanceof AliyunSmsError ? error.providerCode : undefined);
    }
  }
}

function smsFailure(rawCode: unknown) {
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,100}$/u.test(rawCode)
      ? rawCode
      : "REQUEST_FAILED";
  const messages: Record<string, string> = {
    "InvalidAccessKeyId.NotFound": "ACCESS_KEY_ID 无效或已被删除",
    SignatureDoesNotMatch: "AccessKey 签名校验失败，请检查 ACCESS_KEY_SECRET",
    "isv.SMS_SIGNATURE_ILLEGAL": "短信签名不可用，请检查 SIGN_NAME 是否已审核通过",
    "isv.SMS_TEMPLATE_ILLEGAL": "短信模板不可用，请检查 TEMPLATE_CODE 是否已审核通过",
    "isv.TEMPLATE_MISSING_PARAMETERS": "短信模板缺少所需变量，请核对对应业务的模板参数",
    "isv.TEMPLATE_PARAM_ILLEGAL": "短信模板参数不匹配，请核对对应业务的模板参数",
    "isv.BUSINESS_LIMIT_CONTROL": "短信发送过于频繁，请稍后重试",
    "isv.AMOUNT_NOT_ENOUGH": "阿里云短信账户余额不足",
    "isv.MOBILE_NUMBER_ILLEGAL": "接收手机号不正确",
    "Forbidden.RAM": "AccessKey 没有短信发送权限",
    AccessDenied: "AccessKey 没有短信发送权限",
    ReadTimeout: "阿里云短信响应超时，请稍后检查手机是否收到短信",
    ConnectTimeout: "连接阿里云短信超时，请稍后重试",
  };
  return new ServiceUnavailableException({
    code: "ADMIN_SMS_UNAVAILABLE",
    providerCode: code,
    message: `阿里云短信：${messages[code] ?? `发送未确认成功（${code}），请检查阿里云短信控制台`}`,
  });
}
