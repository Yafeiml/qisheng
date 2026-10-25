"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { apiRequest, platformNavigationPermissions } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type OperationsOverview = components["schemas"]["PlatformOperationsOverviewDto"];
type ProductionReadinessCheck = components["schemas"]["ProductionReadinessCheckDto"];

export default function PlatformGatesPage() {
  const auth = useMvpSession();
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!auth.session) return;
    setLoading(true);
    setError(null);
    try {
      setOverview(
        await apiRequest<OperationsOverview>("/platform/operations/overview", {
          token: auth.session.platformToken,
        }),
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, [auth.session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (auth.session === undefined) return null;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;

  return (
    <SaasShell
      active="gates"
      description="独立查看生产就绪检查、模型与存储验收阶段，以及生成运行门禁。"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      title="门禁状态"
      toolbar={
        <div className="toolbar">
          <button
            className="ghostButton refreshButton"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? "同步中…" : "刷新门禁"}
          </button>
          <Link className="primaryButton" href="/platform/operations">
            任务中心
          </Link>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {overview ? (
        <section className="panel productionReadinessPanel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">PRODUCTION READINESS</span>
              <h2>生产就绪引导</h2>
              <p>
                保存配置后，还需确认连接、功能验证和生产要求。展开模型或存储的阶段详情，查看具体原因与下一步操作。
                节点状态、任务和额度在“回读节点”页面查看。
              </p>
            </div>
            <StatusBadge
              tone={
                overview.productionReadiness.state === "READY"
                  ? overview.productionReadiness.summary.warning > 0
                    ? "warning"
                    : "success"
                  : "danger"
              }
            >
              {overview.productionReadiness.state === "READY"
                ? overview.productionReadiness.summary.warning > 0
                  ? `核心就绪 · ${overview.productionReadiness.summary.warning} 项提醒`
                  : "全部就绪"
                : `${overview.productionReadiness.summary.blocked} 项阻断`}
            </StatusBadge>
          </div>
          <div className="productionReadinessSummary">
            <strong>
              {overview.productionReadiness.summary.ready} /{" "}
              {overview.productionReadiness.summary.total -
                overview.productionReadiness.summary.warning}
            </strong>
            <span>强制检查已通过 · {overview.productionReadiness.summary.warning} 项提醒</span>
            <small>审计时间 {formatDateTime(overview.productionReadiness.generatedAt)}</small>
          </div>
          <div className="productionReadinessList">
            {overview.productionReadiness.checks.map((item) => (
              <ReadinessCheck key={item.code} item={item} />
            ))}
          </div>
        </section>
      ) : null}

      {overview ? (
        <section className="panel runtimeGuardPanel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">PRODUCTION GATE</span>
              <h2>正式生成门禁状态</h2>
              <p>模型服务状态、连接保护和任务队列共同决定活动能否开始生成内容。</p>
            </div>
            <StatusBadge
              tone={overview.productionReadiness.state === "READY" ? "success" : "warning"}
            >
              {overview.productionReadiness.state === "READY" ? "正式可用" : "尚未正式就绪"}
            </StatusBadge>
          </div>
          <div className="runtimeGuardGrid">
            <RuntimeFact label="连接待恢复供应商" value={overview.models.staleHealthProviders} />
            <RuntimeFact label="OPEN 熔断" value={overview.models.openCircuitProviders} />
            <RuntimeFact label="HALF_OPEN 熔断" value={overview.models.halfOpenCircuitProviders} />
            <RuntimeFact
              label="队列状态"
              value={overview.generation.queue.paused ? "已暂停" : "运行中"}
            />
            <RuntimeFact
              label="活跃 / 等待"
              value={`${overview.generation.queue.active} / ${overview.generation.queue.waiting}`}
            />
            <RuntimeFact label="今日调用失败" value={overview.generation.invocationFailuresToday} />
          </div>
        </section>
      ) : null}
    </SaasShell>
  );
}

function ReadinessCheck({ item }: Readonly<{ item: ProductionReadinessCheck }>) {
  const nextStage = item.stages?.find(
    (stage) => stage.status === "BLOCKED" || stage.status === "UNKNOWN",
  );
  const skipped = item.stages?.filter((stage) => stage.status === "SKIPPED").length ?? 0;
  return (
    <article
      className={
        item.status === "READY" ? "ready" : item.status === "WARNING" ? "warning" : "blocked"
      }
    >
      <i aria-hidden="true" />
      <div>
        <span>{categoryLabel(item.category)}</span>
        <strong>{item.title}</strong>
        {item.stages?.length ? (
          <p>
            {item.status === "READY"
              ? "生产验收已通过"
              : nextStage
                ? `下一步：${nextStage.title}`
                : "待完成生产验收"}
            {" · "}
            {item.stages.filter((stage) => stage.status === "READY").length} /{" "}
            {item.stages.length - skipped} 阶段通过
            {skipped > 0 ? ` · ${skipped} 项按策略跳过` : null}
          </p>
        ) : null}
        <p>{item.message}</p>
        {item.status !== "READY" ? <small>{item.action}</small> : null}
        {item.stages?.length ? (
          <details className="readinessStages" open={Boolean(nextStage)}>
            <summary>阶段详情与操作指引</summary>
            <ol>
              {item.stages.map((stage) => (
                <li key={stage.code} data-state={stage.status}>
                  <strong>
                    {stage.title} ·{" "}
                    {stage.status === "READY"
                      ? "已通过"
                      : stage.status === "WARNING"
                        ? "诊断提醒"
                        : stage.status === "UNKNOWN"
                          ? "无法确认"
                          : stage.status === "SKIPPED"
                            ? "按策略跳过"
                            : "待处理"}
                  </strong>
                  <p>{stage.message}</p>
                  {stage.status !== "READY" ? (
                    <>
                      <p>{stage.action}</p>
                      <Link className="textLink" href={stage.href}>
                        前往{item.category === "MODEL" ? "模型配置" : "存储设置"}
                      </Link>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      <Link className="textLink" href={item.href}>
        {item.status === "READY"
          ? "查看配置"
          : item.status === "WARNING"
            ? "查看提醒"
            : nextStage
              ? `检查${nextStage.title}`
              : "查看处理指引"}
      </Link>
    </article>
  );
}

function categoryLabel(category: ProductionReadinessCheck["category"]): string {
  return {
    ADAPTER: "外部服务",
    INFRASTRUCTURE: "基础设施",
    MODEL: "模型能力",
    RUNTIME: "运行模式",
    SECURITY: "安全基线",
  }[category];
}

function RuntimeFact({ label, value }: Readonly<{ label: string; value: number | string }>) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}
