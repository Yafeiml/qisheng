import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { MaterialIngestionStatus, Tenant } from "@xhs-agentic/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestAccessContext, SaasAdminPrincipal } from "../access/request-access-context";
import { MaterialIngestionService } from "../content/material-ingestion.service";
import type { MaterialIngestionQueueService } from "../content/material-ingestion-queue.service";
import type { MaterialStorageService } from "../content/material-storage.service";
import { PrismaService } from "../database/prisma.service";
import type { StorageQuotaService } from "../resource-policy/storage-quota.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import { ProcessingIssuesQueryDto } from "./platform-processing-issues.dto";
import { PlatformProcessingIssuesService } from "./platform-processing-issues.service";

describe("platform processing issues from durable material jobs", { concurrent: false }, () => {
  const prisma = new PrismaService();
  const marker = `processing-${randomUUID()}`;
  const enqueue = vi.fn().mockResolvedValue(undefined);
  let tenant: Tenant;
  let enterpriseId: string;
  let creatorId: string;
  let retryActorId: string;
  let creatorPhone: string;
  let service: PlatformProcessingIssuesService;
  let principal: SaasAdminPrincipal;

  beforeAll(async () => {
    tenant = await prisma.tenant.create({
      data: { name: marker, customerType: "SINGLE_ENTERPRISE" },
    });
    enterpriseId = (
      await prisma.enterprise.create({
        data: { tenantId: tenant.id, code: `PI_${randomUUID()}`, name: "异常来源企业" },
      })
    ).id;
    creatorPhone = `1${Date.now().toString().slice(-10)}`;
    creatorId = (
      await prisma.adminUser.create({ data: { name: `提交者-${marker}`, phone: creatorPhone } })
    ).id;
    retryActorId = (
      await prisma.adminUser.create({
        data: {
          name: `重试者-${marker}`,
          phone: `1${(BigInt(creatorPhone.slice(1)) + 1n).toString().padStart(10, "0")}`,
        },
      })
    ).id;
    principal = {
      audience: "SAAS_ADMIN",
      userId: retryActorId,
      scope: { type: "PLATFORM" },
      permissions: ["platform.monitor.read", "platform.monitor.manage"],
    };
    const context = { requireSaasAdmin: () => principal } as RequestAccessContext;
    const ingestion = new MaterialIngestionService(
      prisma,
      context,
      new TenantCapabilityService(prisma),
      {} as StorageQuotaService,
      { enqueue } as unknown as MaterialIngestionQueueService,
      {} as MaterialStorageService,
    );
    service = new PlatformProcessingIssuesService(prisma, context, ingestion);
  });

  afterAll(async () => {
    if (tenant) {
      const where = { tenantId: tenant.id };
      await prisma.auditLog.deleteMany({ where });
      await prisma.materialIngestionJob.deleteMany({ where });
      await prisma.material.deleteMany({ where });
      await prisma.enterprise.deleteMany({ where });
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
    if (creatorId || retryActorId)
      await prisma.adminUser.deleteMany({
        where: { id: { in: [creatorId, retryActorId].filter(Boolean) } },
      });
    await prisma.$disconnect();
  });

  const query = (status: ProcessingIssuesQueryDto["status"] = "ALL", search = marker, limit = 50) =>
    Object.assign(new ProcessingIssuesQueryDto(), { status, search, limit });
  async function fixture(
    code: string | null,
    status: MaterialIngestionStatus = "FAILED",
    attemptCount = 5,
  ) {
    const material = await prisma.material.create({
      data: {
        tenantId: tenant.id,
        enterpriseId,
        scopeKey: enterpriseId,
        createdBy: creatorId,
        title: "待处理资料",
        type: "TEXT",
        content: "confidential source must never be returned",
        ingestionStatus: status,
        ingestionErrorCode: code,
        ingestionErrorMessage: "sk-secret upstream sensitive body",
        usabilityStatus: "PENDING",
      },
    });
    const job = await prisma.materialIngestionJob.create({
      data: {
        tenantId: tenant.id,
        enterpriseId,
        scopeKey: enterpriseId,
        materialId: material.id,
        parserVersion: "material-ai-v2",
        status,
        attemptCount,
        errorCode: code,
        errorMessage: "sk-secret upstream sensitive body",
        finishedAt: new Date(),
      },
    });
    return { material, job };
  }

  it("shows customer, enterprise and masked submitting user while rejecting raw failure content", async () => {
    const { material, job } = await fixture("MATERIAL_ANALYSIS_AUTH_FAILED", "QUARANTINED", 1);
    const page = await service.list(query("NEEDS_ADMIN"));
    const issue = page.items.find((item) => item.id === job.id);
    expect(issue).toMatchObject({
      source: "MATERIAL",
      resourceId: material.id,
      status: "NEEDS_ADMIN",
      stage: "ANALYSIS",
      canRetry: true,
      tenant: { id: tenant.id, name: marker },
      enterprise: { id: enterpriseId, name: "异常来源企业" },
      actor: {
        id: creatorId,
        phoneMasked: `${creatorPhone.slice(0, 3)}****${creatorPhone.slice(-4)}`,
      },
    });
    expect(issue?.reason).toContain("认证失败");
    expect(JSON.stringify(page)).not.toMatch(/sk-secret|confidential source|upstream sensitive/u);
    expect(JSON.stringify(page)).not.toContain(creatorPhone);
  });

  it("filters statuses in the database and cursor-pages equal timestamps without duplicates", async () => {
    const one = await fixture("IMAGE_PARSE_FAILED", "QUARANTINED", 1);
    const two = await fixture("TEXT_ENCODING_UNSUPPORTED", "QUARANTINED", 1);
    const three = await fixture("DOCUMENT_PARSE_FAILED", "QUARANTINED", 1);
    await prisma.materialIngestionJob.updateMany({
      where: { id: { in: [one.job.id, two.job.id, three.job.id] } },
      data: { finishedAt: new Date() },
    });
    const first = await service.list(query("NEEDS_USER", marker, 1));
    expect(first.items).toHaveLength(1);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const nextQuery = query("NEEDS_USER", marker, 1);
    nextQuery.cursor = first.pageInfo.nextCursor ?? undefined;
    const second = await service.list(nextQuery);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const ids = new Set([one.job.id, two.job.id, three.job.id]);
    expect(ids.has(first.items[0]?.id ?? "")).toBe(true);
    expect(ids.has(second.items[0]?.id ?? "")).toBe(true);
    expect(first.items[0]?.canRetry).toBe(false);
  });

  it("includes null or unknown failure codes as UNCLASSIFIED without guessing their original cause", async () => {
    const missing = await fixture(null);
    const unknown = await fixture("SK_SECRET_CUSTOMER_CONTENT");
    const page = await service.list(query("NEEDS_ADMIN"));
    for (const id of [missing.job.id, unknown.job.id]) {
      expect(page.items.find((item) => item.id === id)).toMatchObject({
        errorCode: "UNCLASSIFIED",
        stage: "SYSTEM",
        status: "NEEDS_ADMIN",
      });
    }
    expect(JSON.stringify(page)).not.toContain("SK_SECRET_CUSTOMER_CONTENT");
  });

  it("shows transient failures as auto-retrying and refuses duplicate manual recovery", async () => {
    const { material, job } = await fixture("MATERIAL_ANALYSIS_RATE_LIMITED", "FAILED", 1);
    const page = await service.list(query("AUTO_RETRYING"));
    expect(page.items.find((item) => item.id === job.id)).toMatchObject({
      status: "AUTO_RETRYING",
      canRetry: false,
    });
    await expect(
      service.retry(material.id, { reason: "服务恢复", ingestionJobId: job.id }),
    ).rejects.toThrow("系统正在自动重试");
  });

  it("preserves a historical resolved issue through the existing failure audit after job errors are cleared", async () => {
    const { material, job } = await fixture("MATERIAL_ANALYSIS_TIMEOUT");
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        enterpriseId,
        actorType: "SYSTEM",
        action: "material.ingestion.failed",
        resourceType: "Material",
        resourceId: material.id,
        stateAfter: { code: "MATERIAL_ANALYSIS_TIMEOUT", ingestionJobId: job.id },
      },
    });
    await prisma.materialIngestionJob.update({
      where: { id: job.id },
      data: { status: "READY", errorCode: null, errorMessage: null },
    });
    await prisma.material.update({
      where: { id: material.id },
      data: { ingestionStatus: "READY", ingestionErrorCode: null, ingestionErrorMessage: null },
    });
    const issue = (await service.list(query("RESOLVED"))).items.find((item) => item.id === job.id);
    expect(issue).toMatchObject({
      errorCode: "MATERIAL_ANALYSIS_TIMEOUT",
      status: "RESOLVED",
      canRetry: false,
    });
    expect(issue?.resolutionNote).toContain("重试后已完成");
  });

  it("recovers the original material, attributes the retry actor and rejects stale notifications", async () => {
    const { material, job } = await fixture("EMBEDDING_MODEL_NOT_ALLOWED", "QUARANTINED", 1);
    const issue = (await service.list(query("NEEDS_ADMIN"))).items.find(
      (item) => item.id === job.id,
    );
    expect(issue).toMatchObject({
      canRetry: true,
      errorCode: "EMBEDDING_MODEL_NOT_ALLOWED",
      stage: "EMBEDDING",
    });
    expect(issue?.reason).toContain("未获得当前供应商密钥的调用权限");
    const restarted = await service.retry(material.id, {
      reason: "已修复模型授权",
      ingestionJobId: job.id,
    });
    expect(restarted).toMatchObject({ queueVersion: 2, status: "PENDING" });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ ingestionJobId: restarted.id, materialId: material.id }),
    );
    let history = (await service.list(query("AUTO_RETRYING"))).items.find(
      (item) => item.id === job.id,
    );
    expect(history?.resolutionNote).toContain("已重新提交");
    await prisma.materialIngestionJob.update({
      where: { id: restarted.id },
      data: {
        status: "FAILED",
        attemptCount: 5,
        errorCode: "EMBEDDING_NETWORK",
        finishedAt: new Date(),
      },
    });
    await prisma.material.update({
      where: { id: material.id },
      data: { ingestionStatus: "FAILED", ingestionErrorCode: "EMBEDDING_NETWORK" },
    });
    await expect(
      service.retry(material.id, { reason: "旧通知不应重试新任务", ingestionJobId: job.id }),
    ).rejects.toThrow("已有新的处理任务");
    const active = (await service.list(query("NEEDS_ADMIN"))).items.find(
      (item) => item.id === restarted.id,
    );
    expect(active?.actor).toMatchObject({ id: retryActorId, name: `重试者-${marker}` });
    await prisma.materialIngestionJob.update({
      where: { id: restarted.id },
      data: { status: "READY", errorCode: null },
    });
    await prisma.material.update({
      where: { id: material.id },
      data: { ingestionStatus: "READY", ingestionErrorCode: null },
    });
    history = (await service.list(query("RESOLVED"))).items.find((item) => item.id === job.id);
    expect(history?.resolutionNote).toContain("后续处理任务已完成");
  });

  it("keeps disabled material history without presenting disablement as successful processing", async () => {
    const { material, job } = await fixture("MATERIAL_INGESTION_UNEXPECTED");
    await prisma.material.update({ where: { id: material.id }, data: { status: "DISABLED" } });
    const issue = (await service.list(query("RESOLVED"))).items.find((item) => item.id === job.id);
    expect(issue).toMatchObject({ status: "RESOLVED", canRetry: false });
    expect(issue?.resolutionNote).toContain("不表示处理已成功");
  });

  it("keeps a failed original pending while the user is preparing a replacement version", async () => {
    const { material, job } = await fixture("IMAGE_PARSE_FAILED", "QUARANTINED", 1);
    const replacement = await prisma.material.create({
      data: {
        tenantId: tenant.id,
        enterpriseId,
        scopeKey: enterpriseId,
        createdBy: creatorId,
        seriesId: material.seriesId,
        supersedesId: material.id,
        version: 2,
        title: "用户更新后的资料",
        type: "TEXT",
        content: "新版本正文",
        ingestionStatus: "PENDING",
      },
    });
    const item = (await service.list(query("AUTO_RETRYING"))).items.find(
      (issue) => issue.id === job.id,
    );
    expect(item).toMatchObject({ status: "AUTO_RETRYING", canRetry: false });
    expect(item?.resolutionNote).toContain("新的资料正在排队或处理");
    expect((await service.list(query("RESOLVED"))).items.some((issue) => issue.id === job.id)).toBe(
      false,
    );
    await prisma.material.update({
      where: { id: replacement.id },
      data: { ingestionStatus: "FAILED" },
    });
    await prisma.materialIngestionJob.create({
      data: {
        tenantId: tenant.id,
        enterpriseId,
        scopeKey: enterpriseId,
        materialId: replacement.id,
        parserVersion: "material-ai-v2",
        status: "FAILED",
        errorCode: "MATERIAL_ANALYSIS_RATE_LIMITED",
        attemptCount: 1,
        maxAttempts: 5,
      },
    });
    expect(
      (await service.list(query("AUTO_RETRYING"))).items.find((issue) => issue.id === job.id),
    ).toMatchObject({ status: "AUTO_RETRYING", canRetry: false });
  });

  it.each([
    "LINK_HTTP_503",
    "LINK_HTTP_429",
    "LINK_FETCH_NETWORK",
    "LINK_DNS_EMPTY",
    "LINK_FETCH_TIMEOUT",
  ])(
    "keeps %s owned by the platform and allows recovery after automatic retries finish",
    async (code) => {
      const { material, job } = await fixture(code);
      const issue = (await service.list(query("NEEDS_ADMIN"))).items.find(
        (item) => item.id === job.id,
      );
      expect(issue).toMatchObject({ stage: "SYSTEM", status: "NEEDS_ADMIN", canRetry: true });
      await expect(
        service.retry(material.id, { reason: "链接服务和出口网络已恢复", ingestionJobId: job.id }),
      ).resolves.toMatchObject({ status: "PENDING" });
    },
  );

  it.each([
    "ARTIFACT_NOT_LOADED",
    "EMPTY_EMBEDDING_INPUT",
    "BUNDLE_MATERIAL_TYPE_UNSUPPORTED",
    "BUNDLE_ARTIFACT_COUNT_INVALID",
    "LINK_HTTP_429",
  ])(
    "assigns the quarantined %s service invariant to the platform and permits explicit recovery",
    async (code) => {
      const { material, job } = await fixture(code, "QUARANTINED", 1);
      const issue = (await service.list(query("NEEDS_ADMIN"))).items.find(
        (item) => item.id === job.id,
      );
      expect(issue).toMatchObject({ status: "NEEDS_ADMIN", stage: "SYSTEM", canRetry: true });
      await expect(
        service.retry(material.id, { reason: "平台已经修复任务处理问题", ingestionJobId: job.id }),
      ).resolves.toMatchObject({ status: "PENDING" });
    },
  );

  it("searches submitting user, business context and task identifiers across pages", async () => {
    const { material, job } = await fixture("MATERIAL_ANALYSIS_MODEL_NOT_CONFIGURED");
    expect(
      (await service.list(query("ALL", `提交者-${marker}`))).items.some(
        (item) => item.id === job.id,
      ),
    ).toBe(true);
    expect((await service.list(query("ALL", job.id))).items).toHaveLength(1);
    expect(
      (await service.list(query("ALL", material.id))).items.some((item) => item.id === job.id),
    ).toBe(true);
    expect((await service.list(query("ALL", "absent-search-marker"))).items).toEqual([]);
  });

  it("refuses file retries and enforces PLATFORM scope and independent read/manage permissions", async () => {
    const { material, job } = await fixture("FILE_MAGIC_MISMATCH", "QUARANTINED", 1);
    await expect(
      service.retry(material.id, { reason: "不能盲目重试文件", ingestionJobId: job.id }),
    ).rejects.toThrow("联系用户更新内容");
    const original = principal;
    try {
      principal = { ...original, scope: { type: "TENANT", tenantId: tenant.id } };
      await expect(service.list(query())).rejects.toThrow("需要平台管理员");
      principal = { ...original, permissions: ["platform.monitor.read"] };
      expect((await service.list(query("NEEDS_ADMIN"))).items.every((item) => !item.canRetry)).toBe(
        true,
      );
      await expect(service.retry(material.id, { reason: "只读不能操作" })).rejects.toThrow(
        "需要平台管理员",
      );
      principal = { ...original, permissions: ["platform.monitor.manage"] };
      await expect(service.list(query())).rejects.toThrow("需要平台管理员");
    } finally {
      principal = original;
    }
  });
});
