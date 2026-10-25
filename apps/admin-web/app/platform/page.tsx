"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FeedbackMessage } from "../components/feedback-toast";
import { MvpSetup } from "../components/mvp-setup";
import { SaasShell, StatusBadge } from "../components/saas-shell";
import { apiRequest, platformNavigationPermissions } from "../lib/mvp-client";
import { messageOf, useMvpSession } from "../lib/use-mvp-session";

type PlatformOverview = components["schemas"]["PlatformOperationsOverviewDto"];

export default function PlatformOverviewPage() {
  const auth = useMvpSession();
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!auth.session) return;
    setLoading(true);
    setError(null);
    try {
      setOverview(
        await apiRequest<PlatformOverview>("/platform/operations/overview", {
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

  if (auth.session === undefined) return <PlatformLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  const generation = overview?.generation;
  const tenants = overview?.tenants;
  const models = overview?.models;
  const production = overview?.productionReadiness;
  const activeRuns =
    (generation?.runsByStatus.QUEUED ?? 0) + (generation?.runsByStatus.RUNNING ?? 0);
  const failedWorkItems = generation?.workItemsByStatus.FAILED ?? 0;
  const queueBacklog =
    (generation?.queue.waiting ?? 0) +
    (generation?.queue.active ?? 0) +
    (generation?.queue.delayed ?? 0);
  return (
    <SaasShell
      active="overview"
      description="维护企业配置、模型能力和运行健康。"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      title="系统概览"
      toolbar={
        <div className="toolbar">
          <button
            className="ghostButton refreshButton"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? "同步中…" : "刷新"}
          </button>
          <Link className="primaryButton" href="/platform/operations">
            查看生成任务
          </Link>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      <div className="liveNotice">
        <span className="liveDot" />
        <strong>平台数据实时读取</strong>
        <span>
          {overview ? `统计生成于 ${formatDateTime(overview.generatedAt)}` : "正在读取平台数据…"}
        </span>
      </div>
      <section className="metricGrid four">
        <article className="metricCard accent">
          <span>试点租户</span>
          <strong>{tenants?.activeTenants ?? "—"}</strong>
          <small>
            集团 {tenants?.groups ?? 0} · 单体企业 {tenants?.singleEnterprises ?? 0}
          </small>
        </article>
        <article className="metricCard">
          <span>今日模型调用</span>
          <strong>{formatNumber(generation?.invocationsToday)}</strong>
          <small>
            失败 {generation?.invocationFailuresToday ?? 0} · 成本 ¥
            {formatCost(generation?.invocationCostToday)}
          </small>
        </article>
        <article className="metricCard">
          <span>生成成功率</span>
          <strong>{formatPercent(generation?.runSuccessRate)}</strong>
          <small>今日新建 {generation?.runsToday ?? 0} 次运行</small>
        </article>
        <article className="metricCard">
          <span>运行中 / 异常项</span>
          <strong>
            {activeRuns} / {failedWorkItems}
          </strong>
          <small>排队与运行任务 / 最终失败员工项</small>
        </article>
      </section>
      <section className="contentGrid equal">
        <article className="panel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">SYSTEM HEALTH</span>
              <h2>平台能力状态</h2>
            </div>
            <StatusBadge
              tone={
                production?.state === "READY" && !production?.summary.warning
                  ? "success"
                  : "warning"
              }
            >
              {production?.state === "READY"
                ? production.summary.warning > 0
                  ? `核心可运行 · ${production.summary.warning} 项提醒`
                  : "生产就绪"
                : `${production?.summary.blocked ?? "—"} 项阻断`}
            </StatusBadge>
          </div>
          <div className="healthList">
            <div>
              <i className={checkReady(production, "INFRASTRUCTURE_DATABASE") ? "ok" : "pending"} />
              <span>
                <strong>PostgreSQL</strong>
                <small>{checkMessage(production, "INFRASTRUCTURE_DATABASE")}</small>
              </span>
            </div>
            <div>
              <i
                className={
                  checkReady(production, "INFRASTRUCTURE_REDIS") &&
                  checkReady(production, "INFRASTRUCTURE_GENERATION_QUEUE") &&
                  checkReady(production, "INFRASTRUCTURE_WORKER_CAPACITY")
                    ? "ok"
                    : "pending"
                }
              />
              <span>
                <strong>Redis / BullMQ</strong>
                <small>
                  队列积压 {queueBacklog} · 活跃 Worker {generation?.queue.workers ?? 0}
                </small>
              </span>
            </div>
            <div>
              <i
                className={checkReady(production, "MODEL_ROUTE_QUALIFICATION") ? "ok" : "pending"}
              />
              <span>
                <strong>模型 Provider</strong>
                <small>
                  已启用 {models?.activeProviders ?? 0} · 真实 {models?.realProviders ?? 0} · 开发{" "}
                  {models?.syntheticProviders ?? 0}
                </small>
              </span>
            </div>
            <div>
              <i className={checkReady(production, "ADAPTER_CONTENT_SAFETY") ? "ok" : "pending"} />
              <span>
                <strong>内容审核服务</strong>
                <small>内容审核连接正常；短信和 Cap 均为可选配置</small>
              </span>
            </div>
          </div>
          <div className="healthActions">
            <Link className="textLink" href="/platform/readback">
              查看发布复核与自动回读
            </Link>
            <Link className="textLink" href="/platform/gates">
              查看核心检查与 {production?.summary.warning ?? 0} 项提醒
            </Link>
          </div>
        </article>
        <article className="panel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">GUARDRAILS</span>
              <h2>平台数据边界</h2>
            </div>
          </div>
          <ul className="guardrailList">
            <li>模型 API Key 永不返回前端明文</li>
            <li>平台运维读取租户数据必须记录原因</li>
            <li>模型路由变更生成新版本并写审计</li>
            <li>供应商费用以供应商账单为准</li>
          </ul>
        </article>
      </section>
    </SaasShell>
  );
}

function checkReady(
  audit: PlatformOverview["productionReadiness"] | undefined,
  code: string,
): boolean {
  return audit?.checks.find((check) => check.code === code)?.status === "READY";
}

function checkMessage(
  audit: PlatformOverview["productionReadiness"] | undefined,
  code: string,
): string {
  return audit?.checks.find((check) => check.code === code)?.message ?? "正在执行实时探针";
}

function PlatformLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          PLATFORM
        </span>
        <h1 suppressHydrationWarning>正在读取系统状态…</h1>
      </section>
    </main>
  );
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatCost(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(4);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, style: "percent" }).format(
    value,
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
