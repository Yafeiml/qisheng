"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { FeedbackMessage } from "../components/feedback-toast";
import { PlatformLogo, PlatformName } from "../components/platform-branding";
import { apiRequest, initializeInstallation } from "../lib/mvp-client";
import { messageOf, useMvpSession } from "../lib/use-mvp-session";
import styles from "./setup.module.css";

export default function InstallationPage() {
  const auth = useMvpSession();
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    username: "",
    name: "",
    password: "",
    confirmation: "",
    installationToken: "",
    organizationName: "",
    organizationType: "SINGLE_ENTERPRISE" as "SINGLE_ENTERPRISE" | "GROUP",
  });
  const loadStatus = useCallback(async () => {
    setError(null);
    try {
      const status = await apiRequest<{ initialized: boolean }>("/auth/admin/installation");
      setInitialized(status.initialized);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  async function initialize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (form.password !== form.confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { confirmation: _confirmation, ...input } = form;
      auth.setSession(await initializeInstallation(input));
      setForm((current) => ({ ...current, installationToken: "", password: "", confirmation: "" }));
      setInitialized(true);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  const workbench = auth.session?.enterpriseId ? "/console" : "/console/enterprises";
  return (
    <main className="setupScreen">
      <section className={`setupCard ${styles.card}`}>
        <Link className="loginBrand" href="/">
          <PlatformLogo />
          <strong>
            <PlatformName />
          </strong>
        </Link>
        <span className="appEyebrow">INSTALLATION</span>
        <h1>{initialized ? "安装完成" : "安装你的企业协作系统"}</h1>
        <p>一套安装服务一个企业或集团。企业和账号由管理员在后台手动管理。</p>
        {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
        {initialized === null || auth.session === undefined ? (
          <div className={styles.actions}>
            <p role="status">正在检查安装状态…</p>
            {error ? (
              <button className="ghostButton" onClick={() => void loadStatus()} type="button">
                重新检查
              </button>
            ) : null}
          </div>
        ) : !initialized ? (
          <form className={`loginForm ${styles.form}`} onSubmit={(event) => void initialize(event)}>
            <label className="field">
              安装凭证
              <input
                aria-label="安装凭证"
                aria-describedby="installation-token-help"
                autoComplete="off"
                required
                type="password"
                value={form.installationToken}
                onChange={(event) => setForm({ ...form, installationToken: event.target.value })}
                disabled={busy}
              />
              <small id="installation-token-help">
                凭证由 Docker 首次启动生成。请在部署终端运行
                <code> docker compose -f deploy/compose.yml run --rm -it bootstrap token </code>
                查看，仅用于首次创建管理员。
              </small>
            </label>
            <div className={styles.grid}>
              <label className="field">
                管理员账号
                <input
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={64}
                  pattern={"[A-Za-z0-9][A-Za-z0-9_.\\-]*"}
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                  disabled={busy}
                />
              </label>
              <label className="field">
                管理员姓名
                <input
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  disabled={busy}
                />
              </label>
              <label className="field">
                管理员密码
                <input
                  aria-label="管理员密码"
                  aria-describedby="installation-password-help"
                  autoComplete="new-password"
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  disabled={busy}
                />
                <small id="installation-password-help">12–128 位，至少包含字母和数字。</small>
              </label>
              <label className="field">
                确认密码
                <input
                  autoComplete="new-password"
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  value={form.confirmation}
                  onChange={(event) => setForm({ ...form, confirmation: event.target.value })}
                  disabled={busy}
                />
              </label>
              <label className="field">
                组织类型
                <select
                  aria-label="组织类型"
                  value={form.organizationType}
                  disabled={busy}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      organizationType: event.target.value as typeof form.organizationType,
                    })
                  }
                >
                  <option value="SINGLE_ENTERPRISE">单企业</option>
                  <option value="GROUP">集团 · 管理多家企业</option>
                </select>
              </label>
              <label className="field">
                {form.organizationType === "GROUP" ? "集团名称" : "企业名称"}
                <input
                  autoComplete="organization"
                  required
                  maxLength={160}
                  value={form.organizationName}
                  onChange={(event) => setForm({ ...form, organizationName: event.target.value })}
                  disabled={busy}
                />
              </label>
            </div>
            <p>
              {form.organizationType === "GROUP"
                ? "安装后由管理员在企业管理中新增旗下企业。"
                : "自动创建本企业，直接管理素材、活动和员工。"}
            </p>
            <button className="primaryButton block" disabled={busy} type="submit">
              {busy ? "正在初始化…" : "创建管理员并完成安装"}
            </button>
          </form>
        ) : !auth.session ? (
          <div className={styles.completion}>
            <p>系统已完成安装，请登录后进入工作台。</p>
            <Link className="primaryButton block" href="/login">
              登录并进入工作台
            </Link>
          </div>
        ) : (
          <div className={styles.completion}>
            <p>管理员与组织配置已完成。</p>
            <Link className="primaryButton block" href={workbench}>
              进入工作台
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
