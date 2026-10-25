import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";

export type MailConfiguration = Readonly<{
  host: string;
  port: number;
  username: string;
  password: string;
  sender: string;
  fromName: string;
  recipient: string;
}>;

@Injectable()
export class NotificationMailer {
  async sendEmailVerification(configuration: MailConfiguration, link: string) {
    return this.sendMessage(
      configuration,
      "验证你的管理员邮箱",
      [
        "请打开以下链接，并点击确认按钮，完成管理员邮箱验证：",
        link,
        "链接 30 分钟内有效，只能使用一次。重新发送或修改邮箱后，旧链接将失效。",
        "如果不是你本人发起的操作，请忽略此邮件。",
      ].join("\n\n"),
    );
  }
  async sendTest(configuration: MailConfiguration) {
    return this.sendMessage(
      configuration,
      "通知邮件测试",
      "这是一封通知服务的测试邮件。收到此邮件表示 SMTP 发件配置可用。",
    );
  }

  async sendModelIncident(
    configuration: MailConfiguration,
    incident: {
      id: string;
      revision: number;
      routeLabel: string;
      textFailures: number;
      imageFailures: number;
    },
  ) {
    return this.sendMessage(
      configuration,
      "模型生成异常：需要平台管理员处理",
      [
        "多个独立生成任务经过多轮重试后仍然失败，系统已暂停受影响路由的新生成任务。",
        `影响范围：${incident.routeLabel}`,
        `连续重试失败任务：文案 ${incident.textFailures}，生图 ${incident.imageFailures}`,
        "请登录平台后台的模型管理页检查供应商状态，必要时修复配置并执行功能验证。",
        "已生成内容和其他业务功能不受该门禁影响。",
      ].join("\n"),
      `<qisheng-model-${incident.id}-${incident.revision}@notifications.example.invalid>`,
    );
  }

  private async sendMessage(
    configuration: MailConfiguration,
    subject: string,
    text: string,
    messageId?: string,
  ) {
    const transport = nodemailer.createTransport({
      auth: { user: configuration.username, pass: configuration.password },
      connectionTimeout: 10_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      greetingTimeout: 10_000,
      host: configuration.host,
      port: configuration.port,
      requireTLS: configuration.port !== 465,
      secure: configuration.port === 465,
      socketTimeout: 20_000,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
    try {
      const info = await transport.sendMail({
        from: { name: configuration.fromName, address: configuration.sender },
        to: configuration.recipient,
        subject,
        text,
        ...(messageId ? { messageId } : {}),
      });
      if (
        !info.accepted.some(
          (address) => address.toLowerCase() === configuration.recipient.toLowerCase(),
        )
      ) {
        throw Object.assign(new Error("SMTP server did not accept the recipient"), {
          code: "SMTP_RECIPIENT_NOT_ACCEPTED",
        });
      }
    } finally {
      transport.close();
    }
  }
}

export async function resolveMailConfiguration(
  settings: PlatformSettingsReader,
  recipientOverride?: string,
): Promise<MailConfiguration | null> {
  const values = await settings.resolveMany([
    "notification.registration_application_email",
    "notification.registration_smtp_host",
    "notification.registration_smtp_port",
    "notification.registration_smtp_username",
    "notification.registration_smtp_password",
    "notification.registration_smtp_sender",
    "notification.registration_smtp_from_name",
  ]);
  const setting = (key: string) => values.get(`notification.${key}`)?.value;
  const recipient = recipientOverride || String(setting("registration_application_email") ?? "");
  const host = String(setting("registration_smtp_host") || "smtpdm.aliyun.com");
  const port = Number(setting("registration_smtp_port") || 465);
  const sender = String(setting("registration_smtp_sender") ?? "");
  const username = String(setting("registration_smtp_username") || sender);
  const password = String(setting("registration_smtp_password") ?? "");
  const fromName = String(setting("registration_smtp_from_name") ?? "");
  if (!recipient || !host || !port || !sender || !password) return null;
  return { recipient, host, port, sender, username, password, fromName };
}
