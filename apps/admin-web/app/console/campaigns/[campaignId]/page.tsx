"use client";

import type { components } from "@xhs-agentic/contracts";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionConfirmDialog,
  type ConfirmDialogState,
} from "../../../components/action-confirm-dialog";
import { ActionIcon } from "../../../components/action-icon";
import { CampaignEffects } from "../../../components/campaign-effects";
import { ConsoleScopeSwitcher } from "../../../components/console-scope-switcher";
import { FeedbackMessage, useFeedbackToast } from "../../../components/feedback-toast";
import { MvpSetup } from "../../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../../components/saas-shell";
import {
  workItemStatusLabel as businessWorkItemStatusLabel,
  campaignNextAction,
  campaignStatusLabel,
  campaignStatusTone,
  timelineStatusLabel,
} from "../../../lib/business-language";
import { CAMPAIGN_PREPARATION_MS, earliestCampaignSchedule } from "../../../lib/campaign-schedule";
import { contentReviewSummary } from "../../../lib/content-review";
import {
  API_BASE_URL,
  apiRequest,
  consoleNavigationPermissions,
  selectedAdminRoleName,
  storageObjectUrl,
  trackedFetch,
} from "../../../lib/mvp-client";
import {
  publicationWallDestination,
  publicationWallStatus,
} from "../../../lib/publication-wall-status";
import { messageOf, useMvpSession } from "../../../lib/use-mvp-session";

type CampaignDetail = components["schemas"]["CampaignDetailDto"] & { selectionSnapshot?: unknown };
type CampaignTimeline = components["schemas"]["CampaignTimelineDto"];
type CampaignWorkItem = components["schemas"]["CampaignWorkItemListItemDto"];
type DetailTab = "OVERVIEW" | "REVIEW" | "EXECUTION" | "RECORDS" | "EFFECTS";
type PendingConfirmation = ConfirmDialogState &
  Readonly<{ run: (reason: string) => Promise<void> }>;

const workItemFilters = ["ALL", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
const reviewFilters = ["ALL", "RISK", "WARNING", "REPLACED", "PASSED"] as const;

export default function LiveCampaignDetailPage() {
  const auth = useMvpSession();
  const { notify } = useFeedbackToast();
  const scheduleInput = useRef<HTMLInputElement>(null);
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId;
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [timeline, setTimeline] = useState<CampaignTimeline | null>(null);
  const [workItems, setWorkItems] = useState<CampaignWorkItem[]>([]);
  const [selectedContentId, setSelectedContentId] = useState<string | null>(null);
  const [workItemFilter, setWorkItemFilter] = useState<(typeof workItemFilters)[number]>("ALL");
  const [workItemEmployee, setWorkItemEmployee] = useState("");
  const [reviewFilter, setReviewFilter] = useState<(typeof reviewFilters)[number]>("ALL");
  const [visibleAt, setVisibleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("OVERVIEW");
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [clockNow, setClockNow] = useState(0);

  useEffect(() => {
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!auth.session || !campaignId) return;
    setError(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaignId}`;
      const [data, timelineData] = await Promise.all([
        apiRequest<CampaignDetail>(base, { token: auth.session.adminToken }),
        apiRequest<CampaignTimeline>(`${base}/timeline`, { token: auth.session.adminToken }),
      ]);
      setCampaign(data);
      setTimeline(timelineData);
      setVisibleAt(localDateTime(new Date(data.visibleAt)));
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session, campaignId]);

  const loadWorkItems = useCallback(async () => {
    if (!auth.session || !campaignId) return;
    const query = new URLSearchParams({ limit: "100" });
    if (workItemFilter !== "ALL") query.set("status", workItemFilter);
    if (workItemEmployee.trim()) query.set("employee", workItemEmployee.trim());
    try {
      const page = await apiRequest<components["schemas"]["CampaignWorkItemPageDto"]>(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaignId}/work-items?${query.toString()}`,
        { token: auth.session.adminToken },
      );
      setWorkItems([...page.items]);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session, campaignId, workItemEmployee, workItemFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkItems(), 200);
    return () => window.clearTimeout(timer);
  }, [loadWorkItems]);

  useEffect(() => {
    if (campaign?.status !== "GENERATING") return;
    const timer = window.setInterval(() => void load(), 1_000);
    return () => window.clearInterval(timer);
  }, [campaign?.status, load]);

  async function performApprove() {
    if (!auth.session || !campaign) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaign.id}/approve`,
        {
          body:
            new Date(visibleAt).getTime() > Date.now()
              ? { visibleAt: new Date(visibleAt).toISOString() }
              : {},
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      await load();
      setNotice("活动已审核通过，员工将在统一开放时间看到各自内容");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  function validateFutureSchedule() {
    const date = new Date(visibleAt);
    if (!visibleAt || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      notify({
        tone: "error",
        content: "请选择未来的员工开放时间，过期排期不能直接发布。",
        field: scheduleInput,
      });
      return false;
    }
    if (
      campaign &&
      date.getTime() < new Date(campaign.createdAt).getTime() + CAMPAIGN_PREPARATION_MS
    ) {
      notify({
        tone: "error",
        content: "开放时间不能早于活动创建时间。",
        field: scheduleInput,
      });
      return false;
    }
    return true;
  }

  function requestApprove() {
    if (!campaign) return;
    setConfirmation({
      confirmLabel: "确认排期发布",
      defaultReason: "已完成内容抽检，同意按计划开放",
      impacts: [
        `${campaign.audienceCount} 名员工将各自收到独立图文`,
        `员工可查看素材的时间：${new Date(visibleAt).getTime() > Date.now() ? formatDate(new Date(visibleAt).toISOString()) : "审核完成立即开放"}`,
        "开放后 24 小时内未提交发布链接的员工将记为本期未完成",
      ],
      reasonLabel: "审核说明",
      run: async () => performApprove(),
      summary: "通过后按所选时间开放；排期已到时立即开放。",
      title: "确认本期内容排期发布？",
      tone: "warning",
    });
  }

  async function retryFailed() {
    if (!auth.session || !campaign) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaign.id}/retry-failed`,
        { method: "POST", token: auth.session.adminToken },
      );
      await load();
      setNotice("失败员工任务已重新进入生成队列");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  function changeArchive(action: "archive" | "restore") {
    if (!auth.session || !campaign) return;
    setConfirmation({
      confirmLabel: action === "archive" ? "确认归档" : "恢复到活动列表",
      defaultReason: action === "archive" ? "活动已结束，移出日常运营列表" : "需要重新查看历史活动",
      impacts: [
        action === "archive" ? "活动将从日常运营列表移入归档" : "活动会重新出现在日常运营列表",
        "不会修改员工任务或发布结果",
      ],
      reasonLabel: action === "archive" ? "归档说明" : "恢复说明",
      run: async (reason) => performArchive(action, reason),
      summary: "归档只改变列表展示位置，活动历史和数据仍会完整保留。",
      title: action === "archive" ? "归档这项活动？" : "恢复这项活动？",
    });
  }

  async function performArchive(action: "archive" | "restore", reason: string) {
    if (!auth.session || !campaign) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaign.id}/${action}`,
        {
          body: { reason },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      await load();
      setNotice(action === "archive" ? "活动已归档" : "活动已恢复到运营列表");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function exportWorkItems() {
    if (!auth.session || !campaign) return;
    const query = new URLSearchParams();
    if (workItemFilter !== "ALL") query.set("status", workItemFilter);
    if (workItemEmployee.trim()) query.set("employee", workItemEmployee.trim());
    setBusy(true);
    setError(null);
    try {
      const response = await trackedFetch(
        `${API_BASE_URL}/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaign.id}/work-items.csv?${query}`,
        { headers: { authorization: `Bearer ${auth.session.adminToken}` } },
      );
      if (!response.ok) throw new Error((await response.text()) || "导出失败");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `campaign-${campaign.id}-work-items.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  function acceptSelectedReview() {
    if (!auth.session || !campaign || !selected) return;
    const review = contentReviewSummary(selected.riskAssessment);
    setConfirmation({
      confirmLabel: "确认人工检查通过",
      minReasonLength: 4,
      impacts: [
        `${selected.audienceSnapshot.employeeName} 的当前内容将被保留`,
        "仅记录人工检查结果，不会重新生成",
        "这份内容确认可用后，活动仍需完成整体审核与开放安排",
        "审核说明会进入活动记录，后续可追溯",
      ],
      reasonLabel: "人工检查说明（至少 4 个字）",
      run: async (reason) =>
        runGovernanceAction(
          `contents/${selected.id}/accept-review`,
          { reason },
          "这份图文已人工确认可用，请继续完成活动审核与开放安排",
        ),
      summary: review.unavailable
        ? "自动审核未返回结论。请先检查文案事实、图片人物及表达是否符合活动要求，再记录你的检查结果。"
        : "请逐项核对内容提示，确认文案事实、图片人物及表达符合活动要求，再记录检查结果。",
      title: "已人工检查，确认这份图文可用？",
      tone: "warning",
    });
  }

  function regenerateSelectedContent(target: "COPY" | "IMAGE" | "BOTH") {
    if (!auth.session || !campaign || !selected) return;
    const label = target === "COPY" ? "文案" : target === "IMAGE" ? "图片" : "图文";
    const medical = Boolean(campaign.selectionSnapshot);
    setConfirmation({
      confirmLabel: `确认重生成${label}`,
      minReasonLength: medical ? 2 : 4,
      impacts: [
        `仅重生成 ${selected.audienceSnapshot.employeeName} 的${label}${target === "COPY" ? "，保留现有图片" : target === "IMAGE" ? "，保留现有文案" : ""}`,
        "保留原稿历史，为该员工重新生成当前选择的内容",
        "旧版本完整保留，新版本仍需审核后才能向员工开放",
      ],
      reasonLabel: medical ? "重新生成的原因" : `${label}修改要求（至少 4 个字）`,
      ...(medical
        ? {
            reasonOptions: [
              { value: "QUESTION_UNCLEAR", label: "问题表达不够清楚" },
              { value: "TOO_MUCH_INFORMATION", label: "信息过多，重点不突出" },
              { value: "IMAGE_TEXT_MISMATCH", label: "图片与正文不符" },
            ],
          }
        : {}),
      run: async (feedback) =>
        runGovernanceAction(
          `contents/${selected.id}/regenerate`,
          { ...(medical ? { reasonCode: feedback } : { feedback }), target },
          `该员工${label}已进入重生成队列`,
        ),
      summary: medical
        ? "选择原因后制作新版本。事实或授权素材需要变更时，请复制活动并重新选择，以便重新冻结和核验。"
        : "填写具体修改要求，系统将据此生成新版本。",
      title: `重生成${selected.audienceSnapshot.employeeName}的${label}`,
      tone: "warning",
    });
  }

  function rescheduleCampaign() {
    if (!validateFutureSchedule()) return;
    setConfirmation({
      confirmLabel: "确认修改开放时间",
      defaultReason: "调整员工内容开放安排",
      impacts: [
        `新的开放时间：${formatDate(new Date(visibleAt).toISOString())}`,
        "所有员工的任务开放时间和 24 小时提交截止时间会一起更新",
      ],
      reasonLabel: "改期说明",
      run: async (reason) =>
        runGovernanceAction(
          "reschedule",
          { reason, visibleAt: new Date(visibleAt).toISOString() },
          "员工开放时间和提交截止时间已同步更新",
        ),
      summary: "改期会同时影响本期所有员工，请确认内部通知和运营安排已经同步。",
      title: "修改本期员工开放时间？",
      tone: "warning",
    });
  }

  function reopenReview() {
    setConfirmation({
      confirmLabel: "撤销通过并重新审核",
      defaultReason: "需要进行第二轮内容审核",
      impacts: ["活动将回到等待审核状态", "员工在重新审核通过前不会看到本期素材"],
      reasonLabel: "撤销原因",
      run: async (reason) =>
        runGovernanceAction("reopen-review", { reason }, "审核通过已撤销，活动重新进入审核阶段"),
      summary: "适用于发现新风险、传播口径变化或需要再次抽检的情况。",
      title: "撤销本次审核通过？",
      tone: "warning",
    });
  }

  async function cancelCampaign() {
    if (!campaign || !auth.session || busy) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await apiRequest<components["schemas"]["CampaignCancellationPreviewDto"]>(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaign.id}/cancel-preview`,
        { token: auth.session.adminToken },
      );
      setConfirmation({
        confirmLabel: "确认取消",
        compact: true,
        defaultReason: "本期活动停止执行",
        impacts: [
          `停止 ${preview.cancelledDistributionTasks} 个员工任务、${preview.cancelledGenerationRuns} 个生成任务和 ${preview.cancelledWorkItems} 个生成工作项`,
        ],
        reasonLabel: "取消原因",
        run: async (reason) =>
          runGovernanceAction("cancel", { reason }, "活动已取消，尚未完成的生成与员工任务已停止"),
        summary: "本期任务将停止，素材不再向员工开放。取消后不可恢复。",
        title: "取消本期活动？",
        tone: "danger",
      });
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPendingAction(reason: string) {
    if (!confirmation) return;
    await confirmation.run(reason);
    setConfirmation(null);
  }

  async function runGovernanceAction(
    action: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    if (!auth.session || !campaign) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaign.id}/${action}`,
        {
          body,
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      await Promise.all([load(), loadWorkItems()]);
      setNotice(successMessage);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  if (auth.session === undefined) return <CampaignLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }
  if (!campaign) {
    return (
      <SaasShell
        active="campaigns"
        description="正在从本机数据库读取活动"
        mode="console"
        navigationPermissions={consoleNavigationPermissions(auth.session)}
        roleLabel={selectedAdminRoleName(auth.session)}
        scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
        scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
        title="活动详情"
      >
        {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : <p>加载中…</p>}
      </SaasShell>
    );
  }
  const run = campaign.generationRuns[0];
  const reviewContents = campaign.employeeContents.filter((content) =>
    matchesReviewFilter(content, reviewFilter),
  );
  const selected =
    reviewContents.find(({ id }) => id === selectedContentId) ?? reviewContents[0] ?? null;
  const selectedReviewIndex = selected
    ? reviewContents.findIndex(({ id }) => id === selected.id)
    : -1;
  const selectedReview = selected ? contentReviewSummary(selected.riskAssessment) : null;
  const canReview = consoleNavigationPermissions(auth.session).includes("campaign.approve");
  const distributionTasksByMembership = new Map(
    campaign.distributionTasks.map((task) => [task.membershipId, task]),
  );
  const formallyOpened =
    ["ACTIVE", "COMPLETED", "EXPIRED"].includes(campaign.status) ||
    (campaign.status === "APPROVED" && new Date(campaign.visibleAt).getTime() <= clockNow);
  const displayStatus =
    campaign.status === "APPROVED" && formallyOpened
      ? new Date(campaign.expiresAt).getTime() <= clockNow
        ? "EXPIRED"
        : "ACTIVE"
      : campaign.status;
  const scheduleIsFuture =
    Boolean(visibleAt) &&
    new Date(visibleAt).getTime() > clockNow &&
    new Date(visibleAt).getTime() >=
      new Date(campaign.createdAt).getTime() + CAMPAIGN_PREPARATION_MS;
  const earliestSchedule = clockNow
    ? localDateTime(
        new Date(earliestCampaignSchedule(new Date(campaign.createdAt).getTime(), clockNow)),
      )
    : undefined;
  const publicationRows = campaign.audienceSnapshots.map((snapshot) => ({
    snapshot,
    task: distributionTasksByMembership.get(snapshot.membershipId) ?? null,
  }));
  const publicationCompletedCount = publicationRows.filter(({ task }) =>
    task ? isPublicationComplete(task.status) : false,
  ).length;

  function moveReview(offset: number) {
    if (reviewContents.length === 0) return;
    const nextIndex =
      (Math.max(selectedReviewIndex, 0) + offset + reviewContents.length) % reviewContents.length;
    setSelectedContentId(reviewContents[nextIndex]?.id ?? null);
  }

  return (
    <SaasShell
      active="campaigns"
      description="先判断当前状态和下一步，再按需查看内容、员工执行与完整记录。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title={campaign.title}
      toolbar={
        <div className="toolbar">
          <Link className="ghostButton backButton" href="/console/campaigns">
            返回活动列表
          </Link>
          {campaign.archivedAt ? (
            <button
              className="ghostButton"
              disabled={busy}
              onClick={() => void changeArchive("restore")}
              type="button"
            >
              <ActionIcon name="restore" />
              恢复归档
            </button>
          ) : new Set(["CANCELLED", "COMPLETED", "EXPIRED"]).has(campaign.status) ? (
            <button
              className="ghostButton"
              disabled={busy}
              onClick={() => void changeArchive("archive")}
              type="button"
            >
              <ActionIcon name="archive" />
              归档活动
            </button>
          ) : null}
          <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
            刷新
          </button>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <div className="campaignMeta">
        <StatusBadge tone={campaignStatusTone(displayStatus)}>
          {campaignStatusLabel(displayStatus)}
        </StatusBadge>
        <span>员工开放时间 {formatDate(campaign.visibleAt)}</span>
        <span>提交截止时间 {formatDate(campaign.expiresAt)}</span>
        {campaign.lastRescheduledAt ? (
          <span>最近改期 {formatDate(campaign.lastRescheduledAt)}</span>
        ) : null}
        {campaign.cancelledAt ? <span>取消 {formatDate(campaign.cancelledAt)}</span> : null}
        {campaign.archivedAt ? <span>已归档 {formatDate(campaign.archivedAt)}</span> : null}
      </div>

      <nav aria-label="活动详情" className="campaignDetailTabs">
        {(
          [
            ["OVERVIEW", "概览与下一步"],
            ["REVIEW", "内容审核"],
            ["EXECUTION", "员工执行"],
            ["RECORDS", "记录与诊断"],
            ["EFFECTS", "GEO 与成交"],
          ] as const
        ).map(([key, label]) => (
          <button
            aria-selected={activeTab === key}
            className={activeTab === key ? "active" : ""}
            key={key}
            onClick={() => setActiveTab(key)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>

      {activeTab === "EFFECTS" ? (
        <CampaignEffects
          base={`/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/campaigns/${campaignId}`}
          token={auth.session.adminToken}
          canManage={consoleNavigationPermissions(auth.session).includes("campaign.manage")}
        />
      ) : null}

      {activeTab === "OVERVIEW" ? (
        <section className="campaignNextStepBanner">
          <div>
            <span>当前状态</span>
            <h2>{campaignNextAction(displayStatus, run?.failedCount ?? 0)}</h2>
            <p>{campaignNextStepDescription(campaign.status)}</p>
          </div>
          {campaign.status === "REVIEW_PENDING" ? (
            <button className="primaryButton" onClick={() => setActiveTab("REVIEW")} type="button">
              先审核员工内容
            </button>
          ) : campaign.status === "ACTIVE" ? (
            <button
              className="primaryButton"
              onClick={() => setActiveTab("EXECUTION")}
              type="button"
            >
              查看员工执行
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="metricGrid four" hidden={activeTab !== "OVERVIEW"}>
        <article className="metricCard">
          <span>目标成员</span>
          <strong>{campaign.audienceCount}</strong>
          <small>成员名单以创建时为准</small>
        </article>
        <article className="metricCard accent">
          <span>生成完成</span>
          <strong>
            {campaign.generatedCount} / {campaign.audienceCount}
          </strong>
          <small>
            {campaign.selectionSnapshot
              ? `每篇最多 ${campaign.imageCount} 张图片，按素材与内容制作`
              : `每人 ${campaign.imageCount} 张独立图片`}
          </small>
        </article>
        <article className="metricCard">
          <span>未成功生成内容的员工</span>
          <strong>{run?.failedCount ?? 0}</strong>
          <small>只对最终失败员工局部重试</small>
        </article>
        <article className="metricCard">
          <span>发生过重试</span>
          <strong>{run?.workItems.filter((item) => item.attemptCount > 1).length ?? 0}</strong>
          <small>成功内容不会重复生成</small>
        </article>
      </section>

      <section className="panel campaignTimelinePanel" hidden={activeTab !== "RECORDS"}>
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">活动记录</span>
            <h2>从创建到结束的完整记录</h2>
            <p>记录重要决定、内容生成、审核、开放和结束时间，方便团队追溯。</p>
          </div>
          <StatusBadge tone="neutral">{timeline?.events.length ?? 0} 个节点</StatusBadge>
        </div>
        <div className="campaignTimelineList">
          {timeline?.events.map((event) => (
            <article key={event.id}>
              <span data-status={event.status} />
              <div>
                <small>{formatDate(event.occurredAt)}</small>
                <strong>{event.title}</strong>
                <p>{event.description}</p>
              </div>
              <StatusBadge tone={timelineTone(event.status)}>
                {timelineStatusLabel(event.status)}
              </StatusBadge>
            </article>
          ))}
        </div>
      </section>

      <section className="panel generationPanel" hidden={activeTab !== "RECORDS"}>
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">内容生成记录</span>
            <h2>后台自动母版与员工差异化</h2>
            <p>{campaign.prompt}</p>
          </div>
          <StatusBadge tone={run?.status === "SUCCEEDED" ? "success" : "warning"}>
            {run ? businessWorkItemStatusLabel(run.status) : "尚未开始"}
          </StatusBadge>
        </div>
        <div className="modelSnapshot">
          <span>
            模型路由 <b>平台统一管理</b>
          </span>
          <span>
            独立图片 <b>每人 {campaign.imageCount} 张</b>
          </span>
          <span>
            素材召回 <b>{campaign.blueprint?.sourceContext.materialCount ?? 0} 份</b>
          </span>
        </div>
        {run ? (
          <p>
            {run.completedCount}/{run.requestedCount} 名员工已生成 · {run.failedCount} 名未成功生成
          </p>
        ) : null}
      </section>

      <section className="panel retrievalSnapshotPanel" hidden={activeTab !== "RECORDS"}>
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">品牌资料引用</span>
            <h2>本次实际引用的品牌资料</h2>
            <p>资料后续更新不会改写本期活动，确保审核时看到的依据与生成时一致。</p>
          </div>
          <StatusBadge tone={campaign.retrievalEvidence.length > 0 ? "success" : "warning"}>
            {campaign.retrievalEvidence.length} 条引用
          </StatusBadge>
        </div>
        <div className="retrievalSnapshotList">
          {campaign.retrievalEvidence.map((evidence) => (
            <article key={evidence.id}>
              <div>
                <span>{String(evidence.rank).padStart(2, "0")}</span>
                <div>
                  <strong>
                    {evidence.materialTitle} · v{evidence.materialVersion}
                  </strong>
                  <small>{evidence.hitReasons.join(" · ")}</small>
                </div>
                <b>{Math.round(evidence.score * 100)}%</b>
              </div>
              <p>{evidence.frozenSnippet}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel workItemPanel" hidden={activeTab !== "EXECUTION"}>
        {campaign.distributionTasks.some((task) =>
          Boolean((task as { factsReturnedAt?: string }).factsReturnedAt),
        ) ? (
          <div className="inlineWarning campaignFactsReturnNotice">
            <strong>员工已退回企业复核</strong>
            <p>
              当前稿暂停复制与保存，请核对事实、素材及发布安排后重新审核。事实或素材变更需要重新选择并冻结计划。
            </p>
            {campaign.distributionTasks
              .filter((task) => Boolean((task as { factsReturnedAt?: string }).factsReturnedAt))
              .map((task) => (
                <p key={task.id}>
                  {campaign.audienceSnapshots.find(
                    (member) => member.membershipId === task.membershipId,
                  )?.employeeName ?? "员工"}
                  ：
                  {(
                    {
                      FACTS_MISMATCH: "事实与本人情况不符",
                      MATERIAL_PRIVACY: "图片授权或隐私需复核",
                      PUBLISHING_CHANGED: "实际发布条件发生变化",
                    } as Record<string, string>
                  )[(task as { factsReturnReason?: string }).factsReturnReason ?? ""] ??
                    "需企业复核"}
                </p>
              ))}
          </div>
        ) : null}
        <div className="panelHeader workItemHeader">
          <div>
            <span className="sectionKicker">员工内容准备</span>
            <h2>每名员工的内容准备情况</h2>
            <p>查看谁已成功生成、谁需要重试；平台技术诊断不会出现在企业后台。</p>
          </div>
          <fieldset className="filterPills">
            <legend>生成任务状态筛选</legend>
            {workItemFilters.map((value) => (
              <button
                aria-pressed={workItemFilter === value}
                className={workItemFilter === value ? "active" : ""}
                key={value}
                onClick={() => setWorkItemFilter(value)}
                type="button"
              >
                {businessWorkItemStatusLabel(value)}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="workItemToolbar">
          <label className="workItemSearch">
            <span>员工搜索</span>
            <input
              onChange={(event) => setWorkItemEmployee(event.target.value)}
              placeholder="姓名或手机号"
              type="search"
              value={workItemEmployee}
            />
          </label>
          <button
            className="ghostButton"
            disabled={busy}
            onClick={() => void exportWorkItems()}
            type="button"
          >
            导出当前筛选 CSV
          </button>
        </div>
        <div className="workItemSummary">
          {(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const).map((status) => (
            <span key={status}>
              {businessWorkItemStatusLabel(status)}
              <b>{workItems.filter((item) => item.status === status).length}</b>
            </span>
          ))}
        </div>
        <div className="workItemTableFrame">
          <table className="workItemTable">
            <caption>员工级生成任务</caption>
            <thead>
              <tr>
                <th scope="col">员工</th>
                <th scope="col">状态</th>
                <th scope="col">尝试</th>
                <th scope="col">失败分类</th>
                <th scope="col">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {workItems.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div>
                      <strong>{item.employeeName}</strong>
                      <small>
                        {item.departmentName ?? "未分部门"} · {maskPhone(item.employeePhone)}
                      </small>
                    </div>
                  </td>
                  <td>
                    <StatusBadge tone={workItemStatusTone(item.status)}>
                      {businessWorkItemStatusLabel(item.status)}
                    </StatusBadge>
                  </td>
                  <td>
                    <div>
                      <strong>{item.attemptCount}</strong>
                      <small>{item.attemptCount > 1 ? "已自动重试" : "首次执行"}</small>
                    </div>
                  </td>
                  <td>
                    <div>
                      <strong>{generationErrorLabel(item.errorCategory)}</strong>
                      <small>{item.errorCategory ? "已隐藏底层诊断" : "—"}</small>
                    </div>
                  </td>
                  <td>
                    <div>
                      <strong>
                        {formatCompactDate(item.finishedAt ?? item.startedAt ?? item.createdAt)}
                      </strong>
                      <small>
                        {item.finishedAt ? "已结束" : item.startedAt ? "执行中" : "等待执行"}
                      </small>
                    </div>
                  </td>
                </tr>
              ))}
              {workItems.length === 0 ? (
                <tr>
                  <td className="workItemEmpty" colSpan={5}>
                    当前筛选下没有员工任务
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className={`contentGrid wideLeft campaignDecisionGrid ${activeTab === "REVIEW" ? "singleColumn" : ""}`}
        hidden={activeTab !== "OVERVIEW" && activeTab !== "REVIEW"}
      >
        <article className="panel publicationWallPanel" hidden={activeTab !== "OVERVIEW"}>
          <div className="panelHeader publicationWallHeader">
            <div>
              <span className="sectionKicker">名单执行概览</span>
              <h2>本期发布墙</h2>
              <p>按员工展示素材准备、领取、发布与链接核验进度，及时跟进异常和逾期任务。</p>
            </div>
            <div className="publicationWallProgress">
              <strong>{publicationCompletedCount}</strong>
              <span>/ {publicationRows.length} 已完成</span>
            </div>
          </div>
          <ul className="publicationWall">
            {publicationRows.map(({ snapshot, task }) => {
              const state = publicationWallStatus(campaign, snapshot.membershipId, task);
              const destination = publicationWallDestination(campaign, snapshot.membershipId, task);
              const card = (
                <>
                  <span className="publicationStatusIcon">
                    <ActionIcon name={state.icon} />
                  </span>
                  <span>
                    <strong>{snapshot.employeeName}</strong>
                    <small>{snapshot.departmentName ?? "未分部门"}</small>
                    <span className="publicationStatusLabel">{state.label}</span>
                  </span>
                </>
              );
              return (
                <li key={snapshot.id}>
                  {destination.tab === "PUBLICATION" ? (
                    <Link
                      className={`publicationPerson ${state.tone}`}
                      href={destination.href}
                      aria-label={`查看${snapshot.employeeName}的发布核实记录`}
                    >
                      {card}
                    </Link>
                  ) : (
                    <button
                      className={`publicationPerson ${state.tone}`}
                      type="button"
                      aria-label={`查看${snapshot.employeeName}的${destination.tab === "REVIEW" ? "专属素材" : destination.tab === "EXECUTION" ? "生成任务" : "活动记录"}`}
                      onClick={() => {
                        if (destination.tab === "REVIEW") {
                          setReviewFilter("ALL");
                          setSelectedContentId(destination.contentId);
                        } else if (destination.tab === "EXECUTION") {
                          setWorkItemFilter("ALL");
                          setWorkItemEmployee(snapshot.employeePhone || snapshot.employeeName);
                        }
                        setActiveTab(destination.tab);
                      }}
                    >
                      {card}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {publicationRows.length === 0 ? (
            <div className="emptyState compact">
              <span>本期暂无员工名单</span>
              <p>创建活动时冻结的目标员工会显示在这里。</p>
            </div>
          ) : null}
        </article>
        <article className="panel" hidden={activeTab !== "REVIEW"}>
          <div className="panelHeader reviewPanelHeader">
            <div>
              <span className="sectionKicker">员工独立内容</span>
              <h2>员工独立内容抽检</h2>
              <p>
                当前浏览 {selectedReviewIndex >= 0 ? selectedReviewIndex + 1 : 0} /{" "}
                {reviewContents.length}
                ，全部生成结果 {campaign.employeeContents.length} 份
              </p>
            </div>
            <div className="reviewNavigation">
              <select
                aria-label="选择员工内容"
                onChange={(event) => setSelectedContentId(event.target.value)}
                value={selected?.id ?? ""}
              >
                {reviewContents.map((content) => (
                  <option key={content.id} value={content.id}>
                    {content.audienceSnapshot.employeeName}
                  </option>
                ))}
              </select>
              <div>
                <button
                  className="ghostButton"
                  disabled={reviewContents.length < 2}
                  onClick={() => moveReview(-1)}
                  type="button"
                >
                  上一份
                </button>
                <button
                  className="ghostButton"
                  disabled={reviewContents.length < 2}
                  onClick={() => moveReview(1)}
                  type="button"
                >
                  下一份
                </button>
              </div>
            </div>
          </div>
          <fieldset className="filterPills reviewFilters">
            <legend>内容风险筛选</legend>
            {reviewFilters.map((value) => (
              <button
                aria-pressed={reviewFilter === value}
                className={reviewFilter === value ? "active" : ""}
                key={value}
                onClick={() => {
                  setReviewFilter(value);
                  setSelectedContentId(null);
                }}
                type="button"
              >
                {reviewFilterLabel(value)}
              </button>
            ))}
          </fieldset>
          {selected ? (
            <>
              {campaign.status === "REVIEW_PENDING" && canReview ? (
                <section className="reviewRegeneration" aria-label="重生成当前员工内容">
                  <div>
                    <strong>调整这份内容</strong>
                    <small>旧版本保留，完成后重新审核</small>
                  </div>
                  <div className="reviewRegenerationButtons">
                    {(["COPY", "IMAGE", "BOTH"] as const).map((target) => (
                      <button
                        className="ghostButton"
                        disabled={busy}
                        key={target}
                        type="button"
                        onClick={() => regenerateSelectedContent(target)}
                      >
                        <ActionIcon name="refresh" />
                        重生成{target === "COPY" ? "文案" : target === "IMAGE" ? "图片" : "图文"}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              {campaign.status === "GENERATING" &&
              campaign.generationRuns.some((run) =>
                run.workItems.some(
                  (item) =>
                    item.membershipId === selected.membershipId &&
                    (item.status === "QUEUED" || item.status === "RUNNING"),
                ),
              ) ? (
                <p className="reviewRegenerationPending" role="status">
                  正在生成新版本，以下为上次内容；完成后请重新审核。
                </p>
              ) : null}
              <div className="reviewPreview">
                <div className="reviewImageGrid">
                  {selected.images.map((image, index) => (
                    <div className="reviewImage" key={image.id}>
                      <Image
                        alt={`${selected.audienceSnapshot.employeeName} 的第 ${index + 1} 张独立生成图`}
                        height={image.height}
                        src={storageObjectUrl(image.imageUrl)}
                        unoptimized
                        width={image.width}
                      />
                      <small>图片 {index + 1} · 本员工专属</small>
                    </div>
                  ))}
                </div>
                <div className="reviewCopy">
                  <StatusBadge tone={selectedReview?.tone ?? "warning"}>
                    {selectedReview?.label}
                  </StatusBadge>
                  <h3>{selected.title}</h3>
                  <p>{selected.body}</p>
                  <div className="hashtagRow">
                    {selected.hashtags.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                  {(selected.riskAssessment.replacedBlocks?.length ?? 0) > 0 ||
                  (selectedReview?.warningCount ?? 0) > 0 ? (
                    <small>
                      敏感词调整 {selected.riskAssessment.replacedBlocks?.length ?? 0} 处
                      {selectedReview?.warningCount
                        ? selectedReview.manuallyConfirmed
                          ? ` · 已人工核对 ${selectedReview.warningCount} 项提示`
                          : ` · ${selectedReview.warningCount} 项内容需核对`
                        : ""}
                    </small>
                  ) : null}
                  {selectedReview?.unavailable ? (
                    <section className="reviewCheckNotice" aria-label="自动审核说明">
                      <strong>
                        {selectedReview.manuallyConfirmed
                          ? "已由人工检查并确认"
                          : "自动审核暂未完成"}
                      </strong>
                      <p>
                        {selectedReview.manuallyConfirmed
                          ? "自动审核未返回结论，这份图文已完成人工确认。请继续完成活动审核与开放安排。"
                          : "审核服务暂时未能返回结果，当前还没有自动审核结论。图文已生成，暂时保留待审核。"}
                      </p>
                      {!selectedReview.manuallyConfirmed ? (
                        <p>
                          {selectedReview.canConfirm
                            ? canReview && campaign.status === "REVIEW_PENDING"
                              ? "请核对图片人物、文案事实及表达是否符合本次活动要求。确认后选择“人工确认可用”；无法判断时，先保留待审核，请负责审核的同事继续检查。"
                              : "请由负责审核的同事核对图片人物、文案事实及表达，并记录人工检查结果。"
                            : "同时存在下方列出的内容问题，请先处理；当前不能人工确认通过。"}
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                  {(selectedReview?.messages.length ?? 0) > 0 ? (
                    <div className="reviewRiskList">
                      {selectedReview?.messages.map((message) => (
                        <span key={message}>{message}</span>
                      ))}
                    </div>
                  ) : null}
                  {selected.status === "REVIEW_BLOCKED" &&
                  campaign.status === "REVIEW_PENDING" &&
                  canReview ? (
                    <div className="reviewDecisionActions">
                      {selectedReview?.canConfirm ? (
                        <button
                          className="primaryButton"
                          disabled={busy}
                          onClick={() => void acceptSelectedReview()}
                          type="button"
                        >
                          <ActionIcon name="check" />
                          人工确认可用
                        </button>
                      ) : null}
                      <button
                        className="ghostButton"
                        disabled={busy}
                        type="button"
                        onClick={() => {
                          notify({
                            tone: "success",
                            content:
                              "这份图文仍保留待审核，稍后可返回继续检查；确认前不会向员工开放。",
                          });
                          setActiveTab("OVERVIEW");
                        }}
                      >
                        暂时保留待审核
                      </button>
                    </div>
                  ) : null}
                  {selected.revision > 1 ? (
                    <small>
                      当前修订 v{selected.revision} · 已保留 {selected.revisions.length} 份旧版本
                    </small>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="emptyState compact">
              <span>当前风险筛选下没有内容</span>
              <p>切换筛选项即可继续浏览其他生成结果。</p>
            </div>
          )}
        </article>

        <aside className="panel approvalCard" hidden={activeTab !== "OVERVIEW"} id="approval">
          <span className="sectionKicker">下一步操作</span>
          <h2>
            {campaign.status === "GENERATING"
              ? "正在生成员工独立内容"
              : campaign.status === "REVIEW_PENDING"
                ? "审核通过并安排开放"
                : campaign.status === "GENERATION_FAILED"
                  ? "生成存在失败项"
                  : campaign.status === "CANCELLED"
                    ? "活动已取消"
                    : formallyOpened
                      ? "活动已开放或结束"
                      : "活动已批准"}
          </h2>
          <div className="approvalSchedule">
            <span>{campaign.approvedAt ? "员工素材开放时间" : "预定开放时间（待审核确认）"}</span>
            <strong>{formatDate(campaign.visibleAt)}</strong>
            <small>提交截止：{formatDate(campaign.expiresAt)}</small>
          </div>
          {campaign.status === "GENERATING" ? (
            <>
              <div className="approvalDone">
                <b>…</b>
                <span>系统正在为每位员工生成内容</span>
                <small>页面会自动刷新；可安全离开后再返回。</small>
              </div>
              <button
                className="primaryButton block"
                disabled={busy}
                onClick={() => void cancelCampaign()}
                type="button"
              >
                取消剩余生成任务
              </button>
            </>
          ) : campaign.status === "GENERATION_FAILED" ? (
            <>
              <p>失败项处理完成并通过审核后，才能开放给员工。</p>
              <p>重试仅处理生成失败的员工，已成功生成的内容会保留。</p>
              <button
                className="primaryButton block"
                disabled={busy}
                onClick={() => void retryFailed()}
                type="button"
              >
                {busy ? "正在创建重试任务…" : "仅重试失败员工"}
              </button>
              <button
                className="primaryButton block"
                disabled={busy}
                onClick={() => void cancelCampaign()}
                type="button"
              >
                取消整个活动
              </button>
              <p className="approvalCancelHint">取消后本期不再开放给员工，尚未完成的任务会停止。</p>
            </>
          ) : campaign.status === "REVIEW_PENDING" ? (
            <>
              <p>全部内容审核通过即可开放。保留未来时间可排期开放；已过期的排期会立即开放。</p>
              <label className="field">
                <span>员工可查看素材的时间</span>
                <input
                  onChange={(event) => setVisibleAt(event.target.value)}
                  type="datetime-local"
                  ref={scheduleInput}
                  value={visibleAt}
                />
                {!scheduleIsFuture ? <small>排期已到，审核确认后立即开放。</small> : null}
              </label>
              <div className="approvalCardActions">
                <button
                  className="primaryButton approvalConfirmButton"
                  disabled={busy}
                  onClick={requestApprove}
                  type="button"
                >
                  <ActionIcon name="check" />
                  {busy ? "正在处理…" : "确认排期发布"}
                </button>
                <button
                  className="dangerButton"
                  disabled={busy}
                  onClick={() => void cancelCampaign()}
                  type="button"
                >
                  <ActionIcon name="x" />
                  取消活动
                </button>
              </div>
            </>
          ) : campaign.status === "APPROVED" && !formallyOpened ? (
            <>
              <p>活动尚未开放，可改期、重新审核或取消；到达开放时间后这些操作自动关闭。</p>
              <label className="field">
                <span>新的员工开放时间</span>
                <input
                  onChange={(event) => setVisibleAt(event.target.value)}
                  type="datetime-local"
                  ref={scheduleInput}
                  value={visibleAt}
                  min={earliestSchedule}
                  aria-invalid={!scheduleIsFuture}
                />
                {!scheduleIsFuture ? (
                  <small>最早可选：{earliestSchedule?.replace("T", " ")}（审核通过即可开放）</small>
                ) : null}
              </label>
              <button
                className="primaryButton block"
                disabled={busy || !scheduleIsFuture}
                onClick={() => void rescheduleCampaign()}
                type="button"
              >
                保存改期
              </button>
              <button
                className="ghostButton block"
                disabled={busy}
                onClick={() => void reopenReview()}
                type="button"
              >
                撤销批准并重新审核
              </button>
              <button
                className="primaryButton block"
                disabled={busy}
                onClick={() => void cancelCampaign()}
                type="button"
              >
                取消本期活动
              </button>
            </>
          ) : campaign.status === "CANCELLED" ? (
            <div className="approvalDone">
              <b>×</b>
              <span>{campaign.cancellationReason ?? "活动已取消"}</span>
            </div>
          ) : (
            <div className="approvalDone">
              <b>✓</b>
              <span>
                审核通过时间 {campaign.approvedAt ? formatDate(campaign.approvedAt) : "—"}
              </span>
              <small>
                {formallyOpened
                  ? "正式开放后，不可取消、改期或修改素材。"
                  : "员工只能在统一开放时间后看到自己的文案和图片。"}
              </small>
            </div>
          )}
        </aside>
      </section>
      <ActionConfirmDialog
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={(reason) => void confirmPendingAction(reason)}
        state={confirmation}
      />
    </SaasShell>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function isPublicationComplete(status: string): boolean {
  return status === "COMPLETED" || status === "LATE_CORRECTED";
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function formatCompactDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}

function workItemStatusTone(status: string): "danger" | "neutral" | "success" | "warning" {
  if (status === "SUCCEEDED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "CANCELLED") return "neutral";
  if (status === "RUNNING") return "warning";
  return "neutral";
}

function timelineTone(status: string): "danger" | "neutral" | "success" | "warning" {
  if (new Set(["COMPLETED", "SUCCEEDED"]).has(status)) return "success";
  if (new Set(["FAILED", "GENERATION_FAILED"]).has(status)) return "danger";
  if (new Set(["RUNNING", "SCHEDULED"]).has(status)) return "warning";
  return "neutral";
}

function generationErrorLabel(category: string | null): string {
  return (
    {
      CONTENT_COMPLIANCE: "内容合规阻断",
      INTERNAL_ERROR: "系统执行异常",
      PLATFORM_CONFIGURATION: "平台配置异常",
      TEMPORARY_SERVICE: "临时服务异常",
    }[category ?? ""] ?? "无"
  );
}

function reviewFilterLabel(filter: string): string {
  return (
    {
      ALL: "全部内容",
      PASSED: "已确认可用",
      REPLACED: "发生替换",
      RISK: "需要处理",
      WARNING: "内容提示",
    }[filter] ?? filter
  );
}

function matchesReviewFilter(
  content: CampaignDetail["employeeContents"][number],
  filter: (typeof reviewFilters)[number],
): boolean {
  if (filter === "RISK") return !content.riskAssessment.passed;
  if (filter === "WARNING") return contentReviewSummary(content.riskAssessment).warningCount > 0;
  if (filter === "REPLACED") return (content.riskAssessment.replacedBlocks?.length ?? 0) > 0;
  if (filter === "PASSED") return content.riskAssessment.passed;
  return true;
}

function campaignNextStepDescription(status: string): string {
  return (
    {
      ACTIVE: "员工已经可以查看各自素材，重点关注谁还没有提交发布链接。",
      APPROVED: "内容已审核通过，员工会在设定时间统一看到各自素材。",
      CANCELLED: "本期不再推进，可查看取消原因和员工影响。",
      COMPLETED: "本期员工任务已全部结束，可以进入结果复盘。",
      EXPIRED: "提交期限已结束，查看未提交发布链接的员工和本期效果。",
      GENERATING: "系统正在逐名员工生成独立文案和图片，完成后会进入内容审核。",
      GENERATION_FAILED: "成功内容已经保留，只需要处理未成功生成的员工。",
      REVIEW_PENDING: "先抽检独立图文和风险提示，再决定是否按计划开放给员工。",
    }[status] ?? "查看活动记录，确认当前业务状态。"
  );
}

function CampaignLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <h1 suppressHydrationWarning>正在读取活动…</h1>
      </section>
    </main>
  );
}
