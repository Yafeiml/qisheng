import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import { CreateCampaignEffectDto, type TransactionEffectPayloadDto } from "./campaign-effect.dto";
import {
  CampaignEffectService,
  normalizeEffectObservation,
  sanitizeObservationUrl,
  transactionObservationMetrics,
} from "./campaign-effect.service";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
const payload: TransactionEffectPayloadDto = {
  channel: "获准站内咨询",
  cohortStart: "2026-10-01T00:00:00Z",
  cohortEnd: "2026-10-03T00:00:00Z",
  conversionWindowEnd: "2026-10-13T00:00:00Z",
  definition: "PAID_ORDER",
  dataStatus: "VERIFIED",
  leadCount: 10,
  consultationCount: 12,
  appointmentCount: 4,
  visitCount: 3,
  transactionPeople: 2,
  orderCount: 3,
  receivedMinor: 120000,
  refundMinor: 20000,
  costMinor: 5000,
  currency: "CNY",
  source: "企业业务汇总与财务核对表2026-10版",
};
const input = { kind: "TRANSACTION" as const, observedAt: "2026-10-13T01:00:00Z", payload };
function fixture(found = true, permissions = ["campaign.read", "campaign.manage"]) {
  const row = {
    id: "observation",
    ...scope,
    campaignId: "campaign",
    kind: "TRANSACTION",
    observedAt: new Date(input.observedAt),
    payload,
    createdAt: new Date(input.observedAt),
  };
  const prisma = {
    campaign: { findFirst: vi.fn().mockResolvedValue(found ? { id: "campaign" } : null) },
    campaignEffectObservation: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          row,
          { ...row, id: "older", observedAt: new Date("2026-10-10T00:00:00Z") },
        ]),
      create: vi.fn().mockResolvedValue(row),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (run) => run(prisma));
  const access = {
    requireSaasAdmin: vi.fn().mockReturnValue({
      userId: "operator",
      scope: { type: "ENTERPRISE", ...scope },
      permissions,
    }),
  };
  return {
    service: new CampaignEffectService(
      prisma as unknown as PrismaService,
      access as unknown as RequestAccessContext,
    ),
    prisma,
    access,
  };
}
describe("medical GEO and transaction observations", () => {
  it("computes net receipts and cohort rates from one verified snapshot", () => {
    expect(transactionObservationMetrics(payload, input.observedAt)).toEqual({
      netReceivedMinor: 100000,
      transactionRate: 0.2,
      costPerTransactionMinor: 2500,
      windowComplete: true,
    });
    expect(transactionObservationMetrics(payload, "2026-10-12T23:59:59Z").windowComplete).toBe(
      false,
    );
  });
  it("keeps unknown values unknown and never manufactures zero denominators", () => {
    const unknown = {
      ...payload,
      dataStatus: "UNKNOWN" as const,
      leadCount: null,
      transactionPeople: null,
      orderCount: null,
      receivedMinor: null,
      refundMinor: null,
      costMinor: null,
    };
    const result = normalizeEffectObservation({ ...input, payload: unknown });
    expect(result.payload).toMatchObject({ receivedMinor: null, transactionPeople: null });
    expect(transactionObservationMetrics(unknown, input.observedAt)).toMatchObject({
      netReceivedMinor: null,
      transactionRate: null,
      costPerTransactionMinor: null,
    });
    expect(
      transactionObservationMetrics(
        { ...payload, leadCount: 0, transactionPeople: 0, orderCount: 0 },
        input.observedAt,
      ),
    ).toMatchObject({ transactionRate: null, costPerTransactionMinor: null });
  });
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, Number.NaN])(
    "rejects invalid counts and money %s",
    (value) => {
      expect(() =>
        normalizeEffectObservation({ ...input, payload: { ...payload, costMinor: value } }),
      ).toThrow("安全整数");
    },
  );
  it("enforces verified facts, consistent cohort dates, counts and refunds", () => {
    for (const invalid of [
      { receivedMinor: null },
      { transactionPeople: 11 },
      { orderCount: 1 },
      { refundMinor: 120001 },
      { cohortEnd: "2026-09-01T00:00:00Z" },
      { cohortStart: "2026-02-31T00:00:00Z" },
      { conversionWindowEnd: "2026-10-02T00:00:00Z" },
    ])
      expect(() =>
        normalizeEffectObservation({ ...input, payload: { ...payload, ...invalid } }),
      ).toThrow();
  });
  it("strips session and tracking tokens while retaining the exact cited note identity", () => {
    expect(
      sanitizeObservationUrl(
        "https://www.xiaohongshu.com/explore/note123?xsec_token=private&xsec_source=search&utm_source=app&noteId=note123#token",
      ),
    ).toBe("https://www.xiaohongshu.com/explore/note123?noteId=note123");
    expect(() => sanitizeObservationUrl("javascript:alert(1)")).toThrow();
    expect(() => sanitizeObservationUrl("https://user:password@example.com/proof")).toThrow();
  });
  it("rejects observations in the future or before the cohort starts", () => {
    const now = new Date("2026-10-13T01:00:00Z");
    expect(() =>
      normalizeEffectObservation(
        {
          ...input,
          observedAt: new Date(now.getTime() + 60_001).toISOString(),
        },
        now,
      ),
    ).toThrow("当前时间");
    expect(() =>
      normalizeEffectObservation({ ...input, observedAt: "2026-09-30T00:00:00Z" }, now),
    ).toThrow("尚未开始");
    expect(() =>
      normalizeEffectObservation(
        { ...input, observedAt: new Date(now.getTime() + 60_000).toISOString() },
        now,
      ),
    ).not.toThrow();
  });
  it("records independent GEO mention and actual citation without inferring a transaction", () => {
    const result = normalizeEffectObservation({
      kind: "GEO",
      observedAt: input.observedAt,
      payload: {
        product: "点点",
        surface: "AI",
        query: "首次到院要确认什么",
        brandSeen: null,
        citationUrl: "https://www.xiaohongshu.com/explore/note?xsec_token=private",
        source: "同条件观察答案与实际来源链接",
      },
    });
    expect(result).toMatchObject({
      kind: "GEO",
      payload: { brandSeen: null, citationUrl: "https://www.xiaohongshu.com/explore/note" },
    });
  });
  it("excludes patient identifiers from the business-source note", () => {
    expect(() =>
      normalizeEffectObservation({
        ...input,
        payload: { ...payload, source: "患者手机13812345678的成交" },
      }),
    ).toThrow("个人信息");
  });
  it("validates the discriminated HTTP payload rather than accepting other-kind fields", async () => {
    expect(
      await validate(plainToInstance(CreateCampaignEffectDto, input), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toEqual([]);
    expect(
      (
        await validate(plainToInstance(CreateCampaignEffectDto, { ...input, kind: "GEO" }), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(CreateCampaignEffectDto, { kind: "GEO", observedAt: input.observedAt }),
          { whitelist: true, forbidNonWhitelisted: true },
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it("appends with strong campaign scope and audit evidence", async () => {
    const { service, prisma } = fixture();
    const result = await service.create(scope, "campaign", input);
    expect(prisma.campaign.findFirst).toHaveBeenCalledWith({
      where: { ...scope, id: "campaign" },
      select: { id: true },
    });
    expect(prisma.campaignEffectObservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ...scope, campaignId: "campaign", createdBy: "operator" }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    expect(result.metrics?.netReceivedMinor).toBe(100000);
  });
  it("returns each snapshot separately instead of summing historical observations", async () => {
    const { service } = fixture();
    const result = await service.list(scope, "campaign");
    expect(result.items).toHaveLength(2);
    expect(result.items.map(({ metrics }) => metrics?.netReceivedMinor)).toEqual([100000, 100000]);
    expect(result.items.map(({ metrics }) => metrics?.windowComplete)).toEqual([true, false]);
  });
  it("rejects foreign enterprise/tenant access and missing campaigns before writing", async () => {
    const { service, prisma } = fixture();
    await expect(service.list({ ...scope, enterpriseId: "foreign" }, "campaign")).rejects.toThrow();
    await expect(
      service.create({ ...scope, tenantId: "foreign" }, "campaign", input),
    ).rejects.toThrow();
    expect(prisma.campaignEffectObservation.create).not.toHaveBeenCalled();
    const missing = fixture(false);
    await expect(missing.service.create(scope, "campaign", input)).rejects.toThrow("未找到");
    expect(missing.prisma.campaignEffectObservation.create).not.toHaveBeenCalled();
  });
  it("requires management authority to append an observation", async () => {
    const { service, prisma } = fixture(true, ["campaign.read"]);
    await expect(service.create(scope, "campaign", input)).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
