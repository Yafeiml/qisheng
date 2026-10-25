"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FeedbackMessage } from "../../components/feedback-toast";
import { StatusBadge } from "../../components/saas-shell";
import { apiRequest } from "../../lib/mvp-client";
import { messageOf } from "../../lib/use-mvp-session";
import styles from "./models.module.css";

type Catalog = components["schemas"]["ModelCatalogResponseDto"];
type Policy = components["schemas"]["RuntimePolicyResponseDto"];
type Check = components["schemas"]["ProductionReadinessCheckDto"];
type Health = components["schemas"]["ModelProviderHealthCheckResponseDto"];
type Qualification = components["schemas"]["ModelRouteQualificationResponseDto"];

export function ModelReadiness({
  token,
  catalog,
  policy,
  disabled,
  setBusy,
  onCatalog,
}: {
  token: string;
  catalog: Catalog;
  policy: Policy;
  disabled: boolean;
  setBusy: (busy: boolean) => void;
  onCatalog: (catalog: Catalog) => void;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [textReceipts, setTextReceipts] = useState<Record<string, Qualification>>({});
  const [action, setAction] = useState<string | null>(null);
  const locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Saving configuration or refreshing the catalog invalidates the server-side assessment.
  useEffect(() => {
    let cancelled = false;
    setCheck(null);
    void apiRequest<components["schemas"]["ProductionReadinessAuditDto"]>(
      "/platform/operations/production-readiness",
      { token },
    )
      .then((audit) => {
        if (cancelled) return;
        setCheck(audit.checks.find((item) => item.code === "MODEL_ROUTE_QUALIFICATION") ?? null);
        setAuditError(null);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setAuditError(`门禁状态暂不可读取：${messageOf(reason)}。仍可执行下方检查。`);
      });
    return () => {
      cancelled = true;
    };
  }, [token, catalog, policy]);
  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (disabled || locked.current || refreshing || document.visibilityState !== "visible")
        return;
      refreshing = true;
      try {
        const latest = await apiRequest<Catalog>("/platform/model-catalog", { token });
        if (!cancelled) onCatalog(latest);
      } catch {
        if (!cancelled) setAuditError("自动刷新暂时失败，将稍后重试。当前展示最近一次检查结果。");
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [token, disabled, onCatalog]);

  const modelIds = new Set([
    policy.embeddingModelId,
    policy.materialAnalysisModelId,
    ...catalog.routes.flatMap((route) => [
      route.textModel.id,
      route.imageModel.id,
      ...route.textFallbackModelIds,
      ...route.imageFallbackModelIds,
    ]),
  ]);
  const providers = catalog.providers.filter(
    (provider) => !provider.synthetic && provider.models?.some((model) => modelIds.has(model.id)),
  );

  async function run(label: string, operation: () => Promise<void>) {
    if (disabled || locked.current) return;
    locked.current = true;
    setBusy(true);
    setAction(label);
    setMessages([]);
    try {
      await operation();
    } catch (reason) {
      setMessages([
        `暂未确认检查结果：${messageOf(reason)}。请先刷新结果；功能验证可能仍在执行，请勿立即重复提交。`,
      ]);
    } finally {
      try {
        onCatalog(await apiRequest<Catalog>("/platform/model-catalog", { token }));
      } catch {
        setMessages((current) => [...current, "刷新记录失败，请稍后刷新页面核对结果。"]);
      }
      locked.current = false;
      setBusy(false);
      setAction(null);
    }
  }

  async function testConnections() {
    await run("正在检查供应商连接…", async () => {
      const results = await Promise.all(
        providers.map(async (provider) => {
          try {
            const result = await apiRequest<Health>(
              `/platform/model-providers/${provider.id}/test-connection`,
              { token, method: "POST" },
            );
            return result.healthy
              ? `${provider.name}：连接检查通过`
              : `${provider.name}：连接未通过（${result.errorCode ?? "UNKNOWN"}${result.httpStatus ? ` / HTTP ${result.httpStatus}` : ""}），${result.errorMessage ?? "请检查地址、密钥和供应商权限"}`;
          } catch (reason) {
            return `${provider.name}：${messageOf(reason)}`;
          }
        }),
      );
      setMessages(results);
    });
  }

  async function qualify(route: Catalog["routes"][number], requiresImage = true) {
    if (disabled || locked.current) return;
    if (
      !window.confirm(
        requiresImage
          ? "功能验证将真实调用该路由的文案和生图模型，并检查图片存储回读，可能产生供应商费用。确认执行？"
          : "仅验收文案将真实调用文案模型，可能产生供应商费用；不验证生图或图片存储，也不授予 AI 插画能力。确认执行？",
      )
    )
      return;
    await run(
      requiresImage
        ? "正在验证连接、文案、生图和存储回读，请勿重复提交…"
        : "正在仅验收文案，请勿重复提交…",
      async () => {
        const result = await apiRequest<Qualification>(
          `/platform/model-routes/${route.id}/qualify`,
          {
            token,
            method: "POST",
            ...(!requiresImage ? { body: { requiresImage: false } } : {}),
          },
        );
        if (!requiresImage) setTextReceipts((current) => ({ ...current, [route.id]: result }));
        setMessages([
          result.status === "PASSED"
            ? requiresImage
              ? "功能验证通过：文案、生图及存储回读均成功。已记录结果，正在刷新门禁。"
              : "仅文案验收通过：适用于原图处理与本地问题卡的文案步骤，未验收 AI 插画或图片存储回读。"
            : `功能验证未通过（${result.errorCode ?? "UNKNOWN"}）：${result.errorMessage ?? "请检查供应商模型能力及存储配置"}`,
        ]);
      },
    );
  }

  return (
    <section
      className={`panel ${styles.readiness}`}
      aria-label="模型连接与功能验证"
      id="verification"
    >
      <header className={styles.sectionHeader}>
        <h2>连接检查与功能验证</h2>
        <div className={styles.headerActions}>
          <Link className="ghostButton" href="/platform/gates">
            查看完整生产门禁
          </Link>
          <button
            type="button"
            className="ghostButton"
            disabled={disabled}
            onClick={() => void run("正在刷新结果…", async () => {})}
          >
            刷新检查结果
          </button>
        </div>
      </header>
      <p className={styles.hint}>
        保存配置后，系统自动检查当前使用的供应商连接。功能验证需主动执行，可能产生供应商费用。
      </p>
      {disabled && !action ? (
        <p className={styles.hint}>请先保存更改并关闭连接设置，再执行检查。</p>
      ) : null}
      {action || messages.length ? (
        <div role="status">
          {action ? <p>{action}</p> : null}
          {messages.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      {auditError ? <FeedbackMessage tone="error">{auditError}</FeedbackMessage> : null}
      <div className={styles.selectionGrid}>
        <section className={styles.picker} aria-label="连接检查">
          <h3>1. 连接状态（自动检查）</h3>
          <p className={styles.hint}>
            {check?.stages?.find((stage) => stage.code === "CONNECTION")?.message}
          </p>
          {providers.map((provider) => {
            const healthy = provider.healthStatus === "HEALTHY";
            return (
              <div className={styles.provider} key={provider.id}>
                <div className={styles.providerHeading}>
                  <strong>{provider.name}</strong>
                  <StatusBadge tone={healthy ? "success" : "warning"}>
                    {provider.healthStatus === "UNKNOWN"
                      ? "等待自动检查"
                      : provider.healthStatus === "UNHEALTHY"
                        ? "未通过"
                        : "连接通过"}
                  </StatusBadge>
                </div>
                <small className={styles.hint}>
                  最近检查：
                  {provider.lastHealthCheckedAt
                    ? new Date(provider.lastHealthCheckedAt).toLocaleString("zh-CN")
                    : "尚未检查"}
                  {provider.lastHealthErrorCode ? ` · ${provider.lastHealthErrorCode}` : ""}
                </small>
                {provider.circuitState !== "CLOSED" ? (
                  <small className={styles.hint}>
                    调用保护正在冷却，随后自动探测恢复；持续异常时可检查供应商连接。
                  </small>
                ) : null}
              </div>
            );
          })}
          <p className={styles.hint}>
            系统自动复查连接，无需定时手动测试。单次探测失败仅作提示，不使功能验证失效。此检查不会生成文案或图片。
          </p>
          <button
            type="button"
            className="ghostButton"
            disabled={disabled || !providers.length}
            onClick={() => void testConnections()}
          >
            检查已使用的供应商连接
          </button>
        </section>
        <section className={styles.picker} aria-label="功能验证">
          <h3>2. 功能验证</h3>
          <p className={styles.hint}>
            {check?.stages?.find((stage) => stage.code === "VALIDATION")?.message}
          </p>
          <p className={styles.hint}>
            验证通过后持续有效，不必每天重测。首次接入、变更模型或密钥等配置时需要验证； 连续 3
            个独立任务在多轮重试后仍因模型调用失败时，才要求功能复验。
            文案和生图分别统计，成功会清零，存储、审核等错误不计入。手动验证会真实调用模型，可能产生费用。
          </p>
          {catalog.routes.map((route) => (
            <div className={styles.provider} key={route.id}>
              <strong>
                {route.scopeType === "PLATFORM"
                  ? "平台默认路由"
                  : `${route.scopeType === "TENANT" ? "集团" : "企业"}路由 ${route.scopeId}`}
              </strong>
              <p className={styles.hint}>
                {route.textModel.externalModelId} / {route.imageModel.externalModelId}
              </p>
              <p className={styles.hint}>
                {route.qualification
                  ? `最近验证：${route.qualification.status === "PASSED" ? "通过" : "未通过"} · ${new Date(route.qualification.checkedAt).toLocaleString("zh-CN")} · ${route.qualification.deliveryMode === "PRODUCTION" ? "生产模式" : "开发模式"}`
                  : "尚未执行功能验证"}
              </p>
              {route.runtimeHealth ? (
                <div className={styles.runtimeHealth} data-state={route.runtimeHealth.state}>
                  <strong>
                    {
                      {
                        QUALIFICATION_REQUIRED: "当前配置需要验证",
                        UNOBSERVED: "验证有效 · 等待真实任务",
                        HEALTHY: "运行正常",
                        WATCHING: "失败观察中 · 尚未触发复验",
                        REVALIDATION_REQUIRED: "连续失败 · 需要功能复验",
                      }[route.runtimeHealth.state]
                    }
                  </strong>
                  <span>
                    重试耗尽的连续任务：文案 {route.runtimeHealth.textFailures}/
                    {route.runtimeHealth.failureThreshold}
                    {" · "}生图 {route.runtimeHealth.imageFailures}/
                    {route.runtimeHealth.failureThreshold}
                  </span>
                  {route.runtimeHealth.lastSuccessAt ? (
                    <span>
                      最近成功：
                      {new Date(route.runtimeHealth.lastSuccessAt).toLocaleString("zh-CN")}
                    </span>
                  ) : null}
                  {route.runtimeHealth.lastFailureAt ? (
                    <span>
                      最近模型失败：
                      {new Date(route.runtimeHealth.lastFailureAt).toLocaleString("zh-CN")}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {route.runtimeHealth?.notificationStatus ? (
                <p className={styles.hint} role="status">
                  管理员邮件：{notificationLabel(route.runtimeHealth.notificationStatus)}
                </p>
              ) : null}
              {route.runtimeHealth?.notificationStatus &&
              ["FAILED", "EXHAUSTED", "UNCONFIGURED"].includes(
                route.runtimeHealth.notificationStatus,
              ) ? (
                <button
                  type="button"
                  className="ghostButton"
                  disabled={disabled}
                  onClick={() =>
                    void run("正在重新安排通知…", async () => {
                      const result = await apiRequest<{ queued: boolean }>(
                        `/platform/model-routes/${route.id}/retry-notification`,
                        { token, method: "POST" },
                      );
                      setMessages([
                        result.queued
                          ? "已安排重试邮件通知，请稍后刷新查看结果。"
                          : "故障已恢复或通知正在处理，请刷新查看状态。",
                      ]);
                    })
                  }
                >
                  重试邮件通知
                </button>
              ) : null}
              {route.qualification?.errorCode ? (
                <p className={styles.hint}>
                  {route.qualification.errorCode}：{route.qualification.errorMessage}
                </p>
              ) : null}
              {route.qualification ? (
                <QualificationDiagnostics qualification={route.qualification} />
              ) : null}
              {textReceipts[route.id] &&
              textReceipts[route.id]?.checkedAt !== route.qualification?.checkedAt ? (
                <div>
                  <p className={styles.hint}>
                    最近仅文案验收：
                    {textReceipts[route.id]?.status === "PASSED" ? "通过" : "未通过"}
                  </p>
                  <QualificationDiagnostics
                    qualification={textReceipts[route.id] as Qualification}
                  />
                </div>
              ) : null}
              <button
                type="button"
                className="ghostButton"
                disabled={disabled || route.textModel.synthetic || route.imageModel.synthetic}
                onClick={() => void qualify(route)}
              >
                执行功能验证（可能计费）
              </button>
              <button
                type="button"
                className="ghostButton"
                disabled={disabled || route.textModel.synthetic}
                onClick={() => void qualify(route, false)}
              >
                仅验收文案（可能计费）
              </button>
            </div>
          ))}
          {!catalog.routes.length ? <p className={styles.hint}>请先保存文案和生图模型。</p> : null}
          <p className={styles.hint}>最近记录仅为历史结果；是否匹配当前配置以生产门禁为准。</p>
        </section>
      </div>
    </section>
  );
}

function QualificationDiagnostics({ qualification }: { qualification: Qualification }) {
  const diagnostics = qualification.diagnostics;
  const steps = diagnostics?.steps;
  const request = diagnostics?.request;
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const savedSteps = record(steps);
  const details = record(request);
  const labels: Record<string, string> = {
    CONNECTION: "连接",
    TEXT: "文案",
    IMAGE: "生图",
    STORAGE: "存储回读",
  };
  const legacy = Object.keys(savedSteps).length === 0;
  const textOnly =
    Array.isArray(diagnostics?.requiredCapabilities) &&
    diagnostics.requiredCapabilities.length === 1 &&
    diagnostics.requiredCapabilities[0] === "TEXT";
  return (
    <div className={styles.hint}>
      <p>
        {textOnly
          ? "验收范围：仅文案（TEXT）。原图处理与问题卡可使用此文案验收；生图、图片存储回读及 AI 插画未验收。"
          : "验收范围：文案、生图及图片存储回读。"}
      </p>
      {legacy ? (
        <p>
          历史记录：文案{qualification.textLatencyMs !== null ? "已通过" : "未确认通过"}； 生图
          {qualification.imageLatencyMs !== null ? "已通过" : "未确认通过"}； 存储回读
          {qualification.storageVerified ? "已通过" : "未执行或未通过"}。旧记录未保存接口诊断。
        </p>
      ) : (
        <p>
          {Object.entries(labels)
            .map(
              ([key, label]) =>
                `${label}：${savedSteps[key] === "PASSED" ? "通过" : savedSteps[key] === "FAILED" ? "失败" : "未执行"}`,
            )
            .join("；")}
        </p>
      )}
      {typeof details.requestPath === "string" ? (
        <p>
          失败接口：POST {details.requestPath}
          {typeof details.httpStatus === "number" ? ` · HTTP ${details.httpStatus}` : ""}
        </p>
      ) : null}
      {typeof details.upstreamStage === "string" ? (
        <p>供应商阶段：{details.upstreamStage}</p>
      ) : null}
      {typeof details.requestId === "string" ? <p>供应商请求编号：{details.requestId}</p> : null}
      {qualification.status === "FAILED" && qualification.textLatencyMs !== null ? (
        <p>文案调用已完成，可能已计费。完整重试会重新调用文案，请先排除生图接口问题。</p>
      ) : null}
    </div>
  );
}

function notificationLabel(status: string): string {
  return (
    (
      {
        SENT: "已提交邮件服务，已通知平台管理员",
        PENDING: "等待发送",
        SENDING: "发送中",
        FAILED: "发送失败，系统将重试",
        UNCONFIGURED: "未配置接收邮箱或 SMTP，请到通知设置中配置",
        EXHAUSTED: "多次发送失败，请修复通知配置后重试",
      } as Record<string, string>
    )[status] ?? "等待确认"
  );
}
