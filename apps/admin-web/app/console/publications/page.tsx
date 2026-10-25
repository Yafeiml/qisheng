"use client";

import type { components } from "@xhs-agentic/contracts";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage, useFeedbackToast } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import {
  apiRequest,
  type CursorPage,
  consoleNavigationPermissions,
  cursorPagePath,
  selectedAdminRoleName,
  storageObjectUrl,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type PublicationReview = Omit<components["schemas"]["PublicationReviewDto"], "task"> & {
  task: components["schemas"]["PublicationReviewDto"]["task"] & {
    campaign?: { selectionSnapshot?: unknown };
  };
};

export default function PublicationReviewsPage() {
  return (
    <Suspense fallback={<PublicationReviewsLoading />}>
      <PublicationReviewsContent />
    </Suspense>
  );
}

function PublicationReviewsContent() {
  const auth = useMvpSession();
  const { notify } = useFeedbackToast();
  const reasonInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const taskId = useSearchParams().get("taskId");
  const loadSequence = useRef(0);
  const [reviews, setReviews] = useState<PublicationReview[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [authors, setAuthors] = useState<
    Record<string, { authorId: string; authorEvidence: string }>
  >({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null = null) => {
      if (!auth.session) return;
      const sequence = ++loadSequence.current;
      setLoading(true);
      setError(null);
      try {
        const page = await apiRequest<CursorPage<PublicationReview>>(
          `${cursorPagePath(
            `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/publication-reviews`,
            cursor,
            30,
          )}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ""}`,
          { token: auth.session.adminToken },
        );
        if (sequence !== loadSequence.current) return;
        setReviews((current) => (cursor ? [...current, ...page.items] : [...page.items]));
        setNextCursor(page.pageInfo.nextCursor);
        setReasons((current) => ({
          ...Object.fromEntries(
            page.items.map((review) => [
              review.id,
              review.status === "UNAVAILABLE"
                ? "验真服务恢复后重新获取公开内容"
                : "已核对公开正文、图片和任务专属内容",
            ]),
          ),
          ...current,
        }));
      } catch (reason) {
        if (sequence === loadSequence.current) setError(messageOf(reason));
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
    },
    [auth.session, taskId],
  );

  useEffect(() => {
    setReviews([]);
    setNextCursor(null);
    void load();
  }, [load]);

  const permissions = useMemo(
    () => (auth.session ? consoleNavigationPermissions(auth.session) : []),
    [auth.session],
  );
  const canApprove = permissions.includes("campaign.approve");
  const unavailableCount = reviews.filter(({ status }) => status === "UNAVAILABLE").length;
  const manualCount = reviews.filter(({ status }) => status === "MANUAL_REVIEW").length;

  async function decide(review: PublicationReview, decision: "REJECTED" | "VERIFIED") {
    if (!auth.session) return;
    const reason = reasons[review.id]?.trim() ?? "";
    if (reason.length < 2) {
      notify({
        tone: "error",
        content: "复核前请填写至少 2 个字的判断依据",
        field: reasonInputs.current[review.id] ?? null,
      });
      return;
    }
    const author = authors[review.id];
    const medical = Boolean(review.task.campaign?.selectionSnapshot);
    if (
      medical &&
      decision === "VERIFIED" &&
      (!author ||
        !/^[a-zA-Z0-9_-]{6,100}$/u.test(author.authorId.trim()) ||
        author.authorEvidence.trim().length < 4)
    ) {
      notify({
        tone: "error",
        content: "医疗发布请由企业核对实际发布者平台 ID，并填写至少 4 个字的员工归属依据。",
      });
      return;
    }
    setBusyId(review.id);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/publication-reviews/${review.id}`,
        {
          body: {
            decision,
            reason,
            ...(medical && decision === "VERIFIED" && author
              ? { authorId: author.authorId.trim(), authorEvidence: author.authorEvidence.trim() }
              : {}),
          },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setNotice(
        decision === "VERIFIED" ? "该发布已核实为有效" : "该提交已驳回，员工可在有效期内重新提交",
      );
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function retry(review: PublicationReview) {
    if (!auth.session) return;
    const reason = reasons[review.id]?.trim() ?? "";
    if (reason.length < 2) {
      notify({
        tone: "error",
        content: "重试前请填写至少 2 个字的原因",
        field: reasonInputs.current[review.id] ?? null,
      });
      return;
    }
    setBusyId(review.id);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<components["schemas"]["PublicationSubmissionResultDto"]>(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/publication-reviews/${review.id}/retry`,
        {
          body: { reason },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setNotice(
        result.status === "VALID"
          ? "重新获取后已自动通过"
          : result.failureReason || "新的验真尝试已完成，请查看最新状态",
      );
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  if (auth.session === undefined) return <PublicationReviewsLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  return (
    <SaasShell
      active="publications"
      description="核对公开链接、正文、事实与任务图片；医疗发布由企业核实实际作者和员工归属。"
      mode="console"
      navigationPermissions={permissions}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="发布验真"
      toolbar={
        <button
          className="ghostButton refreshButton"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? "刷新中…" : "刷新队列"}
        </button>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}

      <section className="metricGrid four">
        <Metric
          detail={taskId ? "当前员工任务的提交与核实结果" : "需要人工判断或重新获取"}
          label={taskId ? "发布记录" : "待处理"}
          value={reviews.length}
          tone="accent"
        />
        <Metric detail="人工复核模式或自动核验需人工确认" label="人工复核" value={manualCount} />
        <Metric detail="外部服务或公开页面暂时不可用" label="等待重试" value={unavailableCount} />
        <Metric
          detail="策略随每次尝试冻结版本"
          label="当前策略"
          value={uniquePolicyCount(reviews)}
        />
      </section>

      <section className="panel reviewQueuePanel">
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">PUBLICATION VERIFICATION</span>
            <h2>{taskId ? "员工发布核实记录" : "待核实发布"}</h2>
            <p>系统故障不会处罚已按时提交的员工；人工确认和重试都会保留完整审计记录。</p>
          </div>
          <StatusBadge tone={taskId ? "neutral" : reviews.length > 0 ? "warning" : "success"}>
            {taskId
              ? `${reviews.length} 条记录`
              : reviews.length > 0
                ? `${reviews.length} 项待处理`
                : "队列已清空"}
          </StatusBadge>
        </div>

        <div className="reviewQueue">
          {reviews.map((review) => {
            const snapshot = review.task.employeeContent.audienceSnapshot;
            const expectedImage = review.task.employeeContent.images[0];
            const state = publicationReviewStatus(review.status);
            const actionable =
              ["MANUAL_REVIEW", "UNAVAILABLE"].includes(review.status) &&
              !["COMPLETED", "LATE_CORRECTED", "CANCELLED"].includes(review.task.status);
            return (
              <article key={review.id}>
                <div className="reviewQueueIdentity">
                  <span>{snapshot.employeeName}</span>
                  <small>{maskPhone(snapshot.employeePhone)}</small>
                </div>
                <div>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                  <p>{review.failureReason ?? state.label}</p>
                </div>
                <a
                  href={review.resolvedUrl ?? review.normalizedUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {review.resolvedUrl ?? review.normalizedUrl}
                </a>
                {actionable ? (
                  <>
                    {review.task.campaign?.selectionSnapshot ? (
                      <div className="publicationAuthorCheck">
                        <p>企业核对实际发布者和员工归属；仅确认普通发布归属，不升级行业资格。</p>
                        <label className="reviewReasonField">
                          <span>实际发布者平台 ID</span>
                          <input
                            value={authors[review.id]?.authorId ?? ""}
                            maxLength={100}
                            disabled={!canApprove || busyId !== null}
                            onChange={(event) =>
                              setAuthors((current) => ({
                                ...current,
                                [review.id]: {
                                  authorId: event.target.value,
                                  authorEvidence: current[review.id]?.authorEvidence ?? "",
                                },
                              }))
                            }
                          />
                        </label>
                        <label className="reviewReasonField">
                          <span>核对员工归属的依据</span>
                          <input
                            value={authors[review.id]?.authorEvidence ?? ""}
                            maxLength={500}
                            disabled={!canApprove || busyId !== null}
                            onChange={(event) =>
                              setAuthors((current) => ({
                                ...current,
                                [review.id]: {
                                  authorEvidence: event.target.value,
                                  authorId: current[review.id]?.authorId ?? "",
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                    ) : null}
                    <label className="reviewReasonField">
                      <span>复核或重试依据</span>
                      <input
                        ref={(element) => {
                          reasonInputs.current[review.id] = element;
                        }}
                        disabled={!canApprove || busyId !== null}
                        maxLength={500}
                        onChange={(event) =>
                          setReasons((current) => ({ ...current, [review.id]: event.target.value }))
                        }
                        value={reasons[review.id] ?? ""}
                      />
                    </label>
                    <div className="reviewQueueActions">
                      <button
                        className="ghostButton"
                        disabled={!canApprove || busyId !== null}
                        onClick={() => void retry(review)}
                        type="button"
                      >
                        重新获取
                      </button>
                      <button
                        className="dangerButton"
                        disabled={!canApprove || busyId !== null}
                        onClick={() => void decide(review, "REJECTED")}
                        type="button"
                      >
                        驳回
                      </button>
                      <button
                        className="primaryButton"
                        disabled={!canApprove || busyId !== null}
                        onClick={() => void decide(review, "VERIFIED")}
                        type="button"
                      >
                        核实有效
                      </button>
                    </div>
                  </>
                ) : null}
                <details className="reviewExpectedContent" open={Boolean(taskId)}>
                  <summary>对照专属图文与公开证据</summary>
                  <div>
                    {expectedImage ? (
                      <Image
                        alt={`${snapshot.employeeName}的专属图片`}
                        height={expectedImage.height}
                        src={storageObjectUrl(expectedImage.imageUrl)}
                        unoptimized
                        width={expectedImage.width}
                      />
                    ) : (
                      <span />
                    )}
                    <div>
                      <strong>{review.task.employeeContent.title}</strong>
                      <p>{review.task.employeeContent.body}</p>
                      <small>
                        正文 {formatScore(review.textSimilarityScore)} · 图片{" "}
                        {formatScore(review.imageSimilarityScore)} · 数字事实{" "}
                        {formatScore(review.factMatchScore)} · 尝试 #{review.verificationAttempt}
                      </small>
                      {review.extractedTitle || review.extractedBody ? (
                        <p>
                          公开内容：{review.extractedTitle ?? "无标题"} ·{" "}
                          {review.extractedBody ?? "未取得正文"}
                        </p>
                      ) : null}
                      {review.extractedImageUrls.length > 0 ? (
                        <small>已取得 {review.extractedImageUrls.length} 张公开图片证据</small>
                      ) : null}
                    </div>
                  </div>
                </details>
              </article>
            );
          })}
          {reviews.length === 0 && !loading ? (
            <div className="emptyState compact">
              {taskId
                ? "该员工暂无可查看的发布核实记录。"
                : "当前没有需要人工处理的发布记录。自动通过、重复和明显不匹配会由系统直接处置。"}
            </div>
          ) : null}
          {nextCursor ? (
            <button
              className="ghostButton"
              disabled={loading}
              onClick={() => void load(nextCursor)}
              type="button"
            >
              {loading ? "加载中…" : "加载更多"}
            </button>
          ) : null}
        </div>
      </section>

      {taskId && reviews[0] ? (
        <Link
          className="ghostButton backButton"
          href={`/console/campaigns/${reviews[0].task.campaignId}`}
        >
          返回活动详情
        </Link>
      ) : null}

      {!canApprove ? (
        <div className="inlineWarning">
          当前角色可以查看复核依据，但没有核实、驳回或重新获取权限。
        </div>
      ) : null}
    </SaasShell>
  );
}

function publicationReviewStatus(status: PublicationReview["status"]): {
  label: string;
  tone: "danger" | "neutral" | "success" | "warning";
} {
  const labels = {
    VALID: "发布已核实",
    INVALID: "内容不匹配",
    DUPLICATE: "链接重复",
    MANUAL_REVIEW: "等待人工核实",
    UNAVAILABLE: "公开内容暂不可用",
    PENDING: "等待核验",
    VERIFYING: "正在核验",
    SUPERSEDED: "已被后续提交替代",
  };
  return {
    label: labels[status],
    tone:
      status === "VALID"
        ? "success"
        : ["INVALID", "DUPLICATE", "UNAVAILABLE"].includes(status)
          ? "danger"
          : status === "SUPERSEDED"
            ? "neutral"
            : "warning",
  };
}

function Metric({
  detail,
  label,
  tone,
  value,
}: Readonly<{ detail: string; label: string; tone?: string; value: number }>) {
  return (
    <article className={`metricCard ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function formatScore(value: number | null): string {
  return value === null ? "待确认" : `${Math.round(value * 100)}%`;
}

function uniquePolicyCount(reviews: readonly PublicationReview[]): number {
  return new Set(reviews.map(({ verificationPolicyVersion }) => verificationPolicyVersion)).size;
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}

function PublicationReviewsLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          PUBLICATION VERIFICATION
        </span>
        <h1 suppressHydrationWarning>正在读取发布验真队列…</h1>
      </section>
    </main>
  );
}
