import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { MaterialIngestionService } from "../content/material-ingestion.service";
import { ADMIN_RECOVERABLE_QUARANTINED_CODES } from "../content/material-ingestion-retry-policy";
import { PrismaService } from "../database/prisma.service";
import { decodeCursor, pageTake, toCursorPageBy } from "../http/cursor-pagination";
import type {
  ProcessingIssueDto,
  ProcessingIssueStatus,
  ProcessingIssuesQueryDto,
  RetryProcessingIssueDto,
} from "./platform-processing-issues.dto";
import {
  processingIssueGuidance,
  USER_FIXABLE_PROCESSING_CODES,
} from "./processing-issue-guidance";

type IssueRow = {
  id: string;
  materialId: string;
  title: string;
  occurredAt: Date;
  tenantId: string;
  tenantName: string;
  enterpriseId: string | null;
  enterpriseName: string | null;
  actorId: string | null;
  actorName: string | null;
  actorPhoneMasked: string | null;
  status: ProcessingIssueStatus;
  errorCode: string | null;
  attemptCount: number;
  maxAttempts: number;
  canRetry: boolean;
  resolutionNote: string | null;
};

@Injectable()
export class PlatformProcessingIssuesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly context: RequestAccessContext,
    @Inject(MaterialIngestionService) private readonly ingestion: MaterialIngestionService,
  ) {}

  async list(query: ProcessingIssuesQueryDto) {
    const principal = this.requirePlatform("platform.monitor.read");
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const search = query.search?.trim();
    const pattern = search ? `%${search.replace(/[\\%_]/gu, "\\$&")}%` : null;
    const codeList = Prisma.join(USER_FIXABLE_PROCESSING_CODES);
    const recoverableCodes = Prisma.join(ADMIN_RECOVERABLE_QUARANTINED_CODES);
    // Filtering and pagination happen in PostgreSQL. No material body, stored error message,
    // upstream response or unmasked phone is selected into the application process.
    const rows = await this.prisma.$queryRaw<IssueRow[]>(Prisma.sql`
      WITH issue_source AS (
        SELECT j.id, j.material_id, j.status AS job_status,
          j.attempt_count, j.max_attempts, j.created_at,
          COALESCE(j.error_code, failure.code) AS error_code,
          COALESCE(failure.occurred_at, j.finished_at, j.updated_at) AS occurred_at,
          m.title, m.status AS material_status,
          t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status,
          e.id AS enterprise_id, e.name AS enterprise_name, e.status AS enterprise_status,
          COALESCE(trigger_actor.actor_user_id, m.created_by) AS actor_id,
          actor.name AS actor_name,
          CASE WHEN actor.phone IS NULL THEN NULL
            WHEN length(actor.phone) >= 8 THEN left(actor.phone, 3) || '****' || right(actor.phone, 4)
            ELSE '****' END AS actor_phone_masked,
          latest.id AS latest_id, latest.status AS latest_status,
          latest.attempt_count AS latest_attempt_count, latest.max_attempts AS latest_max_attempts,
          EXISTS (SELECT 1 FROM materials newer WHERE newer.series_id = m.series_id
            AND newer.version > m.version AND newer.status = 'ACTIVE') AS newer_version_exists,
          EXISTS (SELECT 1 FROM materials newer WHERE newer.series_id = m.series_id
            AND newer.version > m.version AND newer.status = 'ACTIVE'
            AND (newer.ingestion_status IN ('PENDING', 'PROCESSING') OR
              (newer.ingestion_status = 'FAILED' AND EXISTS (
                SELECT 1 FROM material_ingestion_jobs replacement_job
                WHERE replacement_job.material_id = newer.id AND replacement_job.purpose = 'INGEST'
                  AND replacement_job.status = 'FAILED' AND replacement_job.attempt_count < replacement_job.max_attempts
                  AND NOT EXISTS (SELECT 1 FROM material_ingestion_jobs later_replacement_job
                    WHERE later_replacement_job.material_id = newer.id AND later_replacement_job.purpose = 'INGEST'
                      AND later_replacement_job.queue_version > replacement_job.queue_version)
              )))) AS newer_version_processing
        FROM material_ingestion_jobs j
        JOIN materials m ON m.id = j.material_id AND m.tenant_id = j.tenant_id
        JOIN tenants t ON t.id = j.tenant_id
        LEFT JOIN enterprises e ON e.id = j.enterprise_id AND e.tenant_id = j.tenant_id
        LEFT JOIN LATERAL (
          SELECT a.state_after->>'code' AS code, a.created_at AS occurred_at
          FROM audit_logs a WHERE a.tenant_id = j.tenant_id
            AND a.resource_type = 'Material' AND a.resource_id = j.material_id
            AND a.action IN ('material.ingestion.failed', 'material.ingestion.quarantined')
            AND a.state_after->>'ingestionJobId' = j.id
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1
        ) failure ON TRUE
        JOIN LATERAL (
          SELECT next_job.id, next_job.status, next_job.attempt_count, next_job.max_attempts
          FROM material_ingestion_jobs next_job WHERE next_job.material_id = j.material_id
            AND next_job.purpose = 'INGEST'
          ORDER BY next_job.queue_version DESC LIMIT 1
        ) latest ON TRUE
        LEFT JOIN LATERAL (
          SELECT a.actor_user_id FROM audit_logs a
          WHERE a.tenant_id = j.tenant_id AND a.resource_type = 'Material'
            AND a.resource_id = j.material_id AND a.actor_type = 'USER'
            AND a.actor_user_id IS NOT NULL
            AND a.action IN ('material.create', 'material.version.publish', 'material.upload.intent.create',
              'material.upload.complete', 'material.link.create', 'material.ingestion.retry',
              'material.revision.create', 'material.revision.finalize', 'material.supplement')
            AND (a.state_after->>'ingestionJobId' = j.id OR
              (a.action = 'material.ingestion.retry' AND
                a.state_after->>'queueVersion' = j.queue_version::text))
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1
        ) trigger_actor ON TRUE
        LEFT JOIN admin_users actor ON actor.id = COALESCE(trigger_actor.actor_user_id, m.created_by)
        WHERE j.purpose = 'INGEST'
          AND (j.status IN ('FAILED', 'QUARANTINED') OR j.error_code IS NOT NULL OR failure.occurred_at IS NOT NULL)
          AND ${
            pattern
              ? Prisma.sql`(actor.name ILIKE ${pattern} OR actor.phone ILIKE ${pattern}
            OR COALESCE(trigger_actor.actor_user_id, m.created_by) ILIKE ${pattern}
            OR t.name ILIKE ${pattern} OR e.name ILIKE ${pattern} OR m.title ILIKE ${pattern}
            OR m.id ILIKE ${pattern} OR j.id ILIKE ${pattern} OR COALESCE(j.error_code, failure.code, 'UNCLASSIFIED') ILIKE ${pattern})`
              : Prisma.sql`TRUE`
          }
      ), classified AS (
        SELECT *, CASE
          WHEN material_status = 'DISABLED' THEN 'RESOLVED'
          WHEN newer_version_processing THEN 'AUTO_RETRYING'
          WHEN newer_version_exists THEN 'RESOLVED'
          WHEN latest_id <> id AND (latest_status IN ('PENDING', 'PROCESSING') OR
            (latest_status = 'FAILED' AND latest_attempt_count < latest_max_attempts)) THEN 'AUTO_RETRYING'
          WHEN latest_id <> id OR job_status = 'READY' THEN 'RESOLVED'
          WHEN job_status IN ('PENDING', 'PROCESSING') OR
            (job_status = 'FAILED' AND attempt_count < max_attempts) THEN 'AUTO_RETRYING'
          WHEN error_code IN (${codeList}) OR (error_code ~ '^LINK_HTTP_4[0-9]{2}$' AND error_code <> 'LINK_HTTP_429') THEN 'NEEDS_USER'
          ELSE 'NEEDS_ADMIN' END AS issue_status,
          CASE WHEN material_status = 'DISABLED' THEN '原资料已停用；这不表示处理已成功。'
            WHEN newer_version_processing THEN '用户已提交更新版本，新的资料正在排队或处理。'
            WHEN newer_version_exists THEN '已有新的启用版本接续这份资料。'
            WHEN latest_id <> id AND latest_status = 'READY' THEN '后续处理任务已完成。'
            WHEN latest_id <> id AND latest_status IN ('PENDING', 'PROCESSING') THEN '已重新提交，新的任务正在排队或处理。'
            WHEN latest_id <> id AND latest_status = 'FAILED' AND latest_attempt_count < latest_max_attempts THEN '后续任务正在自动重试。'
            WHEN latest_id <> id THEN '这条历史异常已由后续处理任务接续，请查看最新任务。'
            WHEN job_status = 'READY' THEN '系统重试后已完成处理。'
            ELSE NULL END AS resolution_note
        FROM issue_source
      )
      SELECT id, material_id AS "materialId", title, occurred_at AS "occurredAt",
        tenant_id AS "tenantId", tenant_name AS "tenantName",
        enterprise_id AS "enterpriseId", enterprise_name AS "enterpriseName",
        actor_id AS "actorId", actor_name AS "actorName", actor_phone_masked AS "actorPhoneMasked",
        issue_status AS status, error_code AS "errorCode", attempt_count AS "attemptCount",
        max_attempts AS "maxAttempts", resolution_note AS "resolutionNote",
        (issue_status = 'NEEDS_ADMIN' AND tenant_status = 'ACTIVE'
          AND (enterprise_id IS NULL OR enterprise_status = 'ACTIVE')
          AND (job_status = 'FAILED' OR (job_status = 'QUARANTINED' AND
            (error_code ~ '^(MATERIAL_ANALYSIS|EMBEDDING)_' OR error_code ~ '^LINK_HTTP_5[0-9]{2}$' OR
             error_code IN (${recoverableCodes}))))) AS "canRetry"
      FROM classified WHERE ${query.status === "ALL" ? Prisma.sql`TRUE` : Prisma.sql`issue_status = ${query.status}`}
        AND ${cursor ? Prisma.sql`(occurred_at < ${cursor.timestamp} OR (occurred_at = ${cursor.timestamp} AND id < ${cursor.id}))` : Prisma.sql`TRUE`}
      ORDER BY occurred_at DESC, id DESC LIMIT ${pageTake(query)}
    `);
    const page = toCursorPageBy(rows, query, (row) => row.occurredAt);
    return {
      ...page,
      items: page.items.map(
        (row): ProcessingIssueDto => ({
          id: row.id,
          source: "MATERIAL",
          resourceId: row.materialId,
          resourceTitle: row.title,
          occurredAt: row.occurredAt.toISOString(),
          tenant: { id: row.tenantId, name: row.tenantName },
          enterprise: row.enterpriseId
            ? { id: row.enterpriseId, name: row.enterpriseName ?? "未知企业" }
            : null,
          actor:
            row.actorId && /^[A-Za-z0-9_-]{1,128}$/u.test(row.actorId)
              ? { id: row.actorId, name: row.actorName, phoneMasked: row.actorPhoneMasked }
              : null,
          status: row.status,
          ...processingIssueGuidance(row.errorCode),
          attemptCount: row.attemptCount,
          maxAttempts: row.maxAttempts,
          canRetry:
            row.canRetry === true && principal.permissions.includes("platform.monitor.manage"),
          resolutionNote: row.resolutionNote,
        }),
      ),
    };
  }

  async retry(materialId: string, input: RetryProcessingIssueDto) {
    this.requirePlatform("platform.monitor.manage");
    const material = await this.prisma.material.findUnique({
      select: {
        id: true,
        tenantId: true,
        enterpriseId: true,
        ingestionJobs: {
          select: { id: true, purpose: true, errorCode: true },
          orderBy: { queueVersion: "desc" },
          take: 1,
        },
      },
      where: { id: materialId },
    });
    if (!material) throw new NotFoundException("资料不存在");
    if (material.ingestionJobs[0]?.purpose !== "INGEST")
      throw new ConflictException("该异常不属于当前资料处理任务");
    if (processingIssueGuidance(material.ingestionJobs[0]?.errorCode ?? null).stage === "FILE")
      throw new ConflictException("原文件或资料内容需要修正，请联系用户更新内容后再处理");
    return this.ingestion.retryForPlatform(
      { tenantId: material.tenantId, enterpriseId: material.enterpriseId },
      material.id,
      input,
      input.ingestionJobId,
    );
  }

  private requirePlatform(permission: "platform.monitor.read" | "platform.monitor.manage") {
    const principal = this.context.requireSaasAdmin();
    if (principal.scope.type !== "PLATFORM" || !principal.permissions.includes(permission))
      throw new ForbiddenException("需要平台管理员对应的处理异常权限");
    return principal;
  }
}
