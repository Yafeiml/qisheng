import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@xhs-agentic/database";
import { isISO8601 } from "class-validator";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type {
  CreateCampaignEffectDto,
  GeoEffectPayloadDto,
  TransactionEffectPayloadDto,
} from "./campaign-effect.dto";

type Scope = { tenantId: string; enterpriseId: string };
const numberFields = [
  "leadCount",
  "transactionPeople",
  "orderCount",
  "receivedMinor",
  "refundMinor",
  "costMinor",
] as const;
const optionalNumberFields = ["consultationCount", "appointmentCount", "visitCount"] as const;

function text(value: unknown, name: string, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new BadRequestException(`${name}需要有效文本`);
  return value.trim();
}
function iso(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !isISO8601(value, { strict: true }) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new BadRequestException(`${name}需要有效 ISO 日期`);
  return new Date(value).toISOString();
}
function safeCount(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new BadRequestException(`${name}必须是非负安全整数或未知值`);
  return value;
}
function aggregateSource(value: unknown) {
  const source = text(value, "业务取证来源");
  if (/\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/u.test(source))
    throw new BadRequestException("取证来源只记录业务汇总依据，不能包含患者电话或身份证等个人信息");
  return source;
}

export function sanitizeObservationUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let url: URL;
  try {
    url = new URL(text(value, "证据 URL", 2048));
  } catch {
    throw new BadRequestException("证据 URL 必须是 HTTP(S) 地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new BadRequestException("证据 URL 必须是无凭据的 HTTP(S) 地址");
  for (const key of [...url.searchParams.keys()]) {
    if (
      /^(?:utm_|xsec_|session|token|access_token|auth|authorization|share_|tracking|trace)/iu.test(
        key,
      ) ||
      /^(?:spm|from|ref|referrer|fbclid|gclid|msclkid|sid|signature|sign|app_platform|app_version|timestamp)$/iu.test(
        key,
      )
    )
      url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString();
}

export function normalizeEffectObservation(input: CreateCampaignEffectDto, now = new Date()) {
  if (input.kind !== "GEO" && input.kind !== "TRANSACTION")
    throw new BadRequestException("观察类型无效");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload))
    throw new BadRequestException("观察数据不能为空");
  const observedAt = iso(input.observedAt, "观察时间");
  if (Date.parse(observedAt) > now.getTime() + 60_000)
    throw new BadRequestException("观察时间不能晚于当前时间一分钟");
  const raw = input.payload as unknown as Record<string, unknown>;
  if (input.kind === "GEO") {
    if (raw.surface !== "SEARCH" && raw.surface !== "AI")
      throw new BadRequestException("GEO 观察入口无效");
    if (raw.brandSeen !== null && typeof raw.brandSeen !== "boolean")
      throw new BadRequestException("品牌是否出现必须为真、假或未知");
    const payload: GeoEffectPayloadDto = {
      product: text(raw.product, "产品", 100),
      surface: raw.surface,
      query: text(raw.query, "查询", 500),
      brandSeen: raw.brandSeen,
      source: aggregateSource(raw.source),
    };
    const citationUrl = sanitizeObservationUrl(raw.citationUrl);
    const evidenceUrl = sanitizeObservationUrl(raw.evidenceUrl);
    if (citationUrl) payload.citationUrl = citationUrl;
    if (evidenceUrl) payload.evidenceUrl = evidenceUrl;
    return { kind: "GEO" as const, observedAt, payload };
  }
  if (raw.definition !== "PAID_ORDER" && raw.definition !== "COMPLETED_SERVICE")
    throw new BadRequestException("成交口径无效");
  if (raw.dataStatus !== "VERIFIED" && raw.dataStatus !== "UNKNOWN")
    throw new BadRequestException("取证状态无效");
  if (raw.currency !== "CNY") throw new BadRequestException("成交金额需使用 CNY 最小货币单位");
  const payload: TransactionEffectPayloadDto = {
    channel: text(raw.channel, "来源渠道", 100),
    cohortStart: iso(raw.cohortStart, "线索批次开始"),
    cohortEnd: iso(raw.cohortEnd, "线索批次结束"),
    conversionWindowEnd: iso(raw.conversionWindowEnd, "成交观察窗口"),
    definition: raw.definition,
    dataStatus: raw.dataStatus,
    leadCount: safeCount(raw.leadCount, "有效线索数"),
    transactionPeople: safeCount(raw.transactionPeople, "成交人数"),
    orderCount: safeCount(raw.orderCount, "成交订单数"),
    receivedMinor: safeCount(raw.receivedMinor, "实收金额"),
    refundMinor: safeCount(raw.refundMinor, "退款金额"),
    costMinor: safeCount(raw.costMinor, "获客成本"),
    currency: "CNY",
    source: aggregateSource(raw.source),
  };
  if (Date.parse(observedAt) < Date.parse(payload.cohortStart))
    throw new BadRequestException("不能记录尚未开始的线索批次观察");
  for (const field of optionalNumberFields)
    if (raw[field] !== undefined) payload[field] = safeCount(raw[field], field);
  if (
    Date.parse(payload.cohortStart) > Date.parse(payload.cohortEnd) ||
    Date.parse(payload.cohortEnd) > Date.parse(payload.conversionWindowEnd)
  )
    throw new BadRequestException("批次开始必须早于结束，结束不能晚于成交观察窗口");
  if (payload.dataStatus === "VERIFIED" && numberFields.some((field) => payload[field] === null))
    throw new BadRequestException("已核实成交记录必须具备核心人数、订单及金额；缺失请标记未知");
  if (
    payload.transactionPeople !== null &&
    payload.leadCount !== null &&
    payload.transactionPeople > payload.leadCount
  )
    throw new BadRequestException("成交人数不能超过该批去重有效线索数");
  if (
    payload.orderCount !== null &&
    payload.transactionPeople !== null &&
    payload.orderCount < payload.transactionPeople
  )
    throw new BadRequestException("成交订单数不能少于成交人数");
  if (
    payload.refundMinor !== null &&
    payload.receivedMinor !== null &&
    payload.refundMinor > payload.receivedMinor
  )
    throw new BadRequestException("退款不能超过该批实收金额");
  return { kind: "TRANSACTION" as const, observedAt, payload };
}

export function transactionObservationMetrics(
  payload: TransactionEffectPayloadDto,
  observedAt: Date | string,
) {
  const verified = payload.dataStatus === "VERIFIED";
  return {
    netReceivedMinor:
      verified && payload.receivedMinor !== null && payload.refundMinor !== null
        ? payload.receivedMinor - payload.refundMinor
        : null,
    transactionRate:
      verified &&
      payload.leadCount !== null &&
      payload.leadCount > 0 &&
      payload.transactionPeople !== null
        ? payload.transactionPeople / payload.leadCount
        : null,
    costPerTransactionMinor:
      verified &&
      payload.transactionPeople !== null &&
      payload.transactionPeople > 0 &&
      payload.costMinor !== null
        ? payload.costMinor / payload.transactionPeople
        : null,
    windowComplete: new Date(observedAt).getTime() >= Date.parse(payload.conversionWindowEnd),
  };
}

@Injectable()
export class CampaignEffectService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
  ) {}
  private principal(scope: Scope, permission: "campaign.read" | "campaign.manage") {
    const principal = this.access.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== scope.tenantId ||
      principal.scope.enterpriseId !== scope.enterpriseId ||
      !principal.permissions.includes(permission)
    )
      throw new ForbiddenException("当前企业不允许访问该活动观测数据");
    return principal;
  }
  async list(scope: Scope, campaignId: string) {
    this.principal(scope, "campaign.read");
    const campaign = await this.prisma.campaign.findFirst({
      where: { ...scope, id: campaignId },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException("当前企业未找到该活动");
    const rows = await this.prisma.campaignEffectObservation.findMany({
      where: { ...scope, campaignId },
      orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        observedAt: row.observedAt.toISOString(),
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
        metrics:
          row.kind === "TRANSACTION"
            ? transactionObservationMetrics(
                row.payload as unknown as TransactionEffectPayloadDto,
                row.observedAt,
              )
            : null,
      })),
    };
  }
  async create(scope: Scope, campaignId: string, input: CreateCampaignEffectDto) {
    const principal = this.principal(scope, "campaign.manage");
    const observation = normalizeEffectObservation(input);
    return this.prisma.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.findFirst({
        where: { ...scope, id: campaignId },
        select: { id: true },
      });
      if (!campaign) throw new NotFoundException("当前企业未找到该活动");
      const row = await transaction.campaignEffectObservation.create({
        data: {
          ...scope,
          campaignId,
          kind: observation.kind,
          observedAt: new Date(observation.observedAt),
          payload: observation.payload as unknown as Prisma.InputJsonValue,
          createdBy: principal.userId,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.effect-observation.record",
          actorType: "USER",
          actorUserId: principal.userId,
          ...scope,
          resourceType: "CampaignEffectObservation",
          resourceId: row.id,
          stateAfter: {
            campaignId,
            kind: observation.kind,
            observedAt: observation.observedAt,
            source: observation.payload.source,
          },
        },
      });
      return {
        id: row.id,
        kind: row.kind,
        observedAt: row.observedAt.toISOString(),
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
        metrics:
          observation.kind === "TRANSACTION"
            ? transactionObservationMetrics(observation.payload, row.observedAt)
            : null,
      };
    });
  }
}
