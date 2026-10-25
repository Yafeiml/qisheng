"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConsoleScopeSwitcher } from "../components/console-scope-switcher";
import { FeedbackMessage } from "../components/feedback-toast";
import { MvpSetup } from "../components/mvp-setup";
import { PlatformName } from "../components/platform-branding";
import { SaasShell, StatusBadge } from "../components/saas-shell";
import {
  adminWorkRole,
  adminWorkspaceCopy,
  campaignStatusLabel,
  campaignStatusTone,
} from "../lib/business-language";
import {
  apiRequest,
  type CursorPage,
  consoleNavigationPermissions,
  selectedAdminRoleName,
} from "../lib/mvp-client";
import { messageOf, useMvpSession } from "../lib/use-mvp-session";

type Campaign = components["schemas"]["CampaignListItemDto"];
type Workspace = components["schemas"]["EnterpriseWorkspaceSummaryDto"];

export default function ConsoleOverviewPage() {
  const auth = useMvpSession();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [workspaceSnapshot, setWorkspace] = useState<Workspace | null>(null);
  const workspace =
    workspaceSnapshot?.enterprise.id === auth.session?.enterpriseId ? workspaceSnapshot : null;
  const loadVersion = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!auth.session) return;
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const [campaignRows, workspaceData] = await Promise.all([
        apiRequest<CursorPage<Campaign>>(`${base}/campaigns`, {
          token: auth.session.adminToken,
        }),
        apiRequest<Workspace>(`${base}/workspace`, {
          token: auth.session.adminToken,
        }),
      ]);
      if (version !== loadVersion.current) return;
      setCampaigns([...campaignRows.items]);
      setWorkspace(workspaceData);
    } catch (reason) {
      if (version === loadVersion.current) setError(messageOf(reason));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [auth.session]);

  useEffect(() => {
    void load();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);

  if (auth.session === undefined) return <LoadingScreen />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }
  const readinessBlockers =
    workspace?.steps.filter(({ status }) => status === "BLOCKING").length ?? 0;
  const latestCampaigns = campaigns.slice(0, 3);
  const pendingCoreActions = workspace
    ? workspace.campaigns.generating +
      workspace.campaigns.generationFailed +
      workspace.campaigns.reviewPending +
      workspace.campaigns.approved
    : 0;
  const roleName = selectedAdminRoleName(auth.session);
  const workRole = adminWorkRole(roleName);
  const workspaceCopy = adminWorkspaceCopy(roleName);
  const canCreateCampaign = ["ADMIN", "OPERATOR"].includes(workRole);
  const primaryWork = rolePrimaryWork(workRole, workspace);
  return (
    <SaasShell
      active="overview"
      description={workspaceCopy.description}
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={roleName}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title={workspaceCopy.title}
      toolbar={
        <div className="toolbar">
          <button
            className="ghostButton refreshButton"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            刷新
          </button>
          {canCreateCampaign ? (
            <Link className="primaryButton createButton" href="/console/campaigns/new">
              创建活动
            </Link>
          ) : null}
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      <section className={`roleFocusCard ${workRole.toLowerCase()}`}>
        <div>
          <span>{workspaceCopy.eyebrow}</span>
          <h2>{primaryWork.title}</h2>
          <p>{primaryWork.description}</p>
        </div>
        <Link className="primaryButton" href={primaryWork.href}>
          {primaryWork.action}
        </Link>
      </section>

      <section className="metricGrid three">
        <article className="metricCard">
          <span>任务参与员工</span>
          <strong>{formatNumber(workspace?.counts.enabledSeats ?? 0)}</strong>
          <small>员工档案 {workspace?.counts.memberProfiles ?? 0} · 可参与后续活动</small>
        </article>
        <article className="metricCard">
          <span>{workRole === "ANALYST" ? "内容生成完成率" : "员工内容生成成功率"}</span>
          <strong>
            {workspace?.generation.successRate === null ||
            workspace?.generation.successRate === undefined
              ? "—"
              : formatPercent(workspace.generation.successRate)}
          </strong>
          <small>
            成功 {workspace?.generation.succeeded ?? 0} · 失败 {workspace?.generation.failed ?? 0}
          </small>
        </article>
        <article className="metricCard">
          <span>{workRole === "REVIEWER" ? "需要关注的活动" : "需要跟进的活动"}</span>
          <strong>{pendingCoreActions}</strong>
          <small>生成中、生成异常、待审核和待开放活动</small>
        </article>
      </section>

      {workspace && workRole !== "ANALYST" ? (
        <section className="panel coreOperationsPanel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">今天先做什么</span>
              <h2>{workRole === "REVIEWER" ? "待审核工作" : "今日工作优先级"}</h2>
              <p>
                {workRole === "REVIEWER"
                  ? "先处理有风险和等待批准的活动，已开放活动不会在此处制造干扰。"
                  : "按影响业务推进的紧急程度排列，不需要逐个模块寻找工作。"}
              </p>
            </div>
            <StatusBadge tone={readinessBlockers > 0 ? "warning" : "success"}>
              {readinessBlockers > 0 ? `${readinessBlockers} 项准备阻断` : "企业基础已就绪"}
            </StatusBadge>
          </div>
          <div className="coreOperationsBody">
            <Link className="corePrimaryAction" href={workspace.nextAction.href}>
              <span>当前第一优先级</span>
              <h3>{workspace.nextAction.title}</h3>
              <p>{workspace.nextAction.description}</p>
              <b>
                进入处理 <i aria-hidden="true">→</i>
              </b>
            </Link>
            <div className="coreStageGrid">
              <OperationStage
                complete={readinessBlockers === 0}
                count={readinessBlockers}
                detail={readinessBlockers > 0 ? "完成后才能创建新活动" : "参与员工和素材可用"}
                href={readinessBlockers > 0 ? workspace.nextAction.href : "/console"}
                index="01"
                status={readinessBlockers > 0 ? "阻断" : "已就绪"}
                title="运营准备"
                tone={readinessBlockers > 0 ? "danger" : "success"}
              />
              <OperationStage
                count={workspace.campaigns.generating + workspace.campaigns.generationFailed}
                detail={`${workspace.campaigns.generating} 个生成中 · ${workspace.campaigns.generationFailed} 个异常`}
                href="/console/campaigns?view=ACTION_REQUIRED"
                index="02"
                status={workspace.campaigns.generationFailed > 0 ? "需恢复" : "自动执行"}
                title="自动生成"
                tone={workspace.campaigns.generationFailed > 0 ? "danger" : "neutral"}
              />
              <OperationStage
                complete={workspace.campaigns.reviewPending === 0}
                count={workspace.campaigns.reviewPending}
                detail="抽检员工独立图文并批准"
                href="/console/campaigns?view=ACTION_REQUIRED"
                index="03"
                status={workspace.campaigns.reviewPending > 0 ? "待处理" : "无积压"}
                title="人工批准"
                tone={workspace.campaigns.reviewPending > 0 ? "warning" : "neutral"}
              />
              <OperationStage
                complete={workspace.campaigns.approved === 0}
                count={workspace.campaigns.approved}
                detail="到达统一开放时间后，员工才能看到内容"
                href="/console/campaigns?view=ACTIVE"
                index="04"
                status={workspace.campaigns.approved > 0 ? "已计划" : "无等待"}
                title="安排开放"
                tone={workspace.campaigns.approved > 0 ? "success" : "neutral"}
              />
            </div>
          </div>
        </section>
      ) : null}

      {workspace && workRole === "ADMIN" ? (
        <section className="panel workspaceReadinessPanel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">企业基础检查</span>
              <h2>企业运营准备度</h2>
              <p>确认员工、品牌资料和授权素材是否已准备好。</p>
            </div>
            <StatusBadge tone={workspace.campaignReady ? "success" : "warning"}>
              {workspace.campaignReady ? "可创建活动" : "存在必要阻断项"}
            </StatusBadge>
          </div>
          <div className="workspaceReadinessSteps">
            {workspace.steps
              .filter((step) => step.href !== "/console/compliance")
              .map((step) => (
                <Link href={step.href} key={step.code}>
                  <i
                    className={
                      step.status === "COMPLETE"
                        ? "complete"
                        : step.status === "BLOCKING"
                          ? "blocking"
                          : "recommended"
                    }
                  >
                    {step.status === "COMPLETE" ? "✓" : step.status === "BLOCKING" ? "!" : "+"}
                  </i>
                  <span>
                    <strong>{step.title}</strong>
                    <small>{step.description}</small>
                  </span>
                  <b>
                    {step.current} / {step.required}
                  </b>
                </Link>
              ))}
          </div>
        </section>
      ) : null}

      <section className="contentGrid wideLeft">
        <article className="panel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">近期活动</span>
              <h2>最近营销活动</h2>
              <p>
                {loading
                  ? "正在同步…"
                  : `共 ${workspace?.campaigns.total ?? campaigns.length} 个活动 · 展示最近 ${latestCampaigns.length} 个`}
              </p>
            </div>
            <Link href="/console/campaigns">查看全部活动</Link>
          </div>
          {campaigns.length === 0 ? (
            <EmptyCampaigns />
          ) : (
            <div className="campaignList">
              {latestCampaigns.map((campaign, index) => (
                <Link href={`/console/campaigns/${campaign.id}`} key={campaign.id}>
                  <span className="listIndex">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{campaign.title}</strong>
                    <small>
                      独立图文 {campaign.generatedCount} / {campaign.audienceCount} · 员工开放{" "}
                      {formatDate(campaign.visibleAt)}
                    </small>
                  </div>
                  <StatusBadge tone={campaignStatusTone(campaign.status)}>
                    {campaignStatusLabel(campaign.status)}
                  </StatusBadge>
                </Link>
              ))}
            </div>
          )}
        </article>

        {workRole === "ADMIN" || workRole === "OPERATOR" ? (
          <article className="panel actionPanel">
            <span className="sectionKicker">内容基础</span>
            <h2>内容资产基础</h2>
            <p>活动只从当前实际生效的授权素材、合规规则和 GEO 主题中自动召回。</p>
            <div className="miniFacts">
              <span>
                <b>{workspace?.counts.effectiveMaterials ?? 0}</b> 生效素材
              </span>
              <span>
                <b>{workspace?.counts.effectiveSensitiveRules ?? 0}</b> 合规规则
              </span>
              <span>
                <b>{workspace?.counts.activeGeoTopics ?? 0}</b> GEO 主题
              </span>
            </div>
            <Link className="primaryButton block" href="/console/materials">
              管理内容资产
            </Link>
          </article>
        ) : null}
      </section>
    </SaasShell>
  );
}

function OperationStage({
  complete = false,
  count,
  detail,
  href,
  index,
  status,
  title,
  tone,
}: Readonly<{
  complete?: boolean;
  count: number;
  detail: string;
  href: string;
  index: string;
  status: string;
  title: string;
  tone: "danger" | "neutral" | "success" | "warning";
}>) {
  return (
    <Link className={`coreStageCard ${tone}`} href={href}>
      <span className="coreStageIndex">{index}</span>
      <StatusBadge tone={tone}>{status}</StatusBadge>
      <strong>{title}</strong>
      {complete ? (
        <span aria-label="已就绪，无需处理" className="coreStageComplete" role="img">
          ✓
        </span>
      ) : (
        <b>{count}</b>
      )}
      <small>{detail}</small>
    </Link>
  );
}

function EmptyCampaigns() {
  return (
    <div className="emptyState">
      <span>还没有活动</span>
      <h3>从一段运营要求开始</h3>
      <p>无需先创建母版，系统会在后台自动完成。</p>
      <Link className="primaryButton" href="/console/campaigns/new">
        创建第一个活动
      </Link>
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="setupScreen">
      <section aria-busy="true" aria-live="polite" className="sessionRestoreCard">
        <span aria-hidden="true" className="sessionRestoreMark">
          <i />
        </span>
        <p className="sessionRestoreEyebrow" suppressHydrationWarning>
          <PlatformName />
        </p>
        <h1 suppressHydrationWarning>正在恢复本机会话…</h1>
        <p className="sessionRestoreDetail">正在确认你的身份与工作区配置</p>
        <span aria-hidden="true" className="sessionRestoreProgress" />
      </section>
    </main>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, style: "percent" }).format(
    value,
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function rolePrimaryWork(role: ReturnType<typeof adminWorkRole>, workspace: Workspace | null) {
  if (role === "REVIEWER") {
    return workspace?.campaigns.reviewPending
      ? {
          action: "开始审核",
          description: `${workspace.campaigns.reviewPending} 个活动正在等待内容审核和开放决定。`,
          href: "/console/campaigns?view=ACTION_REQUIRED",
          title: "先完成待审核活动",
        }
      : {
          action: "查看审核记录",
          description: "当前没有待审核积压，可以检查近期风险处置和规范变化。",
          href: "/console/audit",
          title: "当前审核任务已清空",
        };
  }
  if (role === "ANALYST") {
    return {
      action: "查看活动效果",
      description: "从执行完成率、员工公开数据和宣传重点覆盖判断下期内容方向。",
      href: "/console/analytics",
      title: "从结果中找到下一期增长方向",
    };
  }
  if (role === "OPERATOR") {
    return workspace?.campaigns.reviewPending || workspace?.campaigns.generationFailed
      ? {
          action: "处理活动",
          description: "有生成异常或待审核活动需要继续推进，完成后才能按计划开放给员工。",
          href: "/console/campaigns?view=ACTION_REQUIRED",
          title: "先处理影响开放的活动",
        }
      : {
          action: "创建活动",
          description: "输入本期传播目标，系统会自动引用品牌资料并为每名员工生成独立图文。",
          href: "/console/campaigns/new",
          title: "开始准备下一期内容",
        };
  }
  return {
    action: workspace?.nextAction.title ?? "查看企业准备",
    description: workspace?.nextAction.description ?? "检查员工、品牌资料、活动和用量是否正常。",
    href: workspace?.nextAction.href ?? "/console",
    title: workspace?.campaignReady ? "企业运营基础正常" : "先解除影响活动创建的阻断",
  };
}
