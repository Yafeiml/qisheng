"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { WorkspaceTabs } from "../../components/workspace-tabs";
import {
  API_BASE_URL,
  apiRequest,
  consoleNavigationPermissions,
  selectedAdminRoleName,
  trackedFetch,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type Dashboard = components["schemas"]["CampaignDashboardDto"];
type DashboardTask = Dashboard["incompleteEmployees"][number];
type ManagementAction = components["schemas"]["ManagementActionResponseDto"];
type AnalysisView = "CAMPAIGNS" | "CONTENT" | "ENTERPRISE" | "INCOMPLETE" | "RANKING" | "REMINDERS";
type ScopeMode = "ENTERPRISE" | "GROUP";

export default function AnalyticsPage() {
  const auth = useMvpSession();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [campaignOptions, setCampaignOptions] = useState<Dashboard["campaigns"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AnalysisView>("RANKING");
  const [selectedCampaignId, setSelectedCampaignId] = useState("ALL");
  const [periodDays, setPeriodDays] = useState("30");
  const [scopeMode, setScopeMode] = useState<ScopeMode>("ENTERPRISE");
  const [managementActions, setManagementActions] = useState<ManagementAction[]>([]);
  const [editingAction, setEditingAction] = useState<ManagementAction | null>(null);
  const [actionDrawerOpen, setActionDrawerOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [lateCorrectionTask, setLateCorrectionTask] = useState<DashboardTask | null>(null);
  const [lateCorrectionDrawerOpen, setLateCorrectionDrawerOpen] = useState(false);
  const [lateCorrectionBusy, setLateCorrectionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionForm, setActionForm] = useState({
    assignee: "",
    campaignId: "",
    description: "",
    dueAt: "",
    note: "",
    status: "OPEN" as "IN_PROGRESS" | "OPEN" | "RESOLVED",
    title: "",
  });
  const [lateCorrectionForm, setLateCorrectionForm] = useState({ reason: "", url: "" });

  const load = useCallback(async () => {
    if (!auth.session) return;
    setError(null);
    const permissions = consoleNavigationPermissions(auth.session);
    const canViewGroup = permissions.includes("tenant.dashboard.read");
    const effectiveScope = scopeMode === "GROUP" && canViewGroup ? "GROUP" : "ENTERPRISE";
    const base =
      effectiveScope === "GROUP"
        ? `/console/tenants/${auth.session.tenantId}/dashboard`
        : `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/dashboard`;
    const range = dashboardDateRange(Number(periodDays));
    const query = new URLSearchParams({ from: range.from, to: range.to });
    if (effectiveScope === "ENTERPRISE" && selectedCampaignId !== "ALL") {
      query.set("campaignId", selectedCampaignId);
    }
    const url = `${base}?${query.toString()}`;
    try {
      const [result, actions] = await Promise.all([
        apiRequest<Dashboard>(url, { token: auth.session.adminToken }),
        apiRequest<ManagementAction[]>(
          `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/management-actions`,
          { token: auth.session.adminToken },
        ),
      ]);
      setDashboard(result);
      setManagementActions(actions);
      if (selectedCampaignId === "ALL" && effectiveScope === "ENTERPRISE") {
        setCampaignOptions(result.campaigns);
      }
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session, periodDays, scopeMode, selectedCampaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreateAction() {
    setLateCorrectionDrawerOpen(false);
    setEditingAction(null);
    setActionForm({
      assignee: "",
      campaignId: selectedCampaignId === "ALL" ? "" : selectedCampaignId,
      description: "",
      dueAt: localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      note: "",
      status: "OPEN",
      title: insightActionTitle(dashboard),
    });
    setActionDrawerOpen(true);
  }

  function openUpdateAction(action: ManagementAction) {
    setLateCorrectionDrawerOpen(false);
    setEditingAction(action);
    setActionForm({
      assignee: action.assignee ?? "",
      campaignId: action.campaignId ?? "",
      description: action.description ?? "",
      dueAt: action.dueAt ? localDateTime(new Date(action.dueAt)) : "",
      note: action.note ?? "",
      status: action.status,
      title: action.title,
    });
    setActionDrawerOpen(true);
  }

  async function saveManagementAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    setActionBusy(true);
    setError(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/management-actions`;
      await apiRequest(editingAction ? `${base}/${editingAction.id}` : base, {
        body: editingAction
          ? {
              assignee: actionForm.assignee,
              dueAt: actionForm.dueAt ? new Date(actionForm.dueAt).toISOString() : undefined,
              note: actionForm.note,
              status: actionForm.status,
            }
          : {
              assignee: actionForm.assignee || undefined,
              campaignId: actionForm.campaignId || undefined,
              description: actionForm.description || undefined,
              dueAt: actionForm.dueAt ? new Date(actionForm.dueAt).toISOString() : undefined,
              title: actionForm.title,
            },
        method: "POST",
        token: auth.session.adminToken,
      });
      setActionDrawerOpen(false);
      setEditingAction(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setActionBusy(false);
    }
  }

  function openLateCorrection(task: DashboardTask) {
    setActionDrawerOpen(false);
    setLateCorrectionTask(task);
    setLateCorrectionForm({ reason: "", url: "" });
    setLateCorrectionDrawerOpen(true);
  }

  async function submitLateCorrection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !lateCorrectionTask) return;
    setLateCorrectionBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(
        `/console/tenants/${auth.session.tenantId}/enterprises/${lateCorrectionTask.enterpriseId}/tasks/${lateCorrectionTask.taskId}/late-correction`,
        {
          body: lateCorrectionForm,
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setLateCorrectionDrawerOpen(false);
      setLateCorrectionTask(null);
      setNotice("逾期发布已提交验真；验证通过后将记为逾期纠正，不计入按时完成率。");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLateCorrectionBusy(false);
    }
  }

  async function downloadManagementSummary() {
    if (!auth.session) return;
    setError(null);
    const permissions = consoleNavigationPermissions(auth.session);
    const group = scopeMode === "GROUP" && permissions.includes("tenant.dashboard.read");
    const base = group
      ? `/console/tenants/${auth.session.tenantId}/dashboard.csv`
      : `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/dashboard.csv`;
    const range = dashboardDateRange(Number(periodDays));
    const query = new URLSearchParams({ from: range.from, to: range.to });
    if (!group && selectedCampaignId !== "ALL") query.set("campaignId", selectedCampaignId);
    try {
      const response = await trackedFetch(`${API_BASE_URL}${base}?${query.toString()}`, {
        headers: { authorization: `Bearer ${auth.session.adminToken}` },
      });
      if (!response.ok) throw new Error("管理摘要导出失败，请稍后重试");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = group ? "集团经营管理摘要.csv" : "企业经营管理摘要.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  if (auth.session === undefined) return <AnalyticsLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }
  const permissions = consoleNavigationPermissions(auth.session);
  const canViewGroup = permissions.includes("tenant.dashboard.read");
  const canApprovePublication = permissions.includes("campaign.approve");
  const effectiveScopeMode = scopeMode === "GROUP" && canViewGroup ? "GROUP" : "ENTERPRISE";
  const summary = dashboard?.summary;
  const changes = dashboard?.summaryChanges;
  const validPublicationCount = (summary?.verifiedCount ?? 0) + (summary?.lateCorrectedCount ?? 0);
  const validPublicationChange = changes
    ? changes.verifiedCount + changes.lateCorrectedCount
    : null;
  const collectedPublicationCount = observedPublicationCount(dashboard);
  const verifiedWithoutMetrics = Math.max(0, validPublicationCount - collectedPublicationCount);
  const insight = managementInsight(dashboard);
  return (
    <SaasShell
      active="analytics"
      description="帮助管理者判断活动执行是否健康、哪些员工表现突出，以及下一步应优先处理什么。员工端不展示任何排名。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="经营分析"
      toolbar={
        <div className="workspaceActionButtons">
          <button
            className="ghostButton"
            onClick={() => void downloadManagementSummary()}
            type="button"
          >
            导出管理摘要
          </button>
          <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
            刷新数据
          </button>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <div className="permissionNotice">
        <div>
          <strong>
            当前数据作用域：
            {effectiveScopeMode === "GROUP" ? auth.session.tenantName : auth.session.enterpriseName}
          </strong>
          <span>只展示当前账号有权查看的数据，并仅统计链接有效、内容匹配且未重复的发布</span>
        </div>
        <StatusBadge tone="success">权限已应用</StatusBadge>
      </div>
      <section className="metricGrid four">
        <article className="metricCard">
          <span>有效发布</span>
          <strong>{validPublicationCount}</strong>
          <small>
            {formatChange(validPublicationChange)} · 按时 {summary?.verifiedCount ?? 0}，逾期纠正{" "}
            {summary?.lateCorrectedCount ?? 0}
          </small>
        </article>
        <article className="metricCard accent">
          <span>点赞总数</span>
          <strong>{formatNumber(summary?.metricTotals.likes)}</strong>
          <small>
            精确读数覆盖 {summary?.metricCoverage.likes ?? 0} / {validPublicationCount} 条
          </small>
        </article>
        <article className="metricCard">
          <span>评论总数</span>
          <strong>{formatNumber(summary?.metricTotals.comments)}</strong>
          <small>
            精确读数覆盖 {summary?.metricCoverage.comments ?? 0} / {validPublicationCount} 条
          </small>
        </article>
        <article className="metricCard">
          <span>收藏总数</span>
          <strong>{formatNumber(summary?.metricTotals.favorites)}</strong>
          <small>
            精确读数覆盖 {summary?.metricCoverage.favorites ?? 0} / {validPublicationCount} 条
          </small>
        </article>
      </section>
      <div className="permissionNotice">
        <span>
          只汇总精确读数；近似数在采集明细中展示。阅读量未稳定获取，暂不计算互动率。24 小时未完成{" "}
          {summary?.expiredIncompleteCount ?? 0} 人，完成率{" "}
          {formatPercent(summary?.completionRate ?? 0)}（
          {formatPercentagePointChange(changes?.completionRate)}）。
        </span>
      </div>

      <section className={`managementInsight ${insight.tone}`}>
        <div>
          <span>管理结论</span>
          <h2>{insight.title}</h2>
          <p>{insight.description}</p>
        </div>
        <div className="managementInsightFacts">
          <span>
            未提交链接 <strong>{summary?.expiredIncompleteCount ?? 0}</strong>
          </span>
          <span>
            待采集指标 <strong>{verifiedWithoutMetrics}</strong>
          </span>
          <span>
            已采互动 <strong>{collectedPublicationCount}</strong>
          </span>
        </div>
        <div className="managementInsightActions">
          <button className="lightButton" onClick={openCreateAction} type="button">
            建立跟进事项
          </button>
          <Link className="lightButton" href={insight.href}>
            {insight.action}
          </Link>
        </div>
      </section>

      <section className="panel managementActionPanel">
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">异常处理闭环</span>
            <h2>管理跟进事项</h2>
            <p>把看板结论明确交给负责人，并保留处理状态和复盘备注。</p>
          </div>
          <button className="primaryButton" onClick={openCreateAction} type="button">
            新建跟进事项
          </button>
        </div>
        <div className="managementActionList">
          {managementActions.slice(0, 6).map((action) => (
            <article key={action.id}>
              <div>
                <StatusBadge tone={managementActionTone(action.status)}>
                  {managementActionStatusLabel(action.status)}
                </StatusBadge>
                <strong>{action.title}</strong>
                <small>
                  {action.assignee ? `负责人：${action.assignee}` : "尚未指定负责人"}
                  {action.dueAt ? ` · 截止 ${formatDate(action.dueAt)}` : ""}
                </small>
              </div>
              <p>{action.note || action.description || "尚未填写处理说明"}</p>
              <button
                className="ghostButton"
                onClick={() => openUpdateAction(action)}
                type="button"
              >
                更新状态与复盘
              </button>
            </article>
          ))}
          {managementActions.length === 0 ? (
            <div className="emptyState compact">
              <strong>当前没有管理跟进事项</strong>
              <p>出现执行异常或需要复盘的结论时，可直接从本页建立负责人和截止时间。</p>
            </div>
          ) : null}
        </div>
      </section>

      <section className="workspaceActionBar analyticsActionBar">
        <WorkspaceTabs
          active={activeView}
          ariaLabel="经营分析视图"
          onChange={setActiveView}
          tabs={[
            {
              count: dashboard?.metricObservations.length ?? 0,
              key: "RANKING",
              label: "互动采集明细",
            },
            {
              count: dashboard?.incompleteEmployees.length ?? 0,
              key: "INCOMPLETE",
              label: "未完成员工",
            },
            { count: dashboard?.campaigns.length ?? 0, key: "CAMPAIGNS", label: "活动完成情况" },
            {
              count: dashboard?.contentComparisons.length ?? 0,
              key: "CONTENT",
              label: "内容策略对比",
            },
            {
              count: dashboard?.enterpriseComparisons.length ?? 0,
              key: "ENTERPRISE",
              label: "企业对比",
            },
            { count: dashboard?.reminders.length ?? 0, key: "REMINDERS", label: "提醒计划" },
          ]}
        />
        <div className="analyticsFilters">
          {canViewGroup ? (
            <label className="analyticsCampaignFilter">
              <span>组织范围</span>
              <select
                onChange={(event) => {
                  setScopeMode(event.target.value as ScopeMode);
                  setSelectedCampaignId("ALL");
                }}
                value={effectiveScopeMode}
              >
                <option value="ENTERPRISE">当前企业</option>
                <option value="GROUP">集团全部企业</option>
              </select>
            </label>
          ) : null}
          <label className="analyticsCampaignFilter">
            <span>时间范围</span>
            <select onChange={(event) => setPeriodDays(event.target.value)} value={periodDays}>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="90">最近 90 天</option>
            </select>
          </label>
          {effectiveScopeMode === "ENTERPRISE" ? (
            <label className="analyticsCampaignFilter">
              <span>活动范围</span>
              <select
                onChange={(event) => setSelectedCampaignId(event.target.value)}
                value={selectedCampaignId}
              >
                <option value="ALL">全部活动</option>
                {campaignOptions.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </section>

      <section className="analyticsWorkspace">
        <article className="panel" hidden={activeView !== "RANKING"}>
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">采集证据</span>
              <h2>员工互动采集明细</h2>
              <p>按时间显示首次和 T+24、T+72 等采集窗口；“约”表示近似值，不参与精确合计。</p>
            </div>
            <StatusBadge tone="neutral">
              {collectedPublicationCount} 篇 · {dashboard?.metricObservations.length ?? 0} 次
            </StatusBadge>
          </div>
          <section aria-label="员工互动采集明细" className="rankingTable metricSnapshotTable">
            <div className="tableHead">
              <span>员工</span>
              <span>活动</span>
              <span>点赞</span>
              <span>评论</span>
              <span>收藏</span>
              <span>采集时间 / 来源</span>
            </div>
            {dashboard?.metricObservations.map((employee) => (
              <div
                className="tableRow"
                key={`${employee.taskId}-${employee.latestMetrics?.id ?? "unknown"}`}
              >
                <span>
                  <strong>{employee.employeeName}</strong>
                  <small>{employee.employeePhone}</small>
                </span>
                <span>{employee.campaignTitle}</span>
                <span>{formatMetricObservation(employee.latestMetrics, "likes")}</span>
                <span>{formatMetricObservation(employee.latestMetrics, "comments")}</span>
                <span>{formatMetricObservation(employee.latestMetrics, "favorites")}</span>
                <span className="metricObservationTime">
                  <strong>
                    {employee.latestMetrics
                      ? formatDateTime(employee.latestMetrics.observedAt)
                      : "未获取"}
                  </strong>
                  <small>
                    {metricSourceLabel(employee.latestMetrics?.source)} ·{" "}
                    {metricWindowLabel(employee.latestMetrics?.windowHours)}
                  </small>
                </span>
              </div>
            ))}
          </section>
          {!dashboard?.metricObservations.length ? (
            <p className="emptyHint">尚无已采集互动数据的有效发布。</p>
          ) : null}
          {dashboard?.metricWindows.length ? (
            <section aria-label="定时复采窗口状态" className="metricWindowStatuses">
              <h3>定时复采窗口状态</h3>
              <p>错过或待复核的窗口没有指标样本，不作为 0 参与合计。</p>
              <div>
                {dashboard.metricWindows.map((window) => (
                  <article key={`${window.taskId}-${window.windowHours}`}>
                    <strong>
                      {window.employeeName} · {metricWindowLabel(window.windowHours)}
                    </strong>
                    <span>{metricWindowStatusLabel(window.status, window.hasSnapshot)}</span>
                    <small>计划时间 {formatDateTime(window.dueAt)}</small>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </article>

        <article className="panel" hidden={activeView !== "INCOMPLETE"}>
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">未完成员工</span>
              <h2>本期未完成员工</h2>
            </div>
          </div>
          <div className="incompleteList">
            {dashboard?.incompleteEmployees.map((employee) => (
              <div key={employee.taskId}>
                <span>
                  <strong>{employee.employeeName}</strong>
                  <small>
                    {employee.enterpriseName} · {employee.campaignTitle}
                  </small>
                </span>
                <div className="incompleteActions">
                  <StatusBadge tone="danger">24 小时内未提交</StatusBadge>
                  {canApprovePublication ? (
                    <button
                      className="ghostButton"
                      onClick={() => openLateCorrection(employee)}
                      type="button"
                    >
                      逾期核实
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {!dashboard?.incompleteEmployees.length ? (
            <p className="emptyHint">当前没有已失效且未完成的任务。</p>
          ) : null}
          <div
            className="completionRing"
            style={{ "--value": summary?.completionRate ?? 0 } as React.CSSProperties}
          >
            <strong>{formatPercent(summary?.completionRate ?? 0)}</strong>
            <span>总体完成率</span>
          </div>
        </article>
        <article className="panel" hidden={activeView !== "CAMPAIGNS"}>
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">活动完成情况</span>
              <h2>各活动执行进度</h2>
              <p>完成率用于判断员工执行情况，不代表内容传播效果。</p>
            </div>
          </div>
          <div className="campaignPerformanceList">
            {dashboard?.campaigns.map((campaign) => {
              const rate =
                campaign.audienceCount > 0 ? campaign.completedCount / campaign.audienceCount : 0;
              return (
                <article key={campaign.id}>
                  <div>
                    <strong>{campaign.title}</strong>
                    <small>
                      {campaign.completedCount} / {campaign.audienceCount} 人按时完成
                    </small>
                  </div>
                  <progress max={1} value={rate} />
                  <StatusBadge tone={rate >= 0.8 ? "success" : rate > 0 ? "warning" : "neutral"}>
                    {formatPercent(rate)}
                  </StatusBadge>
                </article>
              );
            })}
            {!dashboard?.campaigns.length ? (
              <div className="emptyState compact">
                <strong>当前范围还没有活动</strong>
                <p>创建并开放活动后，这里会展示员工执行完成情况。</p>
              </div>
            ) : null}
          </div>
        </article>
        <article className="panel" hidden={activeView !== "CONTENT"}>
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">跨活动内容表现</span>
              <h2>哪些内容策略更值得复用</h2>
              <p>分别比较内容方向、图片风格和员工开放时段，避免凭单篇爆款做结论。</p>
            </div>
          </div>
          <div className="contentComparisonGroups">
            {(["CONTENT_DIRECTION", "IMAGE_STYLE", "VISIBLE_HOUR"] as const).map((dimension) => (
              <section key={dimension}>
                <h3>{contentDimensionLabel(dimension)}</h3>
                <div className="contentComparisonList">
                  {dashboard?.contentComparisons
                    .filter((item) => item.dimension === dimension)
                    .sort((left, right) => (right.views ?? -1) - (left.views ?? -1))
                    .map((item) => (
                      <article key={`${dimension}-${item.value}`}>
                        <div>
                          <strong>{item.value}</strong>
                          <small>
                            {item.campaignCount} 场活动 · {item.taskCount} 个员工任务
                          </small>
                        </div>
                        <span>
                          完成率 <strong>{formatPercent(item.completionRate)}</strong>
                        </span>
                        <span>
                          精确阅读 <strong>{formatNumber(item.views)}</strong>（覆盖{" "}
                          {item.viewCoverage} 条）
                        </span>
                      </article>
                    ))}
                </div>
              </section>
            ))}
          </div>
        </article>
        <article className="panel" hidden={activeView !== "ENTERPRISE"}>
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">集团经营视角</span>
              <h2>企业执行与传播对比</h2>
              <p>集团管理员可比较各企业；企业管理员只会看到当前企业。</p>
            </div>
          </div>
          <div className="enterpriseComparisonList">
            {dashboard?.enterpriseComparisons.map((item, index) => (
              <article key={item.enterpriseId}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <div>
                  <strong>{item.enterpriseName}</strong>
                  <small>
                    {item.campaignCount} 场活动 · {item.verifiedCount} / {item.taskCount} 按时完成
                    {item.lateCorrectedCount > 0 ? ` · ${item.lateCorrectedCount} 条逾期纠正` : ""}
                  </small>
                </div>
                <span>{formatPercent(item.completionRate)} 完成</span>
                <span>
                  {formatNumber(item.metricTotals.views)} 精确阅读（覆盖 {item.metricCoverage.views}{" "}
                  条）
                </span>
              </article>
            ))}
          </div>
        </article>
        <article className="panel" hidden={activeView !== "REMINDERS"}>
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">运营提醒计划</span>
              <h2>尚未提交链接的员工提醒时点</h2>
              <p>这里只呈现提醒计划与待完成人数，不会替员工执行发布。</p>
            </div>
          </div>
          <div className="reminderPlanList">
            {dashboard?.reminders.map((reminder) => (
              <article key={`${reminder.campaignId}-${reminder.offsetHours}`}>
                <div>
                  <strong>{reminder.campaignTitle}</strong>
                  <small>
                    开放后 {reminder.offsetHours} 小时 · {formatDateTime(reminder.dueAt)}
                  </small>
                </div>
                <StatusBadge tone={reminderStatusTone(reminder.status)}>
                  {reminderStatusLabel(reminder.status)}
                </StatusBadge>
                <span>待完成 {reminder.pendingCount} 人</span>
              </article>
            ))}
            {!dashboard?.reminders.length ? (
              <div className="emptyState compact">
                <strong>当前范围没有提醒计划</strong>
                <p>创建活动时可选择开放后 6、12 或 18 小时检查尚未提交链接的员工。</p>
              </div>
            ) : null}
          </div>
        </article>
      </section>
      <WorkspaceDrawer
        description={
          editingAction
            ? "更新负责人、处理状态和复盘备注。已解决事项仍会保留，便于后续复盘。"
            : "把当前管理结论转成明确的负责人、截止时间和处理事项。"
        }
        onClose={() => setActionDrawerOpen(false)}
        open={actionDrawerOpen}
        title={editingAction ? "更新管理跟进事项" : "新建管理跟进事项"}
      >
        <form className="drawerForm" onSubmit={(event) => void saveManagementAction(event)}>
          <label className="field">
            <span>事项标题</span>
            <input
              disabled={Boolean(editingAction)}
              maxLength={200}
              onChange={(event) => setActionForm({ ...actionForm, title: event.target.value })}
              required
              value={actionForm.title}
            />
          </label>
          {!editingAction ? (
            <>
              <label className="field">
                <span>关联活动（选填）</span>
                <select
                  onChange={(event) =>
                    setActionForm({ ...actionForm, campaignId: event.target.value })
                  }
                  value={actionForm.campaignId}
                >
                  <option value="">不关联具体活动</option>
                  {campaignOptions.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>问题说明</span>
                <textarea
                  maxLength={1000}
                  onChange={(event) =>
                    setActionForm({ ...actionForm, description: event.target.value })
                  }
                  rows={3}
                  value={actionForm.description}
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>处理状态</span>
              <select
                onChange={(event) =>
                  setActionForm({
                    ...actionForm,
                    status: event.target.value as typeof actionForm.status,
                  })
                }
                value={actionForm.status}
              >
                <option value="OPEN">待处理</option>
                <option value="IN_PROGRESS">处理中</option>
                <option value="RESOLVED">已解决</option>
              </select>
            </label>
          )}
          <div className="fieldGrid">
            <label className="field">
              <span>负责人</span>
              <input
                maxLength={120}
                onChange={(event) => setActionForm({ ...actionForm, assignee: event.target.value })}
                placeholder="姓名或岗位"
                value={actionForm.assignee}
              />
            </label>
            <label className="field">
              <span>截止时间</span>
              <input
                onChange={(event) => setActionForm({ ...actionForm, dueAt: event.target.value })}
                type="datetime-local"
                value={actionForm.dueAt}
              />
            </label>
          </div>
          {editingAction ? (
            <label className="field">
              <span>处理进展与复盘备注</span>
              <textarea
                maxLength={4000}
                onChange={(event) => setActionForm({ ...actionForm, note: event.target.value })}
                rows={5}
                value={actionForm.note}
              />
            </label>
          ) : null}
          <button className="primaryButton block drawerSubmit" disabled={actionBusy} type="submit">
            {actionBusy ? "正在保存…" : editingAction ? "保存处理进展" : "建立跟进事项"}
          </button>
        </form>
      </WorkspaceDrawer>
      <WorkspaceDrawer
        description="用于处理员工在 24 小时期限后提供的真实发布链接。系统仍会执行链接清洗、全局去重、正文、事实和图片匹配；通过后单独记为逾期纠正。"
        onClose={() => {
          setLateCorrectionDrawerOpen(false);
          setLateCorrectionTask(null);
        }}
        open={lateCorrectionDrawerOpen}
        title="核实逾期发布"
      >
        <form className="drawerForm" onSubmit={(event) => void submitLateCorrection(event)}>
          <div className="permissionNotice compact">
            <div>
              <strong>{lateCorrectionTask?.employeeName ?? "未选择员工"}</strong>
              <span>
                {lateCorrectionTask?.enterpriseName ?? "—"} ·{" "}
                {lateCorrectionTask?.campaignTitle ?? "—"}
              </span>
            </div>
            <StatusBadge tone="warning">不计入按时完成率</StatusBadge>
          </div>
          <label className="field">
            <span>小红书发布链接或分享文本</span>
            <textarea
              maxLength={4000}
              onChange={(event) =>
                setLateCorrectionForm({ ...lateCorrectionForm, url: event.target.value })
              }
              placeholder="粘贴员工补交的公开链接或包含链接的分享文本"
              required
              rows={4}
              value={lateCorrectionForm.url}
            />
          </label>
          <label className="field">
            <span>纠正原因</span>
            <textarea
              maxLength={500}
              minLength={2}
              onChange={(event) =>
                setLateCorrectionForm({ ...lateCorrectionForm, reason: event.target.value })
              }
              placeholder="例如：员工按时发布但逾期补交链接，经运营核实后发起验真"
              required
              rows={4}
              value={lateCorrectionForm.reason}
            />
          </label>
          <div className="inlineWarning">
            提交只代表发起验真，不会直接判定完成；重复链接或内容不匹配仍会被拒绝。
          </div>
          <button
            className="primaryButton block drawerSubmit"
            disabled={lateCorrectionBusy}
            type="submit"
          >
            {lateCorrectionBusy ? "正在提交验真…" : "提交逾期验真"}
          </button>
        </form>
      </WorkspaceDrawer>
    </SaasShell>
  );
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "未获取"
    : new Intl.NumberFormat("zh-CN").format(value);
}

type ObservedMetric = NonNullable<Dashboard["metricObservations"][number]["latestMetrics"]>;
type ObservedMetricName = "comments" | "favorites" | "likes";

function formatMetricObservation(metric: ObservedMetric | null, name: ObservedMetricName): string {
  const exact = metric?.[name];
  if (exact !== null && exact !== undefined) return formatNumber(exact);
  const rawData = metric?.rawData;
  if (!rawData || typeof rawData !== "object") return "未获取";
  const precision = rawData.metricPrecision;
  const displays = rawData.metricDisplay;
  if (!metricRecord(precision) || precision[name] !== "APPROXIMATE" || !metricRecord(displays)) {
    return "未获取";
  }
  const display = displays[name];
  return typeof display === "string" && SAFE_METRIC_DISPLAY.test(display)
    ? `${display.trim()}（约）`
    : "未获取";
}

const SAFE_METRIC_DISPLAY =
  /^\s*(?:\d{1,9}|\d{1,3}(?:[,，]\d{3}){1,2})(?:[.．]\d{1,2})?\s*(?:[千万亿])?\s*[+＋]?\s*$/u;

function metricRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metricWindowLabel(windowHours: number | null | undefined): string {
  if (windowHours === null || windowHours === undefined) return "未指定窗口";
  return windowHours === 0 ? "首次采集" : `T+${windowHours} 小时复采`;
}

function metricWindowStatusLabel(status: string, hasSnapshot: boolean): string {
  if (status === "SKIPPED") return hasSnapshot ? "自动采集错过，另有样本" : "已错过，无样本";
  if (status === "NEEDS_REVIEW") return hasSnapshot ? "待复核，另有样本" : "待复核，无样本";
  if (hasSnapshot) return "已有采集样本";
  if (status === "LEASED") return "采集中，暂无样本";
  if (status === "QUEUED") return "等待采集，暂无样本";
  return "暂无采集样本";
}

function metricSourceLabel(source: string | undefined): string {
  if (source === "WINDOWS_BROWSER" || source === "WORKBUDDY_BROWSER") return "专机浏览器";
  if (source === "HERMES") return "既有指标服务";
  return source ?? "来源未知";
}

function observedPublicationCount(dashboard: Dashboard | null): number {
  return new Set((dashboard?.metricObservations ?? []).map(({ taskId }) => taskId)).size;
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, style: "percent" }).format(
    value,
  );
}

function formatChange(value: number | null | undefined): string {
  if (value === null || value === undefined) return "暂无环比";
  if (value === 0) return "环比持平";
  return `环比 ${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

function formatPercentagePointChange(value: number | null | undefined): string {
  if (value === null || value === undefined) return "暂无环比";
  if (value === 0) return "环比持平";
  return `环比 ${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} 个百分点`;
}

function dashboardDateRange(days: number): Readonly<{ from: string; to: string }> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(
    new Date(value),
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

function managementActionStatusLabel(status: ManagementAction["status"]): string {
  if (status === "IN_PROGRESS") return "处理中";
  if (status === "RESOLVED") return "已解决";
  return "待处理";
}

function managementActionTone(
  status: ManagementAction["status"],
): "neutral" | "success" | "warning" {
  if (status === "IN_PROGRESS") return "warning";
  if (status === "RESOLVED") return "success";
  return "neutral";
}

function reminderStatusLabel(status: Dashboard["reminders"][number]["status"]): string {
  if (status === "DUE") return "已到提醒时点";
  if (status === "COMPLETED") return "无需提醒";
  return "尚未到时";
}

function reminderStatusTone(
  status: Dashboard["reminders"][number]["status"],
): "neutral" | "success" | "warning" {
  if (status === "DUE") return "warning";
  if (status === "COMPLETED") return "success";
  return "neutral";
}

function contentDimensionLabel(
  dimension: Dashboard["contentComparisons"][number]["dimension"],
): string {
  if (dimension === "IMAGE_STYLE") return "图片风格";
  if (dimension === "VISIBLE_HOUR") return "员工开放时段";
  return "内容方向";
}

function insightActionTitle(dashboard: Dashboard | null): string {
  const summary = dashboard?.summary;
  if (!summary || summary.taskCount === 0) return "建立首期活动复盘计划";
  if (summary.expiredIncompleteCount > 0) return "跟进本期未完成员工";
  if (observedPublicationCount(dashboard) < summary.verifiedCount + summary.lateCorrectedCount)
    return "跟进传播指标采集";
  return "复盘本期互动采集记录";
}

function managementInsight(dashboard: Dashboard | null): Readonly<{
  action: string;
  description: string;
  href: string;
  title: string;
  tone: "attention" | "positive" | "quiet";
}> {
  const summary = dashboard?.summary;
  if (!summary || summary.taskCount === 0) {
    return {
      action: "创建第一场活动",
      description:
        "当前还没有员工执行数据。先完成一次活动，系统才能形成完成率、员工表现和传播数据。",
      href: "/console/campaigns/new",
      title: "尚未形成可分析的数据",
      tone: "quiet",
    };
  }
  if (summary.expiredIncompleteCount > 0) {
    return {
      action: "查看活动执行",
      description: `有 ${summary.expiredIncompleteCount} 名员工在开放后 24 小时内没有提交发布链接。建议先核对提醒节奏、活动时间和未完成人员分布。`,
      href: "/console/campaigns",
      title: "本期员工执行需要关注",
      tone: "attention",
    };
  }
  const withoutMetrics = Math.max(
    0,
    summary.verifiedCount + summary.lateCorrectedCount - observedPublicationCount(dashboard),
  );
  if (withoutMetrics > 0) {
    return {
      action: "查看活动记录",
      description: `已有 ${withoutMetrics} 条有效发布尚未采集到互动指标。完成采集后再判断传播表现更可靠。`,
      href: "/console/campaigns",
      title: "员工已完成，传播指标仍在补齐",
      tone: "quiet",
    };
  }
  return {
    action: "复盘活动内容",
    description:
      "互动数据已按采集时间展示。比较传播效果时先核对时间窗口和指标覆盖，不把未获取当成 0。",
    href: "/console/campaigns",
    title: summary.completionRate >= 0.8 ? "本期执行整体健康" : "本期执行仍有提升空间",
    tone: summary.completionRate >= 0.8 ? "positive" : "quiet",
  };
}

function AnalyticsLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <h1 suppressHydrationWarning>正在读取看板…</h1>
      </section>
    </main>
  );
}
