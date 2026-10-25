"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ActionConfirmDialog } from "../../components/action-confirm-dialog";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { apiRequest, type CursorPage, platformNavigationPermissions } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";
import styles from "./processing-issues.module.css";

type ProcessingIssue = components["schemas"]["ProcessingIssueDto"];
type IssueStatus = ProcessingIssue["status"];

const statusLabels: Record<IssueStatus, string> = {
  NEEDS_ADMIN: "需要管理员处理",
  NEEDS_USER: "需要用户修改",
  AUTO_RETRYING: "正在重新处理",
  RESOLVED: "已结束",
};
const stageLabels: Record<ProcessingIssue["stage"], string> = {
  ANALYSIS: "资料理解",
  EMBEDDING: "向量检索",
  FILE: "读取原文件",
  STORAGE: "资料存储",
  SYSTEM: "系统处理",
};
const settingsPaths = new Set([
  "/platform/models",
  "/platform/settings/storage",
  "/platform/settings/worker",
  "/platform/settings/retrieval",
  "/platform/operations",
]);

export default function ProcessingIssuesPage() {
  const auth = useMvpSession();
  const permissions = auth.session ? platformNavigationPermissions(auth.session) : [];
  const canRead = permissions.includes("platform.monitor.read");
  const canManage = permissions.includes("platform.monitor.manage");
  const sequence = useRef(0);
  const [items, setItems] = useState<ProcessingIssue[]>([]);
  const [status, setStatus] = useState<IssueStatus | "ALL">("NEEDS_ADMIN");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProcessingIssue | null>(null);
  const [pendingRetry, setPendingRetry] = useState<ProcessingIssue | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: string | null = null) => {
      if (!auth.session || !canRead) return;
      const requestSequence = ++sequence.current;
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({ status });
        if (search) query.set("search", search);
        if (next) query.set("cursor", next);
        const result = await apiRequest<CursorPage<ProcessingIssue>>(
          `/platform/processing-issues?${query}`,
          { token: auth.session.platformToken },
        );
        if (requestSequence !== sequence.current) return;
        setItems((current) => (next ? [...current, ...result.items] : [...result.items]));
        setCursor(result.pageInfo.nextCursor);
        setSelected((current) =>
          current
            ? (result.items.find((item) => item.id === current.id) ?? (next ? current : null))
            : null,
        );
      } catch (reason) {
        if (requestSequence === sequence.current) setError(messageOf(reason));
      } finally {
        if (requestSequence === sequence.current) setLoading(false);
      }
    },
    [auth.session, canRead, status, search],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setSelected(null);
    setPendingRetry(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!canRead || busyId !== null || pendingRetry || cursor) return;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [canRead, busyId, pendingRetry, cursor, load]);

  async function retry(issue: ProcessingIssue, reason: string) {
    if (!auth.session || !canManage || !issue.canRetry) return;
    setBusyId(issue.id);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/platform/processing-issues/materials/${issue.resourceId}/retry`, {
        body: { ingestionJobId: issue.id, reason },
        method: "POST",
        token: auth.session.platformToken,
      });
      setNotice("已重新安排素材处理，可以在“正在重新处理”中跟进结果。");
      setPendingRetry(null);
      setSelected(null);
      await load();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusyId(null);
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelected(null);
    const nextSearch = searchDraft.trim();
    if (nextSearch === search) void load();
    else setSearch(nextSearch);
  }

  if (auth.session === undefined)
    return (
      <main className="setupScreen">
        <h1>正在读取处理异常…</h1>
      </main>
    );
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;

  return (
    <SaasShell
      active="processing-issues"
      description="查看素材处理异常的用户和企业归属、失败原因及处理建议。修复后重新处理，跟进后续结果。"
      mode="platform"
      navigationPermissions={permissions}
      title="处理异常"
      toolbar={
        <button
          className={`ghostButton ${styles.refresh}`}
          disabled={loading || busyId !== null}
          onClick={() => void load()}
          type="button"
        >
          {loading ? "正在刷新…" : "刷新异常"}
        </button>
      }
    >
      {!canRead ? <div className="inlineWarning">当前账号没有查看处理异常的权限。</div> : null}
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <section className={styles.explanation}>
        <strong>需要您处理的问题会自动汇总在这里</strong>
        <p>
          模型和系统问题交由平台管理员处理；文件、格式或内容问题会给用户明确的修改指引。
          可按用户、企业或资料查找，查看处理建议后跟进解决。
        </p>
        <Link href="/platform/settings/notification">返回通知设置</Link>
      </section>
      {canRead ? (
        <>
          <form className={styles.filters} onSubmit={submitSearch}>
            <label className={styles.filter}>
              <span>异常状态</span>
              <select
                aria-label="异常状态"
                value={status}
                disabled={busyId !== null}
                onChange={(event) => {
                  setSelected(null);
                  setStatus(event.target.value as IssueStatus | "ALL");
                }}
              >
                <option value="NEEDS_ADMIN">需要管理员处理</option>
                <option value="NEEDS_USER">需要用户修改</option>
                <option value="AUTO_RETRYING">正在重新处理</option>
                <option value="RESOLVED">已结束</option>
                <option value="ALL">全部异常记录</option>
              </select>
            </label>
            <label className={styles.search}>
              <span>查找异常</span>
              <input
                aria-label="搜索用户、企业或资料"
                maxLength={160}
                placeholder="用户、企业、资料名称或编号"
                type="search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </label>
            <button className={styles.button} disabled={loading || busyId !== null} type="submit">
              查询
            </button>
          </form>
          {loading && !items.length ? <p role="status">正在加载异常记录…</p> : null}
          {!loading && !items.length ? (
            <section className={styles.empty}>
              <strong>{search ? "没有找到匹配的异常" : "当前没有符合条件的异常"}</strong>
              <p>可以调整状态筛选或搜索条件。</p>
            </section>
          ) : null}
          <div className={styles.list}>
            {items.map((issue) => (
              <article className={styles.card} data-testid="processing-issue" key={issue.id}>
                <div className={styles.heading}>
                  <div>
                    <small>素材处理 · {stageLabels[issue.stage]}</small>
                    <h2>{issue.resourceTitle || "未命名资料"}</h2>
                  </div>
                  <StatusBadge tone={issueTone(issue.status)}>
                    {statusLabels[issue.status]}
                  </StatusBadge>
                </div>
                <dl className={styles.context}>
                  <div>
                    <dt>客户</dt>
                    <dd>{issue.tenant.name}</dd>
                  </div>
                  <div>
                    <dt>企业</dt>
                    <dd>{issue.enterprise?.name ?? "集团共享资料"}</dd>
                  </div>
                  <div>
                    <dt>提交用户</dt>
                    <dd>{actorLabel(issue)}</dd>
                  </div>
                  <div>
                    <dt>发生时间</dt>
                    <dd>{formatTime(issue.occurredAt)}</dd>
                  </div>
                </dl>
                <p className={styles.reason}>{issue.reason}</p>
                {issue.resolutionNote ? (
                  <p className={styles.resolution}>{issue.resolutionNote}</p>
                ) : null}
                <div className={styles.actions}>
                  <button
                    className={styles.button}
                    type="button"
                    onClick={() => setSelected(issue)}
                  >
                    查看处理建议
                  </button>
                  <small>
                    {issue.attemptCount} / {issue.maxAttempts} 次处理尝试
                  </small>
                </div>
              </article>
            ))}
          </div>
          {cursor ? (
            <button
              className={`${styles.button} ${styles.more}`}
              disabled={loading}
              onClick={() => void load(cursor)}
              type="button"
            >
              {loading ? "正在加载…" : "加载更多"}
            </button>
          ) : null}
        </>
      ) : null}
      <WorkspaceDrawer
        open={selected !== null}
        onClose={() => {
          if (!busyId) setSelected(null);
        }}
        title="异常处理详情"
        description="确认失败原因和处理建议，修复后再安排处理。"
      >
        {selected ? (
          <div className={styles.detail}>
            <dl className={styles.detailContext}>
              <div>
                <dt>资料</dt>
                <dd>{selected.resourceTitle}</dd>
              </div>
              <div>
                <dt>客户 / 企业</dt>
                <dd>
                  {selected.tenant.name} / {selected.enterprise?.name ?? "集团共享"}
                </dd>
              </div>
              <div>
                <dt>提交用户</dt>
                <dd>{actorLabel(selected)}</dd>
              </div>
              <div>
                <dt>处理状态</dt>
                <dd>{statusLabels[selected.status]}</dd>
              </div>
              <div>
                <dt>失败阶段</dt>
                <dd>{stageLabels[selected.stage]}</dd>
              </div>
              <div>
                <dt>发生时间</dt>
                <dd>{formatTime(selected.occurredAt)}</dd>
              </div>
            </dl>
            <section className={styles.advice}>
              <h3>失败原因</h3>
              <p>{selected.reason}</p>
              <h3>建议处理步骤</h3>
              <ol>
                {selected.suggestedActions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ol>
              {selected.resolutionNote ? (
                <p className={styles.resolution}>{selected.resolutionNote}</p>
              ) : null}
            </section>
            <div className={styles.actions}>
              {selected.settingsPath && settingsPaths.has(selected.settingsPath) ? (
                <Link className={styles.button} href={selected.settingsPath}>
                  打开相关配置
                </Link>
              ) : null}
              {canManage && selected.canRetry ? (
                <button
                  className={`${styles.button} ${styles.primary}`}
                  disabled={busyId !== null}
                  onClick={() => setPendingRetry(selected)}
                  type="button"
                >
                  修复后重新处理
                </button>
              ) : null}
            </div>
            {selected.status === "AUTO_RETRYING" ? (
              <p role="status">任务正在重新处理，请稍后刷新跟进结果。</p>
            ) : null}
            <details className={styles.diagnostics}>
              <summary>排查信息</summary>
              <dl>
                <div>
                  <dt>资料编号</dt>
                  <dd>{selected.resourceId}</dd>
                </div>
                <div>
                  <dt>任务编号</dt>
                  <dd>{selected.id}</dd>
                </div>
                <div>
                  <dt>错误代码</dt>
                  <dd>{selected.errorCode}</dd>
                </div>
              </dl>
            </details>
          </div>
        ) : null}
      </WorkspaceDrawer>
      <ActionConfirmDialog
        busy={busyId !== null}
        onCancel={() => setPendingRetry(null)}
        onConfirm={(reason) => {
          if (pendingRetry) void retry(pendingRetry, reason);
        }}
        state={
          pendingRetry
            ? {
                confirmLabel: "确认重新处理",
                defaultReason: "管理员已检查异常原因并修复配置，重新安排素材处理",
                impacts: [
                  "将重新处理这条资料，成功后恢复用于内容生成。",
                  "原始资料和历史活动引用会继续保留。",
                ],
                reasonLabel: "处理说明",
                summary: `请确认已按处理建议修复“${pendingRetry.resourceTitle}”的失败原因。`,
                title: "重新处理这条资料？",
                tone: "warning",
              }
            : null
        }
      />
    </SaasShell>
  );
}

function actorLabel(issue: ProcessingIssue): string {
  return issue.actor
    ? [issue.actor.name || "未记录姓名", issue.actor.phoneMasked].filter(Boolean).join(" · ")
    : "未记录提交用户";
}
function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}
function issueTone(status: IssueStatus): "danger" | "warning" | "neutral" | "success" {
  return {
    NEEDS_ADMIN: "danger",
    NEEDS_USER: "warning",
    AUTO_RETRYING: "neutral",
    RESOLVED: "success",
  }[status] as "danger" | "warning" | "neutral" | "success";
}
