import { createHash } from "node:crypto";
import { BadGatewayException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { WechatMiniappClient, WechatMiniappError } from "@xhs-agentic/wechat-miniapp";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { readWechatNotificationConfiguration } from "../platform-settings/wechat-notification.configuration";
import type {
  EmployeeNotificationConfigurationDto,
  LinkEmployeeWechatIdentityDto,
  RecordEmployeeSubscriptionDto,
} from "./employee-notifications.dto";

@Injectable()
export class EmployeeNotificationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
    @Inject(PlatformSettingsReader) private readonly settings: PlatformSettingsReader,
    @Inject(WechatMiniappClient) private readonly wechat: WechatMiniappClient,
  ) {}

  async configuration(): Promise<EmployeeNotificationConfigurationDto> {
    const { userId } = this.access.requireEmployee();
    const configuration = await readWechatNotificationConfiguration(this.settings);
    if (!configuration) {
      return {
        enabled: false,
        appId: null,
        templateId: null,
        identityLinked: false,
        identityVersion: null,
        authorizationGeneration: null,
        remainingSubscriptions: 0,
        subscriptionStatus: "NONE",
      };
    }
    const identity = await this.prisma.wechatMiniappIdentity.findUnique({
      where: { userId_appId: { userId, appId: configuration.appId } },
      include: { subscriptions: { where: { templateId: configuration.templateId } } },
    });
    const subscription = identity?.subscriptions[0];
    return {
      enabled: true,
      appId: configuration.appId,
      templateId: configuration.templateId,
      identityLinked: Boolean(identity),
      identityVersion: identity?.version ?? null,
      authorizationGeneration: identity ? (subscription?.authorizationGeneration ?? 1) : null,
      remainingSubscriptions: subscription?.remainingSubscriptions ?? 0,
      subscriptionStatus:
        subscription?.status === "ACCEPT" ||
        subscription?.status === "REJECT" ||
        subscription?.status === "BAN"
          ? subscription.status
          : "NONE",
    };
  }

  async linkIdentity(input: LinkEmployeeWechatIdentityDto) {
    const { userId } = this.access.requireEmployee();
    const configuration = await this.requireConfiguration();
    let result: Awaited<ReturnType<WechatMiniappClient["exchangeCode"]>>;
    try {
      result = await this.wechat.exchangeCode({
        appId: configuration.appId,
        appSecret: configuration.appSecret,
        code: input.code,
      });
    } catch (error) {
      throw new BadGatewayException({
        code: "WECHAT_IDENTITY_EXCHANGE_FAILED",
        providerCode: error instanceof WechatMiniappError ? error.code : "REQUEST_FAILED",
        message: "微信身份连接失败，请重试；若持续失败，请检查小程序凭据及微信接口 IP 白名单。",
      });
    }
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`miniapp-identity:${configuration.appId}:${userId}`}))`;
        const owner = await transaction.wechatMiniappIdentity.findUnique({
          where: { appId_openId: { appId: configuration.appId, openId: result.openId } },
        });
        if (owner && owner.userId !== userId)
          throw new ConflictException("此微信身份已关联其他员工账号，请联系平台管理员核实。");
        const previous = await transaction.wechatMiniappIdentity.findUnique({
          where: { userId_appId: { userId, appId: configuration.appId } },
        });
        if (previous)
          await transaction.$queryRaw`SELECT id FROM wechat_miniapp_identities WHERE id = ${previous.id} FOR UPDATE`;
        if (previous && previous.openId !== result.openId) {
          const sending = await transaction.employeeTaskNotification.count({
            where: { identityId: previous.id, status: "SENDING" },
          });
          if (sending > 0) throw new ConflictException("任务提醒正在发送，请稍后再切换微信身份。");
          await transaction.employeeNotificationSubscription.updateMany({
            where: { identityId: previous.id },
            data: {
              status: "NONE",
              remainingSubscriptions: 0,
              lastAuthorizedAt: null,
              version: { increment: 1 },
              authorizationGeneration: { increment: 1 },
            },
          });
        }
        const changed = !previous || previous.openId !== result.openId;
        const identity = await transaction.wechatMiniappIdentity.upsert({
          where: { userId_appId: { userId, appId: configuration.appId } },
          create: {
            userId,
            appId: configuration.appId,
            openId: result.openId,
            unionId: result.unionId,
          },
          update: {
            openId: result.openId,
            unionId: result.unionId ?? null,
            ...(changed ? { version: { increment: 1 } } : {}),
          },
        });
        if (changed)
          await transaction.auditLog.create({
            data: {
              action: "employee.wechat-identity.link",
              actorType: "USER",
              actorUserId: userId,
              resourceType: "WechatMiniappIdentity",
              resourceId: identity.id,
              stateAfter: { appId: configuration.appId, version: identity.version },
            },
          });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("此微信身份已关联其他员工账号，请联系平台管理员核实。");
      }
      throw error;
    }
    return this.configuration();
  }

  async recordSubscription(input: RecordEmployeeSubscriptionDto, requestKey: string) {
    const { userId } = this.access.requireEmployee();
    const configuration = await this.requireConfiguration();
    if (input.templateId !== configuration.templateId)
      throw new ConflictException("订阅模板已更新，请刷新任务页后重新订阅。");
    const id = createHash("sha256").update(`${userId}:${requestKey}`).digest("hex");
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`miniapp-identity:${configuration.appId}:${userId}`}))`;
      const identity = await transaction.wechatMiniappIdentity.findUnique({
        where: { userId_appId: { userId, appId: configuration.appId } },
      });
      if (!identity) throw new ConflictException("请先连接当前微信身份，再订阅任务提醒。");
      await transaction.$queryRaw`SELECT id FROM wechat_miniapp_identities WHERE id = ${identity.id} FOR UPDATE`;
      const status = input.status.toUpperCase();
      const previous = await transaction.employeeSubscriptionRequest.findUnique({ where: { id } });
      if (previous) {
        if (
          previous.identityId !== identity.id ||
          previous.templateId !== input.templateId ||
          previous.status !== status
        )
          throw new ConflictException("本次订阅请求标识已用于其他操作，请刷新后重试。");
        return;
      }
      if (identity.version !== input.identityVersion) {
        throw new ConflictException({
          code: "WECHAT_NOTIFICATION_IDENTITY_CHANGED",
          message: "当前微信身份已更新，请重新连接微信并授权任务通知。",
        });
      }
      const subscriptions = await transaction.$queryRaw<
        Array<{ authorization_generation: number }>
      >`
        SELECT authorization_generation FROM employee_notification_subscriptions
        WHERE identity_id = ${identity.id} AND template_id = ${input.templateId} FOR UPDATE
      `;
      if ((subscriptions[0]?.authorization_generation ?? 1) !== input.authorizationGeneration) {
        throw new ConflictException({
          code: "WECHAT_NOTIFICATION_AUTHORIZATION_CHANGED",
          message: "任务通知授权状态已更新，请刷新后重新授权。",
        });
      }
      await transaction.employeeSubscriptionRequest.create({
        data: { id, identityId: identity.id, templateId: input.templateId, status },
      });
      const subscription = await transaction.employeeNotificationSubscription.upsert({
        where: { identityId_templateId: { identityId: identity.id, templateId: input.templateId } },
        create: { identityId: identity.id, templateId: input.templateId },
        update: {},
      });
      await transaction.$executeRaw`
        UPDATE employee_notification_subscriptions
        SET status = ${status}, remaining_subscriptions = CASE WHEN ${status} = 'ACCEPT' THEN LEAST(remaining_subscriptions + 1, 20) ELSE 0 END,
            authorization_generation = authorization_generation + CASE WHEN ${status} IN ('REJECT', 'BAN') THEN 1 ELSE 0 END,
            last_authorized_at = NOW(), version = version + 1, updated_at = NOW()
        WHERE id = ${subscription.id}
      `;
      await transaction.auditLog.create({
        data: {
          action: "employee.notification.subscribe",
          actorType: "USER",
          actorUserId: userId,
          resourceType: "EmployeeNotificationSubscription",
          resourceId: subscription.id,
          stateAfter: { appId: configuration.appId, templateId: input.templateId, status },
        },
      });
    });
    return this.configuration();
  }

  private async requireConfiguration() {
    const configuration = await readWechatNotificationConfiguration(this.settings);
    if (!configuration) throw new ConflictException("任务通知尚未启用，当前仍可正常领取任务。");
    return configuration;
  }
}
