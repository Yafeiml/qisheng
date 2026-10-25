"use client";

import type { components } from "@xhs-agentic/contracts";
import Image from "next/image";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { EntrySwitcher } from "../components/entry-switcher";
import { FeedbackMessage } from "../components/feedback-toast";
import { PlatformName } from "../components/platform-branding";
import { SessionExitButton } from "../components/session-exit-button";
import { copyBrowserText } from "../lib/browser-capabilities";
import { distributionTaskLabel } from "../lib/business-language";
import { apiRequest, storageObjectUrl, trackedFetch } from "../lib/mvp-client";
import { messageOf, useMvpSession } from "../lib/use-mvp-session";
import styles from "./employee.module.css";

type Task = components["schemas"]["EmployeeTaskDto"];
type EmployeeSession = components["schemas"]["EmployeeTokenResponseDto"];

export default function EmployeePage() {
  const auth = useMvpSession();
  const [invite, setInvite] = useState<string | null | undefined>();
  const connectionVersion = useRef(0);
  const binding = useRef<{ key: string; promise: Promise<EmployeeSession> } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [checked, setChecked] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setInvite(new URLSearchParams(window.location.search).get("invite"));
  }, []);
  const adminToken = auth.session?.adminToken;

  const connect = useCallback(async () => {
    if (!adminToken || invite === undefined) return;
    const version = ++connectionVersion.current;
    setBusy(true);
    setError(null);
    try {
      let access: EmployeeSession;
      if (invite) {
        const key = `${adminToken}\u0000${invite}`;
        if (binding.current?.key !== key)
          binding.current = {
            key,
            promise: apiRequest<EmployeeSession>("/auth/employee/web-bind", {
              token: adminToken,
              method: "POST",
              body: { token: invite },
            }),
          };
        access = await binding.current.promise;
      } else {
        access = await apiRequest<EmployeeSession>("/auth/employee/web-session", {
          token: adminToken,
          method: "POST",
        });
      }
      if (version !== connectionVersion.current) return;
      const rows = await apiRequest<Task[]>("/employee/tasks", { token: access.accessToken });
      if (version !== connectionVersion.current) return;
      setToken(access.accessToken);
      setTasks(rows);
      if (invite) {
        window.history.replaceState(null, "", "/employee");
        setInvite(null);
      }
    } catch (failure) {
      if (version !== connectionVersion.current) return;
      if (invite) binding.current = null;
      setToken(null);
      setTasks([]);
      setSelected(null);
      setConfirmed(false);
      setError(messageOf(failure));
    } finally {
      if (version === connectionVersion.current) setBusy(false);
    }
  }, [adminToken, invite]);
  useEffect(() => {
    void connect();
    return () => {
      connectionVersion.current++;
    };
  }, [connect]);
  async function choose(task: Task) {
    if (!token) return;
    setBusy(true);
    setError(null);
    setChecked(false);
    setConfirmed(false);
    setUrl("");
    setNotice(null);
    try {
      setSelected(
        await apiRequest<Task>(
          `/employee/tasks/${task.id}${task.status === "AVAILABLE" ? "/view" : ""}`,
          { token, method: task.status === "AVAILABLE" ? "POST" : "GET" },
        ),
      );
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!selected || !token || !checked) return;
    setBusy(true);
    setConfirmed(false);
    setError(null);
    try {
      setSelected(
        await apiRequest<Task>(`/employee/tasks/${selected.id}/facts`, {
          token,
          method: "POST",
          body: { revision: selected.contentRevision, confirmed: true },
        }),
      );
      setNotice("已确认内容真实，可以复制文案、保存图片后发布。");
      setConfirmed(true);
    } catch (failure) {
      setChecked(false);
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!selected?.content || !token || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/employee/tasks/${selected.id}/events`, {
        token,
        method: "POST",
        body: { type: "COPY", revision: selected.contentRevision },
      });
      await copyBrowserText(
        `${selected.content.title}\n\n${selected.content.body}\n\n${selected.content.hashtags.map((tag) => `#${tag}`).join(" ")}`,
      );
      setNotice("文案已复制");
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  async function saveImage(imageUrl: string, index: number) {
    if (!selected || !token || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/employee/tasks/${selected.id}/events`, {
        token,
        method: "POST",
        body: { type: "DOWNLOAD", revision: selected.contentRevision },
      });
      const response = await trackedFetch(storageObjectUrl(imageUrl));
      if (!response.ok) throw new Error("图片下载失败，请重试");
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${selected.campaign.title}-${index + 1}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      setNotice("图片已保存");
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<components["schemas"]["PublicationSubmissionResultDto"]>(
        `/employee/tasks/${selected.id}/submissions`,
        {
          token,
          method: "POST",
          body: { url },
        },
      );
      if (result.status === "INVALID" || result.status === "DUPLICATE") {
        setError(result.failureReason ?? "链接未通过，请检查发布内容和链接后重试。");
        return;
      }
      setNotice(
        result.status === "VALID" ? "发布链接已确认，任务已完成。" : "发布链接已提交，等待核实。",
      );
      setSelected(null);
      await connect();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  if (auth.session === undefined)
    return (
      <main className="setupScreen">
        <p>正在读取登录状态…</p>
      </main>
    );
  if (!auth.session) {
    const returnTo = `/employee${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`;
    return (
      <main className="setupScreen">
        <section className="setupCard">
          <h1>员工发布入口</h1>
          <p>使用管理员为你创建的员工账号领取团队内容。</p>
          <div className="buttonRow">
            <Link
              className="primaryButton"
              href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
            >
              登录领取
            </Link>
          </div>
        </section>
      </main>
    );
  }
  const actionable =
    selected?.status === "AVAILABLE" && selected.contentVisible && !selected.factsReturned;
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <span>
            <PlatformName /> · 员工发布
          </span>
          <h1>我的内容任务</h1>
          <p>领取 → 确认真实 → 发布 → 回填</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.entrySwitch}>
            <EntrySwitcher current="employee" />
          </div>
          <button
            className="ghostButton"
            disabled={busy}
            onClick={() => void connect()}
            type="button"
          >
            刷新
          </button>
          <SessionExitButton />
        </div>
      </header>
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      {!token && !busy ? (
        <section className="panel">
          <h2>尚未加入发布团队</h2>
          <p>请联系管理员为你的成员档案创建网页账号，并确认任务资格已启用。</p>
        </section>
      ) : null}
      <div className={styles.grid}>
        <aside className={`panel ${styles.tasks}`}>
          <h2>任务列表</h2>
          {tasks.map((task) => (
            <button
              aria-pressed={selected?.id === task.id}
              disabled={busy}
              key={task.id}
              onClick={() => void choose(task)}
              type="button"
            >
              <strong>{task.campaign.title}</strong>
              <span>
                {task.enterprise.name} · {distributionTaskLabel(task.status)}
              </span>
            </button>
          ))}
          {token && !tasks.length ? <p>暂无任务，团队开放内容后会显示在这里。</p> : null}
        </aside>
        <section className={`panel ${styles.content}`}>
          {selected?.content ? (
            <>
              <span>
                {selected.enterprise.name} · {distributionTaskLabel(selected.status)}
              </span>
              <h2>{selected.content.title}</h2>
              <p className={styles.copy}>{selected.content.body}</p>
              <p>{selected.content.hashtags.map((tag) => `#${tag}`).join(" ")}</p>
              <div className={styles.images}>
                {selected.content.images.map((image, index) => (
                  <figure key={image.imageUrl}>
                    <Image
                      unoptimized
                      alt={`任务配图 ${index + 1}`}
                      src={storageObjectUrl(image.imageUrl)}
                      width={image.width}
                      height={image.height}
                    />
                    {actionable ? (
                      <button
                        className="ghostButton"
                        disabled={busy || !confirmed}
                        onClick={() => void saveImage(image.imageUrl, index)}
                        type="button"
                      >
                        保存图片 {index + 1}
                      </button>
                    ) : null}
                  </figure>
                ))}
              </div>
              {actionable ? (
                <>
                  <label className={styles.confirm}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={(event) => {
                        setChecked(event.target.checked);
                        setConfirmed(false);
                        setNotice(null);
                      }}
                    />
                    <span>我已阅读，确认文案和图片符合真实情况，再进行发布。</span>
                  </label>
                  <div className="buttonRow">
                    <button
                      className="ghostButton"
                      disabled={busy || !checked}
                      onClick={() => void confirm()}
                      type="button"
                    >
                      确认真实
                    </button>
                    <button
                      className="primaryButton"
                      disabled={busy || !confirmed}
                      onClick={() => void copy()}
                      type="button"
                    >
                      复制文案
                    </button>
                  </div>
                  <form className="loginForm" onSubmit={(event) => void submit(event)}>
                    <label className="field">
                      发布后回填链接
                      <textarea
                        disabled={busy || !confirmed}
                        minLength={8}
                        required
                        rows={3}
                        placeholder="粘贴小红书发布链接或分享文本"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                      />
                    </label>
                    <button className="primaryButton" disabled={busy || !confirmed} type="submit">
                      提交发布链接
                    </button>
                  </form>
                </>
              ) : (
                <p>
                  {selected.submissionFailureReason ?? "该任务当前无需发布，历史内容仅供查看。"}
                </p>
              )}
            </>
          ) : (
            <p>选择任务，查看分配给你的专属内容。</p>
          )}
        </section>
      </div>
    </main>
  );
}
