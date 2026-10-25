"use client";

import type { components } from "@xhs-agentic/contracts";
import Image from "next/image";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { StatusBadge } from "../../components/saas-shell";
import { copyBrowserText as writeClipboard } from "../../lib/browser-capabilities";
import {
  distributionTaskLabel,
  distributionTaskTiming,
  distributionTaskTone,
  isCurrentDistributionTask,
} from "../../lib/business-language";
import { apiRequest, bindEmployeePhone, storageObjectUrl } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type EmployeeTask = components["schemas"]["EmployeeTaskDto"];

export default function EmployeeMvpPage() {
  const auth = useMvpSession();
  const [tasks, setTasks] = useState<EmployeeTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [publicationUrl, setPublicationUrl] = useState("");
  const [phone, setPhone] = useState("13600000001");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskView, setTaskView] = useState<"CURRENT" | "HISTORY">("CURRENT");

  const load = useCallback(async () => {
    if (!auth.session) return;
    setError(null);
    try {
      const rows = await apiRequest<EmployeeTask[]>("/employee/tasks", {
        token: auth.session.employeeToken,
      });
      setTasks(rows);
      setSelectedId((current) => {
        if (current && rows.some(({ id }) => id === current)) return current;
        return (
          rows.find(({ status }) => isCurrentDistributionTask(status))?.id ?? rows[0]?.id ?? null
        );
      });
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session]);

  useEffect(() => {
    if (auth.session) setPhone(auth.session.employeePhone);
    void load();
  }, [auth.session, load]);

  const currentTasks = useMemo(
    () => tasks.filter(({ status }) => isCurrentDistributionTask(status)),
    [tasks],
  );
  const historyTasks = useMemo(
    () => tasks.filter(({ status }) => !isCurrentDistributionTask(status)),
    [tasks],
  );
  const visibleTasks = taskView === "CURRENT" ? currentTasks : historyTasks;
  const selected = useMemo(
    () => visibleTasks.find(({ id }) => id === selectedId) ?? visibleTasks[0] ?? null,
    [selectedId, visibleTasks],
  );

  async function selectTask(task: EmployeeTask) {
    setError(null);
    setSelectedId(task.id);
    setPublicationUrl("");
    setNotice(null);
    if (task.status === "AVAILABLE") {
      try {
        const viewed = await apiRequest<EmployeeTask>(`/employee/tasks/${task.id}/view`, {
          method: "POST",
          token: auth.session?.employeeToken,
        });
        setTasks((rows) => rows.map((row) => (row.id === viewed.id ? viewed : row)));
      } catch (reason) {
        setError(messageOf(reason));
      }
    }
  }

  async function copyContent() {
    if (!selected?.content || !auth.session) return;
    setNotice(null);
    const value = `${selected.content.title}\n\n${selected.content.body}\n\n${selected.content.hashtags
      .map((tag) => `#${tag}`)
      .join(" ")}`;
    await writeClipboard(value);
    await apiRequest(`/employee/tasks/${selected.id}/events`, {
      body: { type: "COPY" },
      method: "POST",
      token: auth.session.employeeToken,
    });
    setNotice("文案已复制，并记录复制事件");
    await load();
  }

  async function downloadImage() {
    if (!selected?.content?.images[0] || !auth.session) return;
    setNotice(null);
    const link = document.createElement("a");
    link.href = storageObjectUrl(selected.content.images[0].imageUrl);
    link.download = `${selected.campaign.title}-独立图片.svg`;
    link.click();
    await apiRequest(`/employee/tasks/${selected.id}/events`, {
      body: { type: "DOWNLOAD" },
      method: "POST",
      token: auth.session.employeeToken,
    });
    setNotice("独立图片已保存，并记录下载事件");
  }

  async function createFixture() {
    if (!selected || !auth.session) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fixture = await apiRequest<components["schemas"]["DevelopmentPublicationResponseDto"]>(
        `/employee/tasks/${selected.id}/dev-publication`,
        {
          body: { contentMode: "MATCH" },
          method: "POST",
          token: auth.session.employeeToken,
        },
      );
      setPublicationUrl(fixture.normalizedUrl);
      setNotice("本机测试链接已生成，现在可以测试提交流程");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submitPublication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !auth.session) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<components["schemas"]["PublicationSubmissionResultDto"]>(
        `/employee/tasks/${selected.id}/submissions`,
        {
          body: { url: publicationUrl },
          method: "POST",
          token: auth.session.employeeToken,
        },
      );
      setNotice(
        result.status === "VALID"
          ? "发布内容已通过链接去重、正文与独立图片匹配"
          : result.failureReason || "链接已提交，正在核实公开内容",
      );
      if (result.status === "VALID") {
        setTaskView("HISTORY");
        setSelectedId(selected.id);
      }
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function bindPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await bindEmployeePhone(auth.session, phone);
      auth.setSession(session);
      setSelectedId(null);
      setNotice("手机号已重新绑定；同一自然人在不同企业的任务会分别显示");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  if (auth.session === undefined) return <EmployeeLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }
  return (
    <main className="employeeMvp">
      <header className="employeeMvpHeader">
        <div>
          <h1>明澈内容助手</h1>
          <p>这里只展示本人收到的任务和本人提交后的数据。</p>
        </div>
        <div className="toolbar">
          <button className="ghostButton" onClick={() => void load()} type="button">
            刷新任务
          </button>
        </div>
      </header>

      <section className="employeeIdentityBar">
        <div>
          <span>当前手机号</span>
          <strong>{auth.session.employeePhone}</strong>
        </div>
        <form onSubmit={(event) => void bindPhone(event)}>
          <label>
            <span>绑定 / 加入其他企业</span>
            <input
              inputMode="tel"
              maxLength={11}
              onChange={(event) => setPhone(event.target.value)}
              pattern="1[3-9][0-9]{9}"
              required
              value={phone}
            />
          </label>
          <button className="ghostButton" disabled={busy} type="submit">
            重新绑定
          </button>
        </form>
      </section>

      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}

      <section className="employeeMvpGrid">
        <aside className="employeeTaskRail">
          <div className="miniGreeting">
            <small>你好，{auth.session.employeePhone}</small>
            <h2>{currentTasks.length} 项当前任务</h2>
          </div>
          <div className="miniTabs">
            <button
              className={taskView === "CURRENT" ? "active" : ""}
              onClick={() => {
                setTaskView("CURRENT");
                setSelectedId(currentTasks[0]?.id ?? null);
              }}
              type="button"
            >
              当前任务 {currentTasks.length}
            </button>
            <button
              className={taskView === "HISTORY" ? "active" : ""}
              onClick={() => {
                setTaskView("HISTORY");
                setSelectedId(historyTasks[0]?.id ?? null);
              }}
              type="button"
            >
              历史记录 {historyTasks.length}
            </button>
          </div>
          <div className="employeeTaskList">
            {visibleTasks.map((task) => (
              <button
                className={task.id === selected?.id ? "selected" : ""}
                data-task-id={task.id}
                key={task.id}
                onClick={() => void selectTask(task)}
                type="button"
              >
                <span>
                  <StatusBadge tone={distributionTaskTone(task.status)}>
                    {distributionTaskLabel(task.status)}
                  </StatusBadge>
                  <small>{task.enterprise.name}</small>
                </span>
                <strong>{task.campaign.title}</strong>
                <small>{distributionTaskTiming(task)}</small>
              </button>
            ))}
          </div>
          {visibleTasks.length === 0 ? (
            <div className="emptyState compact">
              <h3>{taskView === "CURRENT" ? "当前没有待处理任务" : "还没有历史记录"}</h3>
              <p>
                {taskView === "CURRENT"
                  ? "新的专属内容会在企业安排的开放时间出现在这里。"
                  : "完成、失效或取消的任务会保存在这里。"}
              </p>
            </div>
          ) : null}
        </aside>

        <article className="employeeTaskDetail">
          {selected ? (
            <>
              <div className="employeeDetailHead">
                <div>
                  <span>{selected.enterprise.name}</span>
                  <h2>{selected.campaign.title}</h2>
                </div>
                <StatusBadge tone={distributionTaskTone(selected.status)}>
                  {distributionTaskLabel(selected.status)}
                </StatusBadge>
              </div>
              {!isCurrentDistributionTask(selected.status) ? (
                <TaskHistorySummary task={selected} />
              ) : !selected.contentVisible || !selected.content ? (
                <div className="lockedContent">
                  <b>锁</b>
                  <h3>专属素材尚未开放</h3>
                  <p>开放时间：{formatDate(selected.visibleAt)}</p>
                </div>
              ) : (
                <>
                  {selected.status === "AVAILABLE" && selected.submissionFailureReason ? (
                    <div className="employeeRepairNotice" role="alert">
                      <b>!</b>
                      <div>
                        <h3>上次提交未通过，请修正后重试</h3>
                        <p>{employeeFailureReason(selected.submissionFailureReason)}</p>
                      </div>
                    </div>
                  ) : null}
                  <div className="employeeContentGrid">
                    <div className="employeeImageCard">
                      {selected.content.images[0] ? (
                        <Image
                          alt="本员工独立生成图片"
                          height={selected.content.images[0].height}
                          src={storageObjectUrl(selected.content.images[0].imageUrl)}
                          unoptimized
                          width={selected.content.images[0].width}
                        />
                      ) : null}
                      {canUseContentActions(selected) ? (
                        <button
                          className="ghostButton block"
                          onClick={() => void downloadImage()}
                          type="button"
                        >
                          保存独立图片
                        </button>
                      ) : null}
                    </div>
                    <div className="employeeCopyCard">
                      <h3>{selected.content.title}</h3>
                      <p>{selected.content.body}</p>
                      <div className="hashtagRow">
                        {selected.content.hashtags.map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </div>
                      {canUseContentActions(selected) ? (
                        <button
                          className="primaryButton block"
                          onClick={() => void copyContent()}
                          type="button"
                        >
                          复制完整文案
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {canSubmit(selected) ? (
                    <form
                      className="publicationForm"
                      onSubmit={(event) => void submitPublication(event)}
                    >
                      <div>
                        <span className="sectionKicker">最后一步</span>
                        <h3>回填发布链接</h3>
                        <p>不校验账号归属，只校验链接唯一性、发布正文和独立图片是否正确。</p>
                      </div>
                      <label className="field">
                        <span>小红书发布链接或分享文本</span>
                        <textarea
                          minLength={8}
                          onChange={(event) => setPublicationUrl(event.target.value)}
                          placeholder="粘贴 https://www.xiaohongshu.com/explore/..."
                          required
                          rows={3}
                          value={publicationUrl}
                        />
                      </label>
                      <details className="developmentTools">
                        <summary>开发测试工具</summary>
                        <button
                          className="ghostButton"
                          disabled={busy}
                          onClick={() => void createFixture()}
                          type="button"
                        >
                          生成本机测试链接
                        </button>
                      </details>
                      <div className="dualActions singleAction">
                        <button className="primaryButton" disabled={busy} type="submit">
                          提交发布链接
                        </button>
                      </div>
                    </form>
                  ) : selected.status === "VERIFYING" ? (
                    <div className="publicationReviewPending">
                      <b>审</b>
                      <div>
                        <h3>链接正在核实</h3>
                        <p>你已按时提交，无需重复提交；系统或人工核实期间不会被记为未完成。</p>
                      </div>
                    </div>
                  ) : (
                    <PublicationSuccess task={selected} />
                  )}
                </>
              )}
            </>
          ) : (
            <div className="lockedContent">
              <b>✓</b>
              <h3>{taskView === "CURRENT" ? "当前没有需要处理的任务" : "还没有历史记录"}</h3>
              <p>
                {taskView === "CURRENT"
                  ? "新的专属图文会在企业安排的开放时间出现在这里。"
                  : "完成、失效或取消的任务会保存在这里。"}
              </p>
            </div>
          )}
        </article>
      </section>
    </main>
  );
}

function PublicationSuccess({ task }: Readonly<{ task: EmployeeTask }>) {
  const metric = task.publication?.latestMetrics;
  return (
    <div className="publicationSuccess">
      <b>✓</b>
      <div>
        <h3>{task.status === "LATE_CORRECTED" ? "逾期发布已核实" : "发布已验证"}</h3>
        <a href={task.publication?.normalizedUrl} rel="noreferrer" target="_blank">
          {task.publication?.normalizedUrl}
        </a>
      </div>
      <dl>
        <div>
          <dt>阅读</dt>
          <dd>{metric?.views ?? "待采集"}</dd>
        </div>
        <div>
          <dt>点赞</dt>
          <dd>{metric?.likes ?? "—"}</dd>
        </div>
        <div>
          <dt>收藏</dt>
          <dd>{metric?.favorites ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

function TaskHistorySummary({ task }: Readonly<{ task: EmployeeTask }>) {
  if (["COMPLETED", "LATE_CORRECTED"].includes(task.status)) {
    return <PublicationSuccess task={task} />;
  }
  const cancelled = task.status === "CANCELLED";
  return (
    <div className={`taskHistorySummary ${cancelled ? "cancelled" : "expired"}`}>
      <b>{cancelled ? "×" : "!"}</b>
      <div>
        <h3>{cancelled ? "本期任务已取消" : "本期未按时提交发布链接"}</h3>
        <p>
          {cancelled
            ? "企业已经停止本期活动，你无需再复制、发布或提交链接。"
            : "员工开放后 24 小时内没有提交发布链接，本期已记为未完成。"}
        </p>
        <small>{distributionTaskTiming(task)}</small>
      </div>
    </div>
  );
}

function canSubmit(task: EmployeeTask): boolean {
  return task.status === "AVAILABLE" && new Date(task.expiresAt).getTime() > Date.now();
}

function canUseContentActions(task: EmployeeTask): boolean {
  return task.status === "AVAILABLE";
}

function employeeFailureReason(reason: string | null): string {
  if (!reason) return "系统未能确认这条链接与本次专属图文一致。";
  if (/[\u4e00-\u9fff]/u.test(reason)) return reason;
  if (reason.includes("already been claimed") || reason.includes("claimed concurrently")) {
    return "这个链接已经被其他任务使用，请提交本人本次发布的新链接。";
  }
  if (reason.includes("image does not match")) {
    return "发布图片不是本任务分配给你的独立图片，请更换后重新发布并提交新链接。";
  }
  if (reason.includes("text match score")) {
    return "发布正文与本任务文案差异较大，请使用完整文案重新发布并提交新链接。";
  }
  return "系统未能确认发布内容与本次专属图文一致，请核对文案、图片和链接后重新提交。";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

function EmployeeLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <h1>正在读取本人任务…</h1>
      </section>
    </main>
  );
}
