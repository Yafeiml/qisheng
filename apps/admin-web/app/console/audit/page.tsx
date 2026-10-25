"use client";

import type { components } from "@xhs-agentic/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import {
  apiRequest,
  type CursorPage,
  consoleNavigationPermissions,
  cursorPagePath,
  selectedAdminRoleName,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type AuditLog = components["schemas"]["AuditLogDto"];

export default function AuditPage() {
  const auth = useMvpSession();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [filter, setFilter] = useState("ALL");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const load = useCallback(
    async (cursor: string | null = null) => {
      if (!auth.session) return;
      setLoading(true);
      setError(null);
      try {
        const page = await apiRequest<CursorPage<AuditLog>>(
          cursorPagePath(
            `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/audit-logs`,
            cursor,
          ),
          { token: auth.session.adminToken },
        );
        setLogs((current) => (cursor ? [...current, ...page.items] : [...page.items]));
        setNextCursor(page.pageInfo.nextCursor);
      } catch (reason) {
        setError(messageOf(reason));
      } finally {
        setLoading(false);
      }
    },
    [auth.session],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const resourceTypes = useMemo(
    () => ["ALL", ...new Set(logs.map(({ resourceType }) => resourceType))],
    [logs],
  );
  const visibleLogs =
    filter === "ALL" ? logs : logs.filter(({ resourceType }) => resourceType === filter);
  if (auth.session === undefined) return <AuditLoading />;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  return (
    <SaasShell
      active="audit"
      description="关键组织、员工资格、素材、角色、活动和审核动作形成不可变审计记录。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="审计日志"
      toolbar={
        <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
          刷新日志
        </button>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      <section className="metricGrid four">
        <Metric detail="当前已加载企业记录" label="审计事件" value={logs.length} tone="accent" />
        <Metric
          detail="后台管理员操作"
          label="用户动作"
          value={logs.filter(({ actorType }) => actorType === "USER").length}
        />
        <Metric
          detail="系统自动处理与任务状态推进"
          label="系统动作"
          value={logs.filter(({ actorType }) => actorType === "SYSTEM").length}
        />
        <Metric
          detail="外部受限服务账号"
          label="集成动作"
          value={logs.filter(({ actorType }) => actorType === "INTEGRATION").length}
        />
      </section>
      <section className="panel auditPanel">
        <div className="panelHeader auditHeader">
          <div>
            <span className="sectionKicker">AUDIT TRAIL</span>
            <h2>企业操作时间线</h2>
            <p>为保护敏感信息，此处不展示手机号明细等数据。</p>
          </div>
          <label className="compactSelect">
            <span>资源类型</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              {resourceTypes.map((type) => (
                <option key={type} value={type}>
                  {type === "ALL" ? "全部资源" : type}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="auditTimeline">
          {visibleLogs.map((log) => (
            <article key={log.id}>
              <time>
                <b>{formatTime(log.createdAt)}</b>
                <span>{formatDay(log.createdAt)}</span>
              </time>
              <i className={log.actorType.toLowerCase()} />
              <div>
                <strong>{actionLabel(log.action)}</strong>
                <p>
                  {log.resourceType} · {log.resourceId?.slice(0, 12) ?? "—"}
                </p>
                <small>{log.reason ?? "操作已按业务规则记录"}</small>
              </div>
              <div>
                <StatusBadge tone={log.actorType === "USER" ? "success" : "neutral"}>
                  {log.actorType}
                </StatusBadge>
                <small>{log.actor.phone ?? "系统服务"}</small>
              </div>
            </article>
          ))}
          {visibleLogs.length === 0 ? <p className="emptyHint">当前筛选下没有审计记录。</p> : null}
          {nextCursor ? (
            <button
              className="ghostButton"
              disabled={loading}
              onClick={() => void load(nextCursor)}
              type="button"
            >
              {loading ? "加载中…" : "加载更多日志"}
            </button>
          ) : null}
        </div>
      </section>
    </SaasShell>
  );
}

function Metric({
  detail,
  label,
  tone,
  value,
}: Readonly<{ detail: string; label: string; tone?: string; value: number }>) {
  return (
    <article className={`metricCard ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
function actionLabel(value: string): string {
  return (
    (
      {
        "campaign.approve-and-schedule": "审核通过并安排员工开放",
        "campaign.generation.queue": "创建活动自动生成任务",
        "customer.provision": "开通 SaaS 客户",
        "membership.enable": "启用员工",
        "membership.import": "导入企业员工",
        "material.create": "创建内容素材",
        "material.disable": "停用内容素材",
        "material.version.publish": "发布素材新版本",
        "sensitive-rule.create": "创建敏感规则",
        "sensitive-rule.disable": "停用敏感规则",
        "sensitive-rule.version.publish": "发布敏感规则新版本",
        "geo-entity.create": "添加宣传重点",
        "geo-entity.disable": "停用宣传重点",
        "geo-entity.version.publish": "更新宣传重点",
        "geo-topic.create": "创建 GEO 问题主题",
        "geo-topic.disable": "停用 GEO 问题主题",
        "geo-topic.version.publish": "发布 GEO 问题主题新版本",
        "model-route.configure": "更新模型路由",
        "role-binding.grant": "授予后台角色",
      } as Record<string, string>
    )[value] ?? value
  );
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}
function formatDay(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { day: "2-digit", month: "2-digit" }).format(
    new Date(value),
  );
}
function AuditLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          AUDIT
        </span>
        <h1 suppressHydrationWarning>正在读取审计日志…</h1>
      </section>
    </main>
  );
}
