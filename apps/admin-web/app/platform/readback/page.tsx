"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ActionConfirmDialog,
  type ConfirmDialogState,
} from "../../components/action-confirm-dialog";
import { FeedbackMessage, useFeedbackToast } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { apiRequest, platformNavigationPermissions } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";
import styles from "./readback.module.css";

type Node = {
  id: string;
  online: boolean;
  lastSeenAt: string | null;
  panelHost: string | null;
  panelUrl: string | null;
};
type Job = {
  id: string;
  status: string;
  attempts: number;
  dueAt: string;
  updatedAt: string;
  errorCode: string | null;
  leaseOwner: string | null;
};
type Operations = {
  paused: boolean;
  reason: string | null;
  today: string;
  dailyLimit: number;
  total: number;
  queued: number;
  retrying: number;
  leased: number;
  completed: number;
  needsReview: number;
  budget: { day: string; used: number }[];
  jobs: Job[];
  onlineNodes: number;
  nodes: Node[];
};

type Configuration = {
  enabled: boolean;
  endpoint: string;
  tokenConfigured: boolean;
  verified: boolean;
  managedNodeConfigured: boolean;
  externalMode: boolean;
};

export default function ReadbackPage() {
  const auth = useMvpSession();
  const feedback = useFeedbackToast();
  const dailyLimitRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const [data, setData] = useState<Operations | null>(null);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [providerToken, setProviderToken] = useState("");
  const [configurationReason, setConfigurationReason] = useState("");
  const [sampleUrl, setSampleUrl] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sampleConfirmation, setSampleConfirmation] = useState<ConfirmDialogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const token = auth.session?.platformToken;
  const canManage = Boolean(
    auth.session &&
      platformNavigationPermissions(auth.session).includes("platform.settings.manage"),
  );
  const busy = saving || testing;
  const dirty = Boolean(
    configuration && (endpoint.trim() !== configuration.endpoint || providerToken.trim()),
  );

  const load = useCallback(async () => {
    if (!token || locked.current) return;
    setLoading(true);
    setError(null);
    try {
      const [operations, settings] = await Promise.all([
        apiRequest<Operations>("/platform/publication-readback/operations", { token }),
        canManage
          ? apiRequest<Configuration>("/platform/publication-readback/configuration", { token })
          : null,
      ]);
      setData(operations);
      setDailyLimit(String(operations.dailyLimit));
      if (settings) {
        setConfiguration(settings);
        setEndpoint(settings.endpoint);
        setProviderToken("");
      }
    } catch (issue) {
      setError(messageOf(issue));
    } finally {
      setLoading(false);
    }
  }, [token, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !configuration || locked.current) return;
    locked.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<Configuration>(
        "/platform/publication-readback/configuration",
        {
          token,
          method: "POST",
          body: {
            enabled: false,
            endpoint: endpoint.trim(),
            ...(providerToken.trim() ? { token: providerToken.trim() } : {}),
            reason: configurationReason.trim(),
          },
        },
      );
      setConfiguration(result);
      setEndpoint(result.endpoint);
      setProviderToken("");
      setNotice("配置已保存。验证样本后可按需启用自动回读；当前仍使用人工复核。");
    } catch (issue) {
      setError(messageOf(issue));
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  function requestSampleTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !configuration || dirty || locked.current) return;
    setSampleConfirmation({
      title: "确认样本验证费用",
      summary: "本次将真实查询一次笔记数据接口，可能产生供应商费用。",
      impacts: ["仅验证填写的样本，不会自动启用回读或领取发布任务。"],
      confirmLabel: "确认验证",
      reasonLabel: "验证原因",
      defaultReason: configurationReason.trim(),
    });
  }

  async function testSample(reason: string) {
    if (!token || !configuration || dirty || locked.current) return;
    if (reason.trim().length < 2 || reason.trim().length > 160) {
      feedback.notify({ tone: "error", content: "验证原因须为 2–160 个字。" });
      return;
    }
    locked.current = true;
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ success: boolean; checkedAt: string; message: string }>(
        "/platform/publication-readback/test",
        {
          token,
          method: "POST",
          body: { noteUrl: sampleUrl.trim(), reason: reason.trim() },
        },
      );
      setConfiguration(
        await apiRequest<Configuration>("/platform/publication-readback/configuration", { token }),
      );
      if (result.success) setNotice(result.message);
      else setError(result.message);
    } catch (issue) {
      setError(messageOf(issue));
    } finally {
      locked.current = false;
      setTesting(false);
      setSampleConfirmation(null);
    }
  }

  async function changeMode() {
    if (!token || !configuration || locked.current) return;
    locked.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const enabled = !configuration.enabled;
      const result = await apiRequest<Configuration>(
        "/platform/publication-readback/configuration",
        {
          token,
          method: "POST",
          body: {
            enabled,
            endpoint: configuration.endpoint,
            reason:
              configurationReason.trim() || (enabled ? "启用已验证的自动回读" : "切换为人工复核"),
          },
        },
      );
      setConfiguration(result);
      setEndpoint(result.endpoint);
      setProviderToken("");
      setNotice(
        result.enabled
          ? "自动回读已启用，新的发布回填将按计划采集。"
          : "已切换为人工复核，停止自动领取新的回读任务。",
      );
      const operations = await apiRequest<Operations>("/platform/publication-readback/operations", {
        token,
      });
      setData(operations);
    } catch (issue) {
      setError(messageOf(issue));
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  async function saveLimit() {
    if (!auth.session || locked.current) return;
    const value = Number(dailyLimit);
    const invalidLimit = !Number.isInteger(value) || value < 1 || value > 10000;
    if (invalidLimit || reason.trim().length < 2) {
      feedback.notify({
        tone: "error",
        content: "每日额度须为 1–10000 的整数，并填写至少 2 个字的变更原因。",
        field: invalidLimit ? dailyLimitRef : reasonRef,
      });
      return;
    }
    locked.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<Operations>("/platform/publication-readback/daily-limit", {
        body: { dailyLimit: value, reason: reason.trim() },
        method: "POST",
        token: auth.session.platformToken,
      });
      setData(result);
      setDailyLimit(String(result.dailyLimit));
      setReason("");
      setNotice(`每日工作单上限已更新为 ${result.dailyLimit}，变更已记录审计。`);
    } catch (issue) {
      setError(messageOf(issue));
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  if (auth.session === undefined) return null;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;

  const automatic = configuration?.enabled ?? Boolean(data && data.reason !== "READBACK_DISABLED");
  const todayUsed = data?.budget.find(({ day }) => day === data.today)?.used ?? 0;
  const overdueInRecentJobs =
    data?.jobs.filter(
      (job) => job.status === "QUEUED" && new Date(job.dueAt).getTime() < Date.now() - 3_600_000,
    ).length ?? 0;
  const needsAttention = Boolean(
    automatic &&
      data &&
      (data.paused || data.onlineNodes === 0 || overdueInRecentJobs >= 20 || data.retrying >= 10),
  );
  return (
    <SaasShell
      active="readback"
      description="默认由管理员人工复核发布回填；需要自动核验与互动数据时，再启用自动回读。"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      title="发布复核与回读"
      toolbar={
        <button
          className="ghostButton refreshButton"
          disabled={loading || busy}
          onClick={() => void load()}
          type="button"
        >
          {loading ? "同步中…" : "刷新状态"}
        </button>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <section className={`panel ${styles.modePanel}`} aria-label="发布复核方式">
        <div className="panelHeader">
          <div>
            <h2>{!data ? "发布复核方式" : automatic ? "自动回读" : "人工复核（默认）"}</h2>
            <p>
              员工回填发布链接后，由企业管理员在工作台复核。人工确认与自动核验会分别记录，不会将提交链接直接视为核验通过。
            </p>
          </div>
          <StatusBadge tone={!automatic ? "neutral" : needsAttention ? "warning" : "success"}>
            {!data
              ? loading
                ? "正在读取状态"
                : "运行状态暂不可读取"
              : !automatic
                ? "自动回读未启用（可选）"
                : data.paused
                  ? "自动回读已暂停"
                  : data.onlineNodes === 0
                    ? "等待采集服务"
                    : "自动回读运行中"}
          </StatusBadge>
        </div>
        <p className={styles.hint}>
          不启用自动回读，不影响安装、登录、内容生成和发布回填；点赞、评论、收藏不会自动更新。
        </p>
      </section>
      {needsAttention ? (
        <div className={styles.alert} role="alert">
          <strong>自动回读运行提醒</strong>
          <span>
            {data?.paused ? "自动回读暂不可领取任务；" : ""}
            {data?.onlineNodes === 0 ? "当前无在线采集服务；" : ""}
            {overdueInRecentJobs > 0 ? `${overdueInRecentJobs} 条近期任务已逾期；` : ""}
            {data && data.retrying >= 10 ? `重试工作单 ${data.retrying} 条；` : ""}
            请检查高级设置中的服务和任务记录。人工复核及其他平台功能仍可使用。
          </span>
        </div>
      ) : null}
      <section className={`panel ${styles.configuration}`} aria-label="自动回读配置">
        <div className="panelHeader">
          <div>
            <h2>自动回读（可选）</h2>
            <p>
              同机部署采集容器后，在此保存数据接口和
              Token、验证样本，再按需启用，无需单独配置节点面板。
            </p>
          </div>
        </div>
        {!canManage ? (
          <p className={styles.hint}>
            当前账号可查看运行状态；仅系统设置管理员可修改自动回读配置。
          </p>
        ) : configuration ? (
          <>
            {configuration.externalMode ? (
              <p className={styles.hint}>
                当前沿用高级独立节点配置，可暂停后恢复。保存新的供应商 Token
                后将切换为人工复核，验证后可使用同机采集服务；原节点凭据不会复制到这里。
              </p>
            ) : null}
            {!configuration.managedNodeConfigured ? (
              <p className={styles.hint}>
                同机采集服务尚未配置。可先保存接口并验证样本，再按部署说明启用可选采集容器；不需要另备服务器。
              </p>
            ) : null}
            <form
              className={styles.form}
              aria-label="保存自动回读配置"
              onSubmit={(event) => void saveConfiguration(event)}
            >
              <label className="field">
                <span>笔记数据接口</span>
                <input
                  aria-label="笔记数据接口"
                  aria-describedby="readback-endpoint-help"
                  type="url"
                  required
                  maxLength={8192}
                  value={endpoint}
                  placeholder="https://api.example.com/notes/detail"
                  disabled={busy || loading}
                  onChange={(event) => setEndpoint(event.target.value)}
                />
                <small id="readback-endpoint-help">
                  填写部署者自己的兼容 HTTPS 笔记数据接口地址；Token 单独配置。
                </small>
              </label>
              <label className="field">
                <span>供应商 Token</span>
                <input
                  aria-label="供应商 Token"
                  aria-describedby="readback-token-help"
                  type="password"
                  autoComplete="new-password"
                  maxLength={4096}
                  required={!configuration.tokenConfigured}
                  value={providerToken}
                  disabled={busy || loading}
                  placeholder={
                    configuration.tokenConfigured ? "已保存，留空沿用" : "填写自己的 Token"
                  }
                  onChange={(event) => setProviderToken(event.target.value)}
                />
                <small id="readback-token-help">
                  加密保存，不回显；仅在明确确认的样本验证或启用后的回读任务中使用。
                </small>
              </label>
              <label className="field">
                <span>配置变更原因</span>
                <input
                  type="text"
                  minLength={2}
                  maxLength={160}
                  required
                  value={configurationReason}
                  disabled={busy || loading}
                  onChange={(event) => setConfigurationReason(event.target.value)}
                  placeholder="例如：配置企业笔记回读接口"
                />
              </label>
              <button
                className="primaryButton"
                type="submit"
                disabled={
                  busy ||
                  loading ||
                  !dirty ||
                  !endpoint.trim() ||
                  (!configuration.tokenConfigured && !providerToken.trim()) ||
                  configurationReason.trim().length < 2
                }
              >
                {saving ? "保存中…" : "保存配置"}
              </button>
            </form>
            <form
              className={`${styles.form} ${styles.sampleForm}`}
              aria-label="验证自动回读样本"
              onSubmit={requestSampleTest}
            >
              <label className="field">
                <span>样本笔记链接</span>
                <input
                  type="url"
                  required
                  maxLength={8192}
                  value={sampleUrl}
                  disabled={busy || loading}
                  onChange={(event) => setSampleUrl(event.target.value)}
                  placeholder="填写有权核查的小红书公开笔记链接"
                />
              </label>
              <div className={styles.actions}>
                <button
                  className="ghostButton"
                  type="submit"
                  disabled={
                    busy ||
                    loading ||
                    dirty ||
                    !configuration.endpoint ||
                    !configuration.tokenConfigured ||
                    !sampleUrl.trim() ||
                    configurationReason.trim().length < 2
                  }
                >
                  {testing ? "验证中…" : "验证样本（可能产生费用）"}
                </button>
                <span className={styles.hint}>
                  {dirty
                    ? "请先保存修改，再验证样本。"
                    : configuration.verified
                      ? "当前配置的样本验证已通过。"
                      : "启用前需要验证当前配置的真实样本。"}
                </span>
              </div>
            </form>
            <div className={styles.modeActions}>
              <button
                className={automatic ? "ghostButton" : "primaryButton"}
                type="button"
                disabled={
                  busy ||
                  loading ||
                  (!configuration.enabled &&
                    (dirty ||
                      (!configuration.externalMode &&
                        (!configuration.verified || !configuration.managedNodeConfigured))))
                }
                onClick={() => void changeMode()}
              >
                {configuration.enabled ? "切换为人工复核" : "启用自动回读"}
              </button>
              <span className={styles.hint}>
                启用后，新的发布回填将在约 24 小时后查询笔记内容和互动指标；关闭后停止领取新任务。
              </span>
            </div>
          </>
        ) : (
          <p className={styles.hint}>
            {loading ? "正在读取配置…" : "配置暂不可读取，可刷新重试。"}
          </p>
        )}
      </section>
      <details className={`panel ${styles.advanced}`}>
        <summary>高级设置与任务记录</summary>
        <p className={styles.hint}>
          同机部署通常无需管理下列节点身份和面板地址。独立节点、请求上限和历史任务保留供维护时查看。
        </p>
        <section className="metricGrid four" aria-label="回读任务概览">
          <article className="metricCard accent">
            <span>在线节点</span>
            <strong>{data ? `${data.onlineNodes} / ${data.nodes.length}` : "—"}</strong>
            <small>90 秒内有有效签名请求</small>
          </article>
          <article className="metricCard">
            <span>今日工作单额度</span>
            <strong>{data ? `${todayUsed} / ${data.dailyLimit}` : "—"}</strong>
            <small>按 UTC 日计数 · 人工样本测试另计</small>
          </article>
          <article className="metricCard">
            <span>任务队列</span>
            <strong>{data ? `${data.queued} / ${data.leased}` : "—"}</strong>
            <small>排队 / 在途 · 重试 {data?.retrying ?? "—"}</small>
          </article>
          <article className="metricCard">
            <span>结果</span>
            <strong>{data ? `${data.completed} / ${data.needsReview}` : "—"}</strong>
            <small>完成 / 待人工复核</small>
          </article>
        </section>
        <section className={styles.layout}>
          <article className="panel">
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">NODES</span>
                <h2>采集节点</h2>
                <p>状态由主服务收到的签名请求计算，停止请求后约 90 秒标为离线。</p>
              </div>
              <StatusBadge
                tone={
                  data?.reason === "READBACK_DISABLED"
                    ? "neutral"
                    : data?.paused
                      ? "warning"
                      : data?.onlineNodes
                        ? "success"
                        : "warning"
                }
              >
                {data?.reason === "READBACK_DISABLED"
                  ? "未启用"
                  : data?.paused
                    ? `自动回读暂停${data.reason ? ` · ${data.reason}` : ""}`
                    : data?.onlineNodes
                      ? "正在运行"
                      : "等待节点"}
              </StatusBadge>
            </div>
            {data?.nodes.length ? (
              <div className={styles.nodes}>
                {data.nodes.map((node) => (
                  <div className={styles.node} key={node.id}>
                    <div className={styles.nodeTitle}>
                      <strong>{node.id}</strong>
                      <StatusBadge tone={node.online ? "success" : "warning"}>
                        {node.online ? "在线" : "离线"}
                      </StatusBadge>
                    </div>
                    <span>面板地址：{node.panelUrl ?? node.panelHost ?? "尚未上报"}</span>
                    <span>最后请求：{formatDate(node.lastSeenAt)}</span>
                    {node.panelUrl ? (
                      <a
                        className={styles.panelLink}
                        href={node.panelUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        打开节点面板 ↗
                      </a>
                    ) : (
                      <small>节点升级并完成首次签名请求后显示面板入口</small>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.empty}>
                暂无采集服务记录。同机容器启动后会自动出现，无需手工填写节点 ID。
              </p>
            )}
            <p className={styles.hint}>
              高级独立节点可在其面板管理配置；同机采集服务无需另设节点面板。
            </p>
          </article>
          <article className="panel">
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">BUDGET</span>
                <h2>工作单额度设置</h2>
                <p>所有节点共享每日领取上限；已占用次数不因调低上限而清零。</p>
              </div>
            </div>
            {!canManage ? (
              <p className={styles.hint}>仅有平台设置权限的管理员可调整额度。</p>
            ) : (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveLimit();
                }}
              >
                <label className="field">
                  <span>每日领取上限</span>
                  <input
                    ref={dailyLimitRef}
                    disabled={busy || !data}
                    inputMode="numeric"
                    max={10000}
                    min={1}
                    onChange={(event) => setDailyLimit(event.target.value)}
                    required
                    type="number"
                    value={dailyLimit}
                  />
                </label>
                <label className="field">
                  <span>额度变更原因</span>
                  <input
                    ref={reasonRef}
                    disabled={busy || !data}
                    maxLength={160}
                    minLength={2}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="例如：调整供应商日预算"
                    required
                    type="text"
                    value={reason}
                  />
                </label>
                <button
                  className="primaryButton"
                  disabled={busy || !data || reason.trim().length < 2 || !/^\d+$/u.test(dailyLimit)}
                  type="submit"
                >
                  {saving ? "保存中…" : "保存额度"}
                </button>
              </form>
            )}
            <p className={styles.hint}>
              此处记录领取额度，人工样本另计；调用费用以自行选择的供应商账单为准。
            </p>
          </article>
        </section>
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">HISTORY</span>
              <h2>最近任务</h2>
              <p>最多显示 50 条，不展示员工链接、正文或供应商 Token。</p>
            </div>
          </div>
          {data?.jobs.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>任务</th>
                    <th>到期时间</th>
                    <th>重试/尝试</th>
                    <th>更新</th>
                    <th>结果代码</th>
                  </tr>
                </thead>
                <tbody>
                  {data.jobs.map((job) => (
                    <tr key={job.id}>
                      <td>{job.status}</td>
                      <td className={styles.jobId}>{job.id}</td>
                      <td>{formatDate(job.dueAt)}</td>
                      <td>{job.attempts}</td>
                      <td>{formatDate(job.updatedAt)}</td>
                      <td>{job.errorCode ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.empty}>暂无回读工作单；只有新的提交满 24 小时后才会到期。</p>
          )}
        </section>
      </details>
      <ActionConfirmDialog
        state={sampleConfirmation}
        busy={testing}
        onCancel={() => setSampleConfirmation(null)}
        onConfirm={(reason) => void testSample(reason)}
      />
    </SaasShell>
  );
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚无记录";
}
