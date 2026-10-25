"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import {
  campaignNextAction,
  campaignStatusLabel,
  campaignStatusTone,
  formatBusinessDate,
} from "../../lib/business-language";
import {
  apiRequest,
  consoleNavigationPermissions,
  preloadApiRequest,
  selectedAdminRoleName,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type Campaign = components["schemas"]["CampaignListItemDto"];
type CampaignPage = components["schemas"]["CampaignListPageDto"];
type Workspace = components["schemas"]["EnterpriseWorkspaceSummaryDto"];
type CampaignView = "ACTION_REQUIRED" | "ACTIVE" | "HISTORY" | "ALL";

const views: readonly Readonly<{
  key: CampaignView;
  label: string;
  statuses: readonly string[];
}>[] = [
  { key: "ACTIVE", label: "执行中", statuses: ["APPROVED", "ACTIVE"] },
  {
    key: "ACTION_REQUIRED",
    label: "待处理",
    statuses: ["GENERATION_FAILED", "REVIEW_PENDING", "GENERATING"],
  },
  { key: "HISTORY", label: "历史活动", statuses: ["COMPLETED", "EXPIRED", "CANCELLED"] },
  { key: "ALL", label: "全部", statuses: [] },
];

const exceptionFilters = [
  "ALL",
  "RETRIED",
  "CONTENT_COMPLIANCE",
  "TEMPORARY_SERVICE",
  "PLATFORM_CONFIGURATION",
  "INTERNAL_ERROR",
] as const;

export default function CampaignsPage() {
  const auth = useMvpSession();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number> | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<CampaignView>("ACTIVE");
  const [archiveFilter, setArchiveFilter] = useState<"ACTIVE" | "ALL" | "ARCHIVED">("ACTIVE");
  const [exceptionFilter, setExceptionFilter] = useState<(typeof exceptionFilters)[number]>("ALL");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const parameter = new URLSearchParams(window.location.search).get("view");
    const requested = parameter === "UPCOMING" ? "ACTIVE" : parameter;
    if (views.some(({ key }) => key === requested)) setView(requested as CampaignView);
  }, []);

  const load = useCallback(async () => {
    if (!auth.session) return;
    setLoading(true);
    setError(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const statuses = views.find(({ key }) => key === view)?.statuses ?? [];
      const campaignRequests = statuses.length
        ? statuses.map((status) =>
            apiRequest<CampaignPage>(
              campaignListPath(`${base}/campaigns`, {
                archive: archiveFilter,
                exceptionType: exceptionFilter === "ALL" ? null : exceptionFilter,
                search,
                status,
              }),
              { token: auth.session?.adminToken },
            ),
          )
        : [
            apiRequest<CampaignPage>(
              campaignListPath(`${base}/campaigns`, {
                archive: archiveFilter,
                exceptionType: exceptionFilter === "ALL" ? null : exceptionFilter,
                search,
                status: null,
              }),
              { token: auth.session.adminToken },
            ),
          ];
      const [pages, workspaceData] = await Promise.all([
        Promise.all(campaignRequests),
        apiRequest<Workspace>(`${base}/workspace`, { token: auth.session.adminToken }),
      ]);
      const unique = new Map(pages.flatMap(({ items }) => items).map((item) => [item.id, item]));
      setCampaigns(
        [...unique.values()]
          .sort(
            (left, right) =>
              new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
          )
          .slice(0, 20),
      );
      setWorkspace(workspaceData);
      setStatusCounts(pages[0]?.statusCounts ?? null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [archiveFilter, auth.session, exceptionFilter, search, view]);

  const preloadView = useCallback(
    (targetView: CampaignView) => {
      if (!auth.session || targetView === view) return;
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const statuses = views.find(({ key }) => key === targetView)?.statuses ?? [];
      const paths = statuses.length
        ? statuses.map((status) =>
            campaignListPath(`${base}/campaigns`, {
              archive: archiveFilter,
              exceptionType: exceptionFilter === "ALL" ? null : exceptionFilter,
              search,
              status,
            }),
          )
        : [
            campaignListPath(`${base}/campaigns`, {
              archive: archiveFilter,
              exceptionType: exceptionFilter === "ALL" ? null : exceptionFilter,
              search,
              status: null,
            }),
          ];
      void Promise.all(
        paths.map((path) =>
          preloadApiRequest<CampaignPage>(path, {
            token: auth.session?.adminToken,
          }),
        ),
      ).catch(() => undefined);
    },
    [archiveFilter, auth.session, exceptionFilter, search, view],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!statusCounts?.GENERATING) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [statusCounts, load]);

  const permissions = useMemo(
    () => (auth.session ? consoleNavigationPermissions(auth.session) : []),
    [auth.session],
  );
  const canCreate = permissions.includes("campaign.manage");

  if (auth.session === undefined) return <CampaignsLoading />;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;

  return (
    <SaasShell
      active="campaigns"
      description="已批准的活动进入执行中，到开放时间后员工可领取素材；各活动独立管理发布安排。"
      mode="console"
      navigationPermissions={permissions}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="活动"
      toolbar={
        <div className="toolbar">
          <button
            className="ghostButton refreshButton"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? "正在刷新…" : "刷新"}
          </button>
          {canCreate ? (
            <Link className="primaryButton createButton" href="/console/campaigns/new">
              创建活动
            </Link>
          ) : null}
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}

      <section className="campaignAttentionStrip">
        <AttentionMetric
          label="等待审核"
          value={workspace?.campaigns.reviewPending ?? 0}
          warning={(workspace?.campaigns.reviewPending ?? 0) > 0}
        />
        <AttentionMetric
          label="生成异常"
          value={workspace?.campaigns.generationFailed ?? 0}
          warning={(workspace?.campaigns.generationFailed ?? 0) > 0}
        />
        <AttentionMetric label="等待开放" value={workspace?.campaigns.approved ?? 0} />
        <AttentionMetric label="已向员工开放" value={workspace?.campaigns.active ?? 0} />
      </section>

      <section className="panel compactCampaignPanel" id="campaign-list">
        <div className="campaignViewHeader">
          <div className="campaignViewTabs" role="tablist" aria-label="活动工作视图">
            {views.map((item) => (
              <button
                aria-selected={view === item.key}
                className={view === item.key ? "active" : ""}
                key={item.key}
                onFocus={() => preloadView(item.key)}
                onClick={() => setView(item.key)}
                onPointerDown={() => preloadView(item.key)}
                onPointerEnter={() => preloadView(item.key)}
                role="tab"
                type="button"
              >
                {item.label} (
                {statusCounts
                  ? item.statuses.length
                    ? item.statuses.reduce(
                        (count, status) => count + (statusCounts[status] ?? 0),
                        0,
                      )
                    : Object.values(statusCounts).reduce((count, value) => count + value, 0)
                  : "…"}
                )
              </button>
            ))}
          </div>
          <label className="campaignCompactSearch">
            <span>搜索</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="活动名称或传播主题"
              type="search"
              value={search}
            />
          </label>
        </div>

        <details className="campaignAdvancedFilters">
          <summary>更多筛选</summary>
          <div>
            <label>
              <span>异常原因</span>
              <select
                aria-label="异常原因"
                onChange={(event) =>
                  setExceptionFilter(event.target.value as (typeof exceptionFilters)[number])
                }
                value={exceptionFilter}
              >
                {exceptionFilters.map((value) => (
                  <option key={value} value={value}>
                    {exceptionLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>活动范围</span>
              <select
                aria-label="活动范围"
                onChange={(event) =>
                  setArchiveFilter(event.target.value as "ACTIVE" | "ALL" | "ARCHIVED")
                }
                value={archiveFilter}
              >
                <option value="ACTIVE">日常活动</option>
                <option value="ARCHIVED">已归档</option>
                <option value="ALL">全部</option>
              </select>
            </label>
          </div>
        </details>

        <div className="compactCampaignList">
          {campaigns.map((campaign) => {
            const run = campaign.generationRuns[0];
            const failed = run?.failedCount ?? 0;
            return (
              <Link href={`/console/campaigns/${campaign.id}`} key={campaign.id}>
                <div className="compactCampaignMain">
                  <span>{formatDay(campaign.createdAt)}</span>
                  <div>
                    <strong>{campaign.title}</strong>
                    <small>
                      {campaign.audienceCount} 名员工 · {campaign.generatedCount} 份已生成 · 每人{" "}
                      {campaign.imageCount} 张独立图片
                    </small>
                  </div>
                </div>
                <div className="compactCampaignState">
                  <StatusBadge tone={campaignStatusTone(campaign.status)}>
                    {campaignStatusLabel(campaign.status)}
                  </StatusBadge>
                  <small>{campaignNextAction(campaign.status, failed)}</small>
                </div>
                <div className="compactCampaignTime">
                  <span>员工开放时间</span>
                  <strong>{formatBusinessDate(campaign.visibleAt)}</strong>
                </div>
                <b aria-hidden="true">›</b>
              </Link>
            );
          })}
          {!loading && campaigns.length === 0 ? (
            <div className="emptyState compact">
              <span>这里暂时没有活动</span>
              <p>
                {view === "ACTION_REQUIRED"
                  ? "当前没有需要你立即处理的活动。"
                  : "换一个工作视图，或创建下一期活动。"}
              </p>
              {canCreate ? (
                <Link className="primaryButton createButton" href="/console/campaigns/new">
                  创建活动
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </SaasShell>
  );
}

function campaignListPath(
  base: string,
  filters: Readonly<{
    archive: "ACTIVE" | "ALL" | "ARCHIVED";
    exceptionType: string | null;
    search: string;
    status: string | null;
  }>,
): string {
  const query = new URLSearchParams({ archive: filters.archive, limit: "20" });
  if (filters.exceptionType) query.set("exceptionType", filters.exceptionType);
  if (filters.search.trim()) query.set("search", filters.search.trim());
  if (filters.status) query.set("status", filters.status);
  return `${base}?${query.toString()}`;
}

function AttentionMetric({
  label,
  value,
  warning = false,
}: Readonly<{ label: string; value: number; warning?: boolean }>) {
  return (
    <div className={warning ? "warning" : ""}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function exceptionLabel(value: string): string {
  return (
    {
      ALL: "全部异常",
      CONTENT_COMPLIANCE: "内容规范问题",
      INTERNAL_ERROR: "系统处理异常",
      PLATFORM_CONFIGURATION: "平台配置问题",
      RETRIED: "发生过自动重试",
      TEMPORARY_SERVICE: "服务暂时不可用",
    }[value] ?? "其他异常"
  );
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { day: "2-digit", month: "2-digit" }).format(
    new Date(value),
  );
}

function CampaignsLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <h1 suppressHydrationWarning>正在读取活动…</h1>
      </section>
    </main>
  );
}
