import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@xhs-agentic/database";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const prisma = new PrismaClient();
const tenantId = "sprint8_scale_reference";
const enterpriseCount = 50;
const membershipCount = 10_000;
const campaignCount = 10_000;
const workItemCount = 100_000;
const samples = 30;

async function run(): Promise<void> {
  assertDevelopmentDatabase();
  const startedAt = performance.now();
  await cleanup();
  const fixtureStartedAt = performance.now();
  try {
    await prisma.tenant.create({
      data: {
        customerType: "GROUP",
        id: tenantId,
        name: "Sprint 8 规模参考租户",
      },
    });
    await prisma.tenantCapabilityPolicy.create({ data: { tenantId } });
    await seedReferenceRows();
    await prisma.$executeRawUnsafe(
      "ANALYZE enterprises, enterprise_memberships, materials, campaigns, generation_runs, generation_work_items, campaign_audience_snapshots, audit_logs",
    );
    const fixtureMs = performance.now() - fixtureStartedAt;
    const counts = await fixtureCounts();
    assertReferenceCounts(counts);

    const firstEnterpriseId = enterpriseId(1);
    const firstCampaignId = campaignId(1);
    const metrics = {
      auditTimeline: await measure(() =>
        prisma.auditLog.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
          where: { tenantId },
        }),
      ),
      campaignFirstPage: await measure(() =>
        prisma.campaign.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 51,
          where: { archivedAt: null, enterpriseId: firstEnterpriseId, tenantId },
        }),
      ),
      customerSearchFirstPage: await measure(() =>
        prisma.tenant.findMany({
          include: {
            enterprises: {
              orderBy: { createdAt: "asc" },
              select: { code: true, id: true, name: true, status: true },
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 51,
          where: {
            enterprises: { some: { code: { contains: "S8B", mode: "insensitive" } } },
            name: { contains: "Sprint 8", mode: "insensitive" },
          },
        }),
      ),
      groupOverviewAggregate: await measure(async () => {
        await Promise.all([
          prisma.enterpriseMembership.groupBy({
            _count: { _all: true },
            by: ["enterpriseId", "seatStatus", "status"],
            where: { tenantId },
          }),
          prisma.campaign.groupBy({
            _count: { _all: true },
            by: ["enterpriseId", "status"],
            where: { archivedAt: null, tenantId },
          }),
          prisma.generationWorkItem.groupBy({
            _count: { _all: true },
            by: ["enterpriseId", "status"],
            where: { tenantId },
          }),
          prisma.material.groupBy({
            _count: { _all: true },
            by: ["enterpriseId"],
            where: {
              authorizationStatus: "AUTHORIZED",
              ingestionStatus: "READY",
              status: "ACTIVE",
              tenantId,
            },
          }),
        ]);
      }),
      workItemCsvBatch: await measure(() =>
        prisma.generationWorkItem.findMany({
          include: {
            audienceSnapshot: {
              select: { departmentName: true, employeeName: true, employeePhone: true },
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 500,
          where: { campaignId: firstCampaignId, enterpriseId: firstEnterpriseId, tenantId },
        }),
      ),
      workItemFirstPage: await measure(() =>
        prisma.generationWorkItem.findMany({
          include: {
            audienceSnapshot: {
              select: { departmentName: true, employeeName: true, employeePhone: true },
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 101,
          where: {
            campaignId: firstCampaignId,
            enterpriseId: firstEnterpriseId,
            status: "QUEUED",
            tenantId,
          },
        }),
      ),
    };
    const queuedCampaignPersistence = await measureQueuedCampaignPersistence();
    const plans = await explainPlans(firstEnterpriseId, firstCampaignId);
    const slowQueries = Object.entries(metrics)
      .filter(([, metric]) => metric.p95Ms >= 800)
      .map(([name]) => name);
    const report = {
      benchmark: "sprint8-saas-core-reference-scale",
      completedAt: new Date().toISOString(),
      counts,
      fixtureMs,
      metrics,
      plans,
      queuedCampaignPersistence,
      referenceLoad: {
        campaigns: campaignCount,
        enterprises: enterpriseCount,
        memberships: membershipCount,
        workItems: workItemCount,
      },
      target: { commonFirstPageP95Ms: 800, passed: slowQueries.length === 0, slowQueries },
      totalMs: performance.now() - startedAt,
    };
    if (!report.target.passed) {
      throw new Error(`Sprint 8 performance target failed: ${slowQueries.join(", ")}`);
    }
    if (queuedCampaignPersistence.elapsedMs >= 800 || queuedCampaignPersistence.workItems !== 100) {
      throw new Error(
        `100-person queued persistence target failed: ${JSON.stringify(queuedCampaignPersistence)}`,
      );
    }
    await mkdir(".artifacts", { recursive: true });
    await writeFile(
      ".artifacts/sprint8-scale-report.json",
      `${JSON.stringify(jsonSafe(report), null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(jsonSafe(report), null, 2)}\n`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function seedReferenceRows(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    INSERT INTO "enterprises" ("id", "tenant_id", "name", "code", "brand_name", "industry", "city", "status", "created_at", "updated_at")
    SELECT
      's8b_e_' || lpad(n::text, 2, '0'),
      '${tenantId}',
      '规模企业 ' || lpad(n::text, 2, '0'),
      'S8B_' || lpad(n::text, 2, '0'),
      '参考品牌',
      '医疗健康',
      '杭州',
      'ACTIVE'::"enterprise_status",
      now() - (n || ' seconds')::interval,
      now()
    FROM generate_series(1, ${enterpriseCount}) AS n
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "enterprise_memberships" (
      "id", "tenant_id", "enterprise_id", "name", "phone", "employee_no", "status", "seat_status", "seat_enabled_at", "created_at", "updated_at"
    )
    SELECT
      's8b_m_' || lpad(n::text, 5, '0'),
      '${tenantId}',
      's8b_e_' || lpad((((n - 1) / 200) + 1)::text, 2, '0'),
      '参考员工 ' || lpad(n::text, 5, '0'),
      '188' || lpad(n::text, 8, '0'),
      'S8-' || lpad(n::text, 5, '0'),
      'ACTIVE'::"membership_status",
      'ENABLED'::"seat_status",
      now(),
      now() - (n || ' milliseconds')::interval,
      now()
    FROM generate_series(1, ${membershipCount}) AS n
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "materials" (
      "id", "series_id", "version", "tenant_id", "enterprise_id", "scope_key", "type", "title", "content", "tags",
      "authorization_status", "status", "ingestion_status", "ready_at", "created_by", "created_at", "updated_at"
    )
    SELECT
      's8b_mat_' || lpad(n::text, 2, '0'),
      's8b_series_' || lpad(n::text, 2, '0'),
      1,
      '${tenantId}',
      's8b_e_' || lpad(n::text, 2, '0'),
      's8b_e_' || lpad(n::text, 2, '0'),
      'TEXT'::"material_type",
      '参考授权素材 ' || n,
      '用于 Sprint 8 规模基线的授权素材。',
      ARRAY['SPRINT8'],
      'AUTHORIZED'::"material_authorization_status",
      'ACTIVE'::"material_status",
      'READY'::"material_ingestion_status",
      now(),
      'sprint8-benchmark',
      now(),
      now()
    FROM generate_series(1, ${enterpriseCount}) AS n
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "campaigns" (
      "id", "tenant_id", "enterprise_id", "title", "prompt", "status", "visible_at", "expires_at",
      "image_count", "audience_mode", "audience_count", "generated_count", "created_by", "created_at", "updated_at"
    )
    SELECT
      's8b_c_' || lpad(n::text, 5, '0'),
      '${tenantId}',
      's8b_e_' || lpad((((n - 1) / 200) + 1)::text, 2, '0'),
      'Sprint 8 参考活动 ' || lpad(n::text, 5, '0'),
      '生成小红书风格活动内容，验证活动搜索、筛选和稳定游标。',
      'DRAFT'::"campaign_status",
      now() + interval '1 day',
      now() + interval '2 days',
      1,
      'SELECTED'::"campaign_audience_mode",
      10,
      0,
      'sprint8-benchmark',
      now() - (n || ' milliseconds')::interval,
      now()
    FROM generate_series(1, ${campaignCount}) AS n
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "campaign_audience_snapshots" (
      "id", "tenant_id", "enterprise_id", "campaign_id", "membership_id", "employee_name", "employee_phone", "created_at"
    )
    SELECT
      's8b_a_' || lpad(n::text, 6, '0'),
      '${tenantId}',
      c.enterprise_id,
      c.id,
      m.id,
      m.name,
      m.phone,
      now() - (n || ' microseconds')::interval
    FROM generate_series(1, ${workItemCount}) AS n
    JOIN "campaigns" c ON c.id = 's8b_c_' || lpad((((n - 1) / 10) + 1)::text, 5, '0')
    JOIN "enterprise_memberships" m ON m.id = 's8b_m_' || lpad(((((n - 1) / 2000) * 200) + ((n - 1) % 10) + 1)::text, 5, '0')
    WHERE c.tenant_id = '${tenantId}' AND m.tenant_id = '${tenantId}'
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "generation_runs" (
      "id", "tenant_id", "campaign_id", "status", "provider", "text_provider", "image_provider", "text_model", "image_model",
      "synthetic", "requested_count", "created_at", "updated_at"
    )
    SELECT
      's8b_r_' || lpad(n::text, 5, '0'),
      '${tenantId}',
      's8b_c_' || lpad(n::text, 5, '0'),
      'QUEUED'::"generation_run_status",
      'sprint8-synthetic',
      'sprint8-synthetic',
      'sprint8-synthetic',
      'sprint8-text',
      'sprint8-image',
      true,
      10,
      now() - (n || ' milliseconds')::interval,
      now()
    FROM generate_series(1, ${campaignCount}) AS n
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "generation_work_items" (
      "id", "tenant_id", "enterprise_id", "campaign_id", "generation_run_id", "audience_snapshot_id", "membership_id", "status", "created_at", "updated_at"
    )
    SELECT
      's8b_w_' || lpad(n::text, 6, '0'),
      '${tenantId}',
      a.enterprise_id,
      a.campaign_id,
      's8b_r_' || lpad((((n - 1) / 10) + 1)::text, 5, '0'),
      a.id,
      a.membership_id,
      CASE WHEN n % 20 = 0 THEN 'FAILED'::"generation_work_item_status" ELSE 'QUEUED'::"generation_work_item_status" END,
      now() - (n || ' microseconds')::interval,
      now()
    FROM generate_series(1, ${workItemCount}) AS n
    JOIN "campaign_audience_snapshots" a ON a.id = 's8b_a_' || lpad(n::text, 6, '0')
    WHERE a.tenant_id = '${tenantId}'
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "audit_logs" (
      "id", "tenant_id", "actor_type", "action", "resource_type", "resource_id", "created_at"
    )
    SELECT
      's8b_log_' || lpad(n::text, 4, '0'),
      '${tenantId}',
      'SYSTEM'::"audit_actor_type",
      'sprint8.reference-event',
      'Campaign',
      's8b_c_' || lpad((((n - 1) % ${campaignCount}) + 1)::text, 5, '0'),
      now() - (n || ' milliseconds')::interval
    FROM generate_series(1, 1000) AS n
  `);
}

async function measure(operation: () => Promise<unknown>) {
  for (let index = 0; index < 5; index += 1) await operation();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return {
    maxMs: round(durations.at(-1) ?? 0),
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    samples,
  };
}

async function measureQueuedCampaignPersistence() {
  const id = "s8b_queue_100";
  const startedAt = performance.now();
  await prisma.$transaction(async (transaction) => {
    const visibleAt = new Date(Date.now() + 86_400_000);
    await transaction.campaign.create({
      data: {
        audienceCount: 100,
        audienceMode: "SELECTED",
        createdBy: "sprint8-benchmark",
        enterpriseId: enterpriseId(1),
        expiresAt: new Date(visibleAt.getTime() + 86_400_000),
        id,
        prompt: "验证 100 人活动请求只持久化快照与队列工作项。",
        status: "DRAFT",
        tenantId,
        title: "Sprint 8 100 人快速入队基线",
        visibleAt,
      },
    });
    await transaction.campaignAudienceSnapshot.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        campaignId: id,
        employeeName: `参考员工 ${index + 1}`,
        employeePhone: `188${String(index + 1).padStart(8, "0")}`,
        enterpriseId: enterpriseId(1),
        id: `${id}_a_${String(index + 1).padStart(3, "0")}`,
        membershipId: membershipId(index + 1),
        tenantId,
      })),
    });
    await transaction.generationRun.create({
      data: {
        campaignId: id,
        id: `${id}_run`,
        imageModel: "sprint8-image",
        provider: "sprint8-synthetic",
        requestedCount: 100,
        status: "QUEUED",
        synthetic: true,
        tenantId,
        textModel: "sprint8-text",
      },
    });
    await transaction.generationWorkItem.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        audienceSnapshotId: `${id}_a_${String(index + 1).padStart(3, "0")}`,
        campaignId: id,
        enterpriseId: enterpriseId(1),
        generationRunId: `${id}_run`,
        id: `${id}_w_${String(index + 1).padStart(3, "0")}`,
        membershipId: membershipId(index + 1),
        tenantId,
      })),
    });
  });
  const elapsedMs = performance.now() - startedAt;
  const persisted = await prisma.generationWorkItem.count({ where: { campaignId: id, tenantId } });
  await prisma.generationWorkItem.deleteMany({ where: { campaignId: id, tenantId } });
  await prisma.generationRun.deleteMany({ where: { campaignId: id, tenantId } });
  await prisma.campaignAudienceSnapshot.deleteMany({ where: { campaignId: id, tenantId } });
  await prisma.campaign.delete({ where: { id } });
  return { elapsedMs: round(elapsedMs), generationExecutedInRequest: false, workItems: persisted };
}

async function explainPlans(firstEnterpriseId: string, firstCampaignId: string) {
  const statements = {
    auditTimeline: `SELECT "id", "action", "created_at" FROM "audit_logs" WHERE "tenant_id" = '${tenantId}' ORDER BY "created_at" DESC, "id" DESC LIMIT 50`,
    campaignFirstPage: `SELECT "id", "title", "status", "created_at" FROM "campaigns" WHERE "tenant_id" = '${tenantId}' AND "enterprise_id" = '${firstEnterpriseId}' AND "archived_at" IS NULL ORDER BY "created_at" DESC, "id" DESC LIMIT 51`,
    customerSearch: `SELECT DISTINCT t."id", t."name", t."created_at" FROM "tenants" t JOIN "enterprises" e ON e."tenant_id" = t."id" WHERE t."name" ILIKE '%Sprint 8%' AND e."code" ILIKE '%S8B%' ORDER BY t."created_at" DESC, t."id" DESC LIMIT 51`,
    groupWorkItems: `SELECT "enterprise_id", "status", count(*) FROM "generation_work_items" WHERE "tenant_id" = '${tenantId}' GROUP BY "enterprise_id", "status"`,
    retrievalEvidence: `SELECT "enterprise_id", "material_id", count(*), max("created_at") FROM "campaign_retrieval_evidence" WHERE "tenant_id" = '${tenantId}' AND "material_scope_key" = '__tenant__' GROUP BY "enterprise_id", "material_id"`,
    workItemFirstPage: `SELECT "id", "status", "created_at" FROM "generation_work_items" WHERE "tenant_id" = '${tenantId}' AND "enterprise_id" = '${firstEnterpriseId}' AND "campaign_id" = '${firstCampaignId}' AND "status" = 'QUEUED' ORDER BY "created_at" DESC, "id" DESC LIMIT 101`,
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(statements).map(async ([name, sql]) => {
        const plan = await prisma.$queryRawUnsafe<unknown[]>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        );
        return [name, plan] as const;
      }),
    ),
  );
}

async function fixtureCounts() {
  const [enterprises, memberships, campaigns, workItems] = await Promise.all([
    prisma.enterprise.count({ where: { tenantId } }),
    prisma.enterpriseMembership.count({ where: { tenantId } }),
    prisma.campaign.count({ where: { tenantId } }),
    prisma.generationWorkItem.count({ where: { tenantId } }),
  ]);
  return { campaigns, enterprises, memberships, workItems };
}

function assertReferenceCounts(counts: Awaited<ReturnType<typeof fixtureCounts>>): void {
  const expected = {
    campaigns: campaignCount,
    enterprises: enterpriseCount,
    memberships: membershipCount,
    workItems: workItemCount,
  };
  if (JSON.stringify(counts) !== JSON.stringify(expected)) {
    throw new Error(`Reference fixture count mismatch: ${JSON.stringify({ counts, expected })}`);
  }
}

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.generationWorkItem.deleteMany({ where: { tenantId } });
  await prisma.generationRun.deleteMany({ where: { tenantId } });
  await prisma.campaignAudienceSnapshot.deleteMany({ where: { tenantId } });
  await prisma.campaign.deleteMany({ where: { tenantId } });
  await prisma.material.deleteMany({ where: { tenantId } });
  await prisma.enterpriseMembership.deleteMany({ where: { tenantId } });
  await prisma.enterprise.deleteMany({ where: { tenantId } });
  await prisma.tenantCapabilityPolicy.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}

function enterpriseId(index: number): string {
  return `s8b_e_${String(index).padStart(2, "0")}`;
}

function membershipId(index: number): string {
  return `s8b_m_${String(index).padStart(5, "0")}`;
}

function campaignId(index: number): string {
  return `s8b_c_${String(index).padStart(5, "0")}`;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function assertDevelopmentDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for Sprint 8 scale benchmark");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//u, "");
  if (databaseName !== "dev_xhs_agentic") {
    throw new Error(`Refusing to run Sprint 8 benchmark against database: ${databaseName}`);
  }
}

void run();
