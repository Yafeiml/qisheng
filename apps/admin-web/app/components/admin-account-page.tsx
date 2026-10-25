"use client";

import { retrySeconds, type SmsChallenge, solveSmsChallenge } from "@xhs-agentic/captcha-client";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  apiRequest,
  clearMvpSession,
  consoleNavigationPermissions,
  hasApiErrorCode,
  platformNavigationPermissions,
  selectedAdminRoleName,
  synchronizeAdminAccess,
  synchronizePlatformAccess,
} from "../lib/mvp-client";
import { messageOf, useMvpSession } from "../lib/use-mvp-session";
import { FeedbackMessage } from "./feedback-toast";
import { MvpSetup } from "./mvp-setup";
import { SaasShell, StatusBadge } from "./saas-shell";

type AccountScope = Readonly<{
  department: string | null;
  enterprise: { id: string; name: string } | null;
  jobTitle: string | null;
  roles: readonly { code: string; name: string }[];
  scopeId: string;
  scopeType: "ENTERPRISE" | "PLATFORM" | "TENANT";
  tenant: { id: string; name: string } | null;
}>;

type AdminAccount = Readonly<{
  activeSessionCount: number;
  createdAt: string;
  email: string | null;
  emailVerifiedAt: string | null;
  id: string;
  lastLoginAt: string | null;
  loginMethod: "SMS_CODE" | "PASSWORD";
  name: string | null;
  phone: string | null;
  username?: string | null;
  scopes: readonly AccountScope[];
  status: "ACTIVE" | "DISABLED";
  updatedAt: string;
}>;

export function AdminAccountPage({ mode }: Readonly<{ mode: "console" | "platform" }>) {
  const auth = useMvpSession();
  const router = useRouter();
  const [account, setAccount] = useState<AdminAccount | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"LOAD" | "SAVE" | "SEND_EMAIL" | "LOGOUT_ALL" | null>("LOAD");
  const [retryAfter, setRetryAfter] = useState(0);
  const [retryUntil, setRetryUntil] = useState(0);
  const [cooldownReady, setCooldownReady] = useState(false);
  const [cooldownError, setCooldownError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const sendingEmail = useRef(false);
  const cooldownReadVersion = useRef(0);
  const session = auth.session;
  const token = mode === "platform" ? session?.platformToken : session?.adminToken;

  const readCooldown = useCallback(async () => {
    if (!token) return;
    const version = ++cooldownReadVersion.current;
    try {
      const status = await apiRequest<{ retryAfterSeconds: number }>(
        "/auth/admin/account/email/status",
        { token },
      );
      if (version !== cooldownReadVersion.current) return;
      setRetryUntil(Date.now() + status.retryAfterSeconds * 1000);
      setRetryAfter(status.retryAfterSeconds);
      setCooldownReady(true);
      setCooldownError(null);
    } catch (reason) {
      if (version !== cooldownReadVersion.current) return;
      setCooldownReady(false);
      setCooldownError(messageOf(reason));
      throw reason;
    }
  }, [token]);

  const load = useCallback(async () => {
    if (!token) return;
    setBusy("LOAD");
    setError(null);
    setCooldownReady(false);
    try {
      const [profile] = await Promise.allSettled([
        apiRequest<AdminAccount>("/auth/admin/account", { token }),
        readCooldown(),
      ]);
      if (profile.status === "rejected") throw profile.reason;
      const result = profile.value;
      setAccount(result);
      setName(result.name ?? "");
      setEmail(result.email ?? "");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }, [token, readCooldown]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (retryUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
      setRetryAfter(remaining);
      if (!remaining) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [retryUntil]);

  useEffect(() => {
    const refresh = () => {
      if (token) {
        setCooldownReady(false);
        void Promise.allSettled([
          apiRequest<AdminAccount>("/auth/admin/account", { token }),
          readCooldown(),
        ])
          .then(([result]) => {
            if (result.status === "rejected") throw result.reason;
            setAccount(result.value);
          })
          .catch((reason) => {
            setCooldownReady(false);
            setError(messageOf(reason));
          });
      }
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [token, readCooldown]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!session || !token) return;
    setBusy("SAVE");
    setError(null);
    setNotice(null);
    setEmailError(null);
    try {
      const updated = await apiRequest<AdminAccount>("/auth/admin/account", {
        body: { email: email.trim() || undefined, name: name.trim() },
        method: "PATCH",
        token,
      });
      setAccount(updated);
      setName(updated.name ?? "");
      setEmail(updated.email ?? "");
      window.dispatchEvent(new Event("qisheng:admin-account-changed"));
      const synchronized =
        mode === "platform"
          ? await synchronizePlatformAccess(session)
          : await synchronizeAdminAccess(session);
      auth.setSession(synchronized);
      setNotice("个人资料已更新");
    } catch (reason) {
      const message = messageOf(reason);
      setError(`保存失败：${message}`);
      if (hasApiErrorCode(reason, "ADMIN_EMAIL_ALREADY_EXISTS")) {
        setEmailError(message);
        emailInput.current?.focus({ preventScroll: true });
      }
    } finally {
      setBusy(null);
    }
  }

  async function sendVerification(): Promise<void> {
    if (!token || sendingEmail.current || !cooldownReady || retryUntil > Date.now() || busy) return;
    sendingEmail.current = true;
    setBusy("SEND_EMAIL");
    setError(null);
    setNotice(null);
    try {
      const challenge = await apiRequest<SmsChallenge>("/auth/admin/account/email/challenge", {
        method: "POST",
        token,
      });
      const captcha = await solveSmsChallenge(challenge, (percent) =>
        setProgress(`安全验证 ${percent}%`),
      );
      const result = await apiRequest<{ retryAfterSeconds: number }>(
        "/auth/admin/account/email/send",
        {
          method: "POST",
          token,
          body: { captcha },
        },
      );
      cooldownReadVersion.current++;
      setCooldownReady(true);
      setCooldownError(null);
      setRetryAfter(result.retryAfterSeconds);
      setRetryUntil(Date.now() + result.retryAfterSeconds * 1000);
      setNotice(
        "验证邮件已发送，请打开邮箱中的链接并点击确认。链接 30 分钟内有效，重新发送后旧链接失效。",
      );
    } catch (reason) {
      const retry = retrySeconds(reason);
      if (retry > 0) {
        cooldownReadVersion.current++;
        setCooldownReady(true);
        setCooldownError(null);
        setRetryAfter(retry);
        setRetryUntil(Date.now() + retry * 1000);
      } else {
        try {
          await readCooldown();
        } catch {
          setCooldownReady(false);
        }
      }
      setError(`发送失败：${messageOf(reason)}`);
    } finally {
      sendingEmail.current = false;
      setBusy(null);
      setProgress("");
    }
  }

  async function logoutAll(): Promise<void> {
    if (!token) return;
    setBusy("LOGOUT_ALL");
    setError(null);
    try {
      await apiRequest("/auth/admin/logout-all", { method: "POST", token });
    } catch (reason) {
      setError(messageOf(reason));
      setBusy(null);
      return;
    }
    clearMvpSession();
    auth.setSession(null);
    router.replace("/login");
  }

  if (session === undefined) return <AccountLoading />;
  if (session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  const navigationPermissions =
    mode === "platform"
      ? platformNavigationPermissions(session)
      : consoleNavigationPermissions(session);
  const roleLabel = mode === "platform" ? "系统管理员" : selectedAdminRoleName(session);
  const scopeName =
    mode === "platform" ? "SaaS Platform" : `${session.tenantName} · ${session.enterpriseName}`;
  const profileNeedsSave =
    !account?.name?.trim() ||
    !account.email ||
    email.trim() !== (account.email ?? "") ||
    name.trim() !== account.name;

  return (
    <SaasShell
      active="account"
      description="查看当前登录身份、组织职责和登录安全信息，维护属于你自己的基础资料。"
      mode={mode}
      navigationPermissions={navigationPermissions}
      roleLabel={roleLabel}
      scopeName={scopeName}
      title="个人中心"
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {cooldownError ? <FeedbackMessage tone="error">{cooldownError}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      {busy === "LOAD" && !account ? <AccountLoadingCard /> : null}
      {!account && busy !== "LOAD" ? (
        <button className="ghostButton" onClick={() => void load()} type="button">
          重新加载个人资料
        </button>
      ) : null}

      {account ? (
        <>
          <section className="accountHero panel">
            <span className="accountAvatar">{initialOf(account.name, account.phone)}</span>
            <div>
              <span className="sectionKicker">MY ACCOUNT</span>
              <h2>{account.name ?? "未填写姓名"}</h2>
              <p>
                {account.username ?? account.phone ?? "账号"} · {account.email ?? "未设置邮箱"}
              </p>
            </div>
            <StatusBadge tone={account.status === "ACTIVE" ? "success" : "danger"}>
              {account.status === "ACTIVE" ? "账号正常" : "账号已停用"}
            </StatusBadge>
          </section>

          <section className="panel accountScopesPanel accountContextPanel">
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">ROLES & SCOPES</span>
                <h2>我的角色与管理范围</h2>
                <p>角色、职位和部门由平台或组织管理员分配，在此仅供查看。</p>
              </div>
              <span className="adminUserResultCount">{account.scopes.length} 个管理身份</span>
            </div>
            <div className="accountScopeGrid">
              {account.scopes.map((scope) => (
                <article key={`${scope.scopeType}:${scope.scopeId}`}>
                  <div className="accountScopeHeading">
                    <div>
                      <span>{scopeTypeLabel(scope.scopeType)}</span>
                      <div className="accountScopeIdentityLine">
                        <h3>{scopeNameOf(scope)}</h3>
                        <StatusBadge tone="info">
                          {scope.roles.map(({ name: roleName }) => roleName).join(" + ")}
                        </StatusBadge>
                      </div>
                    </div>
                  </div>
                  <dl className="accountFacts compact">
                    <div>
                      <dt>集团</dt>
                      <dd>{scope.tenant?.name ?? "系统"}</dd>
                    </div>
                    <div>
                      <dt>企业</dt>
                      <dd>{scope.enterprise?.name ?? "全部企业 / 不适用"}</dd>
                    </div>
                    <div>
                      <dt>职位</dt>
                      <dd>{scope.jobTitle ?? "未设置"}</dd>
                    </div>
                    <div>
                      <dt>部门</dt>
                      <dd>{scope.department ?? "未设置"}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <div className="accountLayout">
            <form className="panel accountProfileForm" onSubmit={(event) => void save(event)}>
              <div className="panelHeader">
                <div>
                  <span className="sectionKicker">PROFILE</span>
                  <h2>个人资料</h2>
                  <p>姓名用于团队协作；邮箱为选填，配置邮件服务后可验证。</p>
                </div>
              </div>
              <div className="fieldGrid">
                <label className="field">
                  <span>姓名（必填）</span>
                  <input
                    maxLength={100}
                    onChange={(event) => setName(event.target.value)}
                    required
                    value={name}
                  />
                </label>
                <label className="field">
                  <span>登录账号</span>
                  <input disabled value={account.username ?? account.phone ?? ""} />
                </label>
                <div className="accountEmailInputRow">
                  <label className="field">
                    <span>邮箱（选填）</span>
                    <input
                      aria-describedby={emailError ? "account-email-error" : undefined}
                      aria-invalid={emailError ? true : undefined}
                      maxLength={254}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        if (emailError) {
                          setEmailError(null);
                          setError(null);
                        }
                      }}
                      placeholder="用于接收后台通知"
                      ref={emailInput}
                      type="email"
                      value={email}
                    />
                    {emailError ? (
                      <span hidden id="account-email-error">
                        {emailError}
                      </span>
                    ) : null}
                  </label>
                  {!account.emailVerifiedAt ? (
                    <button
                      className="ghostButton"
                      disabled={
                        busy !== null ||
                        (!cooldownReady && !cooldownError) ||
                        (cooldownReady && (retryAfter > 0 || profileNeedsSave))
                      }
                      onClick={() => {
                        if (!cooldownReady) {
                          setBusy("LOAD");
                          setCooldownError(null);
                          void readCooldown()
                            .catch(() => {})
                            .finally(() => setBusy(null));
                        } else void sendVerification();
                      }}
                      type="button"
                    >
                      {busy === "SEND_EMAIL"
                        ? progress || "正在发送…"
                        : !cooldownReady
                          ? cooldownError
                            ? "重新读取发送间隔"
                            : "正在读取发送间隔…"
                          : retryAfter > 0
                            ? `${retryAfter} 秒后可重新发送`
                            : profileNeedsSave
                              ? "请先保存资料"
                              : "发送验证邮件"}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="accountEmailVerification" aria-live="polite">
                <StatusBadge tone={account.emailVerifiedAt ? "success" : "warning"}>
                  {account.emailVerifiedAt
                    ? "邮箱已验证"
                    : account.email
                      ? "邮箱尚未验证（选填）"
                      : "邮箱未设置（选填）"}
                </StatusBadge>
                {!account.emailVerifiedAt ? (
                  <p>可按需发送验证邮件。邮箱验证不会限制内容工作流。</p>
                ) : null}
              </div>
              <button
                className="primaryButton"
                disabled={busy !== null || name.trim().length === 0}
                type="submit"
              >
                {busy === "SAVE" ? "正在保存…" : "保存个人资料"}
              </button>
            </form>

            <section className="panel accountSecurityPanel">
              <div className="panelHeader">
                <div>
                  <span className="sectionKicker">SECURITY</span>
                  <h2>登录与安全</h2>
                  <p>管理当前后台账号的登录方式和会话。</p>
                </div>
              </div>
              <dl className="accountFacts">
                <div>
                  <dt>登录方式</dt>
                  <dd>
                    {account.loginMethod === "PASSWORD" ? "账号密码" : "手机号验证码（兼容）"}
                  </dd>
                </div>
                <div>
                  <dt>登录密码</dt>
                  <dd>{account.loginMethod === "PASSWORD" ? "已设置" : "短信验证"}</dd>
                </div>
                <div>
                  <dt>活跃会话</dt>
                  <dd>{account.activeSessionCount} 个</dd>
                </div>
                <div>
                  <dt>最近登录</dt>
                  <dd>{formatDateTime(account.lastLoginAt)}</dd>
                </div>
                <div>
                  <dt>账号创建</dt>
                  <dd>{formatDateTime(account.createdAt)}</dd>
                </div>
              </dl>
              <div className="accountSecurityNotice">
                退出所有设备后账号所有会话将被强制登出，需重新登录。
              </div>
              <button
                className="dangerButton"
                disabled={busy !== null}
                onClick={() => void logoutAll()}
                type="button"
              >
                {busy === "LOGOUT_ALL" ? "正在退出…" : "退出所有设备"}
              </button>
            </section>
          </div>
        </>
      ) : null}
    </SaasShell>
  );
}

function AccountLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <h1 suppressHydrationWarning>正在读取个人账户…</h1>
      </section>
    </main>
  );
}

function AccountLoadingCard() {
  return (
    <section className="panel accountLoadingCard">
      <strong>正在同步个人资料和管理身份…</strong>
    </section>
  );
}

function initialOf(name: string | null, phone: string | null): string {
  return name?.trim().slice(0, 1) || phone?.slice(-2) || "我";
}

function scopeTypeLabel(scopeType: AccountScope["scopeType"]): string {
  if (scopeType === "PLATFORM") return "平台级身份";
  if (scopeType === "TENANT") return "集团级身份";
  return "企业级身份";
}

function scopeNameOf(scope: AccountScope): string {
  if (scope.scopeType === "PLATFORM") return "系统";
  if (scope.scopeType === "TENANT") return scope.tenant?.name ?? "集团范围";
  return scope.enterprise?.name ?? "企业范围";
}

function formatDateTime(value: string | null): string {
  if (!value) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    hour12: false,
    timeStyle: "short",
  }).format(new Date(value));
}
