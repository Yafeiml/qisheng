"use client";

import type { components } from "@xhs-agentic/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { FeedbackMessage, useFeedbackToast } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { apiRequest, hasApiErrorCode, platformNavigationPermissions } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type PlatformAdministrator = components["schemas"]["PlatformAdministratorDto"] & {
  username?: string | null;
};

export default function PlatformAccessPage() {
  const auth = useMvpSession();
  const feedback = useFeedbackToast();
  const actionReasonRef = useRef<HTMLTextAreaElement>(null);
  const [administrators, setAdministrators] = useState<PlatformAdministrator[]>([]);
  const [grantForm, setGrantForm] = useState({
    department: "",
    email: "",
    jobTitle: "",
    name: "",
    username: "",
    password: "",
  });
  const [actionReason, setActionReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!auth.session) return;
    setError(null);
    try {
      setAdministrators(
        await apiRequest<PlatformAdministrator[]>("/platform/access/admins", {
          token: auth.session.platformToken,
        }),
      );
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session]);

  useEffect(() => {
    void load();
  }, [load]);

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!auth.session) return;
    setBusy("grant");
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/platform/access/admins", {
        body: {
          ...grantForm,
          email: grantForm.email || undefined,
          department: grantForm.department || undefined,
          jobTitle: grantForm.jobTitle || undefined,
          password: grantForm.password || undefined,
        },
        method: "POST",
        token: auth.session.platformToken,
      });
      setGrantForm({
        department: "",
        email: "",
        jobTitle: "",
        name: "",
        username: "",
        password: "",
      });
      setNotice("平台后台用户已添加");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
      if (hasApiErrorCode(reason, "ADMIN_EMAIL_ALREADY_EXISTS")) {
        const input = formElement.querySelector<HTMLInputElement>('input[type="email"]');
        feedback.markFieldError(input, messageOf(reason));
        input?.focus();
      }
    } finally {
      setBusy(null);
    }
  }

  async function act(administrator: PlatformAdministrator, action: "REVOKE" | "STATUS" | "LOGOUT") {
    if (!auth.session || actionReason.trim().length < 2) {
      feedback.notify({
        tone: "error",
        content: "请先填写至少 2 个字的治理原因",
        field: actionReasonRef,
      });
      return;
    }
    const busyKey = `${administrator.userId}:${action}`;
    setBusy(busyKey);
    setError(null);
    setNotice(null);
    try {
      if (action === "REVOKE") {
        await apiRequest(`/platform/access/admins/${administrator.bindingId}`, {
          body: { reason: actionReason },
          method: "DELETE",
          token: auth.session.platformToken,
        });
      } else if (action === "LOGOUT") {
        await apiRequest(`/platform/access/users/${administrator.userId}/logout-all`, {
          body: { reason: actionReason },
          method: "POST",
          token: auth.session.platformToken,
        });
      } else {
        await apiRequest(`/platform/access/users/${administrator.userId}/status`, {
          body: {
            reason: actionReason,
            status: administrator.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
          },
          method: "POST",
          token: auth.session.platformToken,
        });
      }
      setNotice(
        action === "REVOKE"
          ? "平台角色已撤销"
          : action === "LOGOUT"
            ? "全部管理会话已注销"
            : administrator.status === "ACTIVE"
              ? "账号已停用"
              : "账号已恢复",
      );
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  if (auth.session === undefined) return <PlatformAccessLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  return (
    <SaasShell
      active="access"
      description="管理系统管理员资料、角色、账号状态和登录会话。"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      title="平台用户"
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <section className="metricGrid four">
        <Metric
          detail="独立于企业员工体系"
          label="平台后台用户"
          tone="accent"
          value={administrators.length}
        />
        <Metric
          detail="当前可登录账号"
          label="有效账号"
          value={administrators.filter(({ status }) => status === "ACTIVE").length}
        />
        <Metric
          detail="未撤销且未过期"
          label="活跃会话"
          value={administrators.reduce((sum, row) => sum + row.activeSessionCount, 0)}
        />
        <Metric detail="系统强制保留至少一名" label="最后管理员保护" value={1} />
      </section>
      <section className="contentGrid accessLayout">
        <article className="panel">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">PLATFORM ACCESS</span>
              <h2>平台后台用户</h2>
              <p>停用、撤销或强制退出后，相关账号将无法继续访问后台。</p>
            </div>
          </div>
          <label className="field">
            <span>本次治理原因</span>
            <textarea
              ref={actionReasonRef}
              minLength={2}
              placeholder="用于停用、恢复、撤销或注销会话"
              value={actionReason}
              onChange={(event) => setActionReason(event.target.value)}
            />
          </label>
          <div className="bindingList">
            {administrators.map((administrator) => {
              const isSelf = administrator.userId === auth.session?.platformAccess.userId;
              return (
                <article key={administrator.bindingId}>
                  <div>
                    <strong>
                      {administrator.name ??
                        administrator.username ??
                        maskPhone(administrator.phone)}
                    </strong>
                    <small>
                      {administrator.username ?? maskPhone(administrator.phone)}
                      {administrator.jobTitle ? ` · ${administrator.jobTitle}` : ""}
                    </small>
                  </div>
                  <StatusBadge tone={administrator.status === "ACTIVE" ? "success" : "danger"}>
                    {{ ACTIVE: "已启用", DISABLED: "已停用" }[administrator.status] ?? "状态待确认"}
                  </StatusBadge>
                  <span>{administrator.activeSessionCount} 个会话</span>
                  <time>{formatDate(administrator.lastLoginAt ?? administrator.createdAt)}</time>
                  <div className="toolbar bindingActions">
                    <button
                      className="ghostButton"
                      disabled={isSelf || busy !== null}
                      onClick={() => void act(administrator, "LOGOUT")}
                      type="button"
                    >
                      注销会话
                    </button>
                    <button
                      className="ghostButton"
                      disabled={isSelf || busy !== null}
                      onClick={() => void act(administrator, "STATUS")}
                      type="button"
                    >
                      {administrator.status === "ACTIVE" ? "停用" : "恢复"}
                    </button>
                    <button
                      className="dangerText"
                      disabled={isSelf || busy !== null}
                      onClick={() => void act(administrator, "REVOKE")}
                      type="button"
                    >
                      撤销
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </article>
        <form className="panel" onSubmit={(event) => void grant(event)}>
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">GRANT PLATFORM ROLE</span>
              <h2>添加平台后台用户</h2>
              <p>新账号设置初始密码；已有账号留空密码以保留原登录凭证。</p>
            </div>
          </div>
          <label className="field">
            <span>姓名</span>
            <input
              maxLength={100}
              required
              value={grantForm.name}
              onChange={(event) => setGrantForm({ ...grantForm, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>管理员登录账号</span>
            <input
              autoComplete="off"
              minLength={3}
              maxLength={64}
              required
              value={grantForm.username}
              onChange={(event) => setGrantForm({ ...grantForm, username: event.target.value })}
            />
          </label>
          <label className="field">
            <span>初始密码（仅新账号填写）</span>
            <input
              autoComplete="new-password"
              type="password"
              minLength={12}
              maxLength={128}
              value={grantForm.password}
              onChange={(event) => setGrantForm({ ...grantForm, password: event.target.value })}
              disabled={busy === "grant"}
            />
            <small>12–128 位，含字母和数字；不会修改已有账号的密码。</small>
          </label>
          <label className="field">
            <span>邮箱（选填）</span>
            <input
              maxLength={254}
              type="email"
              value={grantForm.email}
              onChange={(event) => setGrantForm({ ...grantForm, email: event.target.value })}
            />
          </label>
          <div className="fieldGrid">
            <label className="field">
              <span>职位（选填）</span>
              <input
                maxLength={100}
                value={grantForm.jobTitle}
                onChange={(event) => setGrantForm({ ...grantForm, jobTitle: event.target.value })}
              />
            </label>
            <label className="field">
              <span>部门（选填）</span>
              <input
                maxLength={100}
                value={grantForm.department}
                onChange={(event) => setGrantForm({ ...grantForm, department: event.target.value })}
              />
            </label>
          </div>
          <button className="primaryButton block" disabled={busy === "grant"} type="submit">
            添加平台后台用户
          </button>
        </form>
      </section>
    </SaasShell>
  );
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

function maskPhone(value: string | null): string {
  return value?.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2") ?? "未设置账号";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function PlatformAccessLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          PLATFORM ACCESS
        </span>
        <h1 suppressHydrationWarning>正在读取平台管理员…</h1>
      </section>
    </main>
  );
}
