"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import {
  apiRequest,
  type CursorPage,
  cursorPagePath,
  platformNavigationPermissions,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type GenerationRun = components["schemas"]["GenerationRunListItemDto"];
type OperationsOverview = components["schemas"]["PlatformOperationsOverviewDto"];

const filters = ["ALL", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const;

export default function PlatformOperationsPage() {
  const auth = useMvpSession();
  const [runs, setRuns] = useState<GenerationRun[]>([]);
  const [filter, setFilter] = useState<(typeof filters)[number]>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [recoveringRunId, setRecoveringRunId] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null = null) => {
      if (!auth.session) return;
      setLoading(true);
      setError(null);
      try {
        const [page, overviewData] = await Promise.all([
          apiRequest<CursorPage<GenerationRun>>(
            cursorPagePath("/platform/operations/generation-runs", cursor),
            { token: auth.session.platformToken },
          ),
          cursor
            ? Promise.resolve(null)
            : apiRequest<OperationsOverview>("/platform/operations/overview", {
                token: auth.session.platformToken,
              }),
        ]);
        setRuns((current) => (cursor ? [...current, ...page.items] : [...page.items]));
        setNextCursor(page.pageInfo.nextCursor);
        if (overviewData) setOverview(overviewData);
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

  async function recoverRun(runId: string) {
    if (!auth.session) return;
    setRecoveringRunId(runId);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<components["schemas"]["GenerationRecoveryResponseDto"]>(
        `/platform/operations/generation-runs/${runId}/recover`,
        { method: "POST", token: auth.session.platformToken },
      );
      setNotice(
        `已恢复 ${result.recoveredRuns} 个运行、${result.recoveredWorkItems} 个员工工作项；队列会继续自动补偿未成功投递的 Job。`,
      );
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setRecoveringRunId(null);
    }
  }

  const visibleRuns = useMemo(
    () => (filter === "ALL" ? runs : runs.filter(({ status }) => status === filter)),
    [filter, runs],
  );

  if (auth.session === undefined) return <OperationsLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  return (
    <SaasShell
      active="operations"
      description="监控后台自动母版、员工级生成工作项、重试、模型调用与执行状态。"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      title="任务中心"
      toolbar={
        <div className="toolbar">
          <button
            className="ghostButton refreshButton"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? "同步中…" : "刷新状态与任务"}
          </button>
          <Link className="primaryButton" href="/platform/models">
            模型与路由
          </Link>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <section className="metricGrid four">
        <Metric
          label="正式交付模式"
          value={overview?.models.deliveryMode ?? "—"}
          detail="API 与 Worker 双重边界"
          tone="accent"
        />
        <Metric
          label="在线 Worker"
          value={overview?.generation.queue.workers ?? 0}
          detail={`积压 ${(overview?.generation.queue.waiting ?? 0) + (overview?.generation.queue.delayed ?? 0)}`}
        />
        <Metric
          label="合格真实路由"
          value={overview?.models.qualifiedRoutes ?? 0}
          detail={`阻断 ${overview?.models.blockedRoutes ?? 0} · 开发 ${overview?.models.syntheticRoutes ?? 0}`}
        />
        <Metric
          label="今日模型成本"
          value={`¥${(overview?.generation.invocationCostToday ?? 0).toFixed(4)}`}
          detail={`${overview?.generation.invocationsToday ?? 0} 次调用`}
        />
      </section>

      <section className="panel operationsPanel">
        <div className="panelHeader operationsHeader">
          <div>
            <span className="sectionKicker">AUTOMATION RUNS</span>
            <h2>活动生成运行</h2>
            <p>运营人员只处理业务状态；模型调用和员工级工作项保留在平台诊断层。</p>
          </div>
          <fieldset className="filterPills">
            <legend>生成状态筛选</legend>
            {filters.map((value) => (
              <button
                aria-pressed={filter === value}
                className={filter === value ? "active" : ""}
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {statusLabel(value)}
              </button>
            ))}
          </fieldset>
        </div>

        {visibleRuns.length === 0 ? (
          <div className="emptyState compact">
            <span>当前筛选下没有生成任务</span>
            <p>企业创建活动后，后台会自动建立运行和员工级工作项。</p>
          </div>
        ) : (
          <section className="operationsTable" aria-label="生成任务列表">
            <div className="operationsTableHead">
              <span>活动 / 客户</span>
              <span>状态与进度</span>
              <span>模型路由</span>
              <span>任务诊断</span>
              <span>成本 / 时间</span>
            </div>
            {visibleRuns.map((run) => (
              <article key={run.id}>
                <div>
                  <strong>{run.campaign.title}</strong>
                  <small>
                    {run.tenant.name} · {run.enterprise.name}
                  </small>
                  <code>{run.id.slice(0, 12)}</code>
                </div>
                <div>
                  <StatusBadge tone={statusTone(run.status)}>{statusLabel(run.status)}</StatusBadge>
                  <strong>
                    {run.completedCount} / {run.requestedCount}
                  </strong>
                  <progress max={Math.max(run.requestedCount, 1)} value={run.completedCount} />
                </div>
                <div>
                  <span>{run.provider}</span>
                  <small>文案 {run.textModel}</small>
                  <small>生图 {run.imageModel}</small>
                  {run.synthetic ? <em>SYNTHETIC</em> : <em className="real">REAL</em>}
                </div>
                <div>
                  <span>
                    失败 {run.failedCount} · 重试 {run.retriedWorkItems}
                  </span>
                  <small>
                    排队 {run.workItems.QUEUED ?? 0} · 运行 {run.workItems.RUNNING ?? 0}
                  </small>
                  <small>调用失败 {run.invocations.FAILED ?? 0}</small>
                  <small>
                    租约活跃 {run.activeWorkItemLeases} · 已过期 {run.staleWorkItems}
                  </small>
                  <small>
                    队列 v{run.queueVersion} · 执行 v{run.executionVersion} · 接管{" "}
                    {run.recoveryCount}
                  </small>
                  {run.errorCode ? <small>最近错误 {run.errorCode}</small> : null}
                  {(run.workItems.QUEUED ?? 0) > 0 || run.staleWorkItems > 0 ? (
                    <button
                      className="ghostButton"
                      disabled={recoveringRunId !== null}
                      onClick={() => void recoverRun(run.id)}
                      type="button"
                    >
                      {recoveringRunId === run.id ? "恢复中…" : "人工恢复"}
                    </button>
                  ) : null}
                </div>
                <div>
                  <strong>¥{run.estimatedCost.toFixed(4)}</strong>
                  <small>{durationLabel(run)}</small>
                  <small>{formatDateTime(run.createdAt)}</small>
                </div>
              </article>
            ))}
            {nextCursor ? (
              <button
                className="ghostButton"
                disabled={loading}
                onClick={() => void load(nextCursor)}
                type="button"
              >
                {loading ? "加载中…" : "加载更多运行记录"}
              </button>
            ) : null}
          </section>
        )}
      </section>
    </SaasShell>
  );
}

function Metric({
  detail,
  label,
  tone,
  value,
}: Readonly<{ detail: string; label: string; tone?: string; value: number | string }>) {
  return (
    <article className={`metricCard ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function statusLabel(status: string): string {
  return (
    (
      {
        ALL: "全部",
        FAILED: "失败",
        QUEUED: "排队中",
        RUNNING: "生成中",
        SUCCEEDED: "已完成",
      } as Record<string, string>
    )[status] ?? status
  );
}

function statusTone(status: string): "danger" | "neutral" | "success" | "warning" {
  if (status === "SUCCEEDED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "RUNNING") return "warning";
  return "neutral";
}

function durationLabel(run: GenerationRun): string {
  if (!run.startedAt) return "尚未开始";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function OperationsLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          AUTOMATION
        </span>
        <h1 suppressHydrationWarning>正在读取生成任务…</h1>
      </section>
    </main>
  );
}
