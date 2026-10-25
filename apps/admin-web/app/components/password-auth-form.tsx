"use client";

import { type SmsChallenge, solveSmsChallenge } from "@xhs-agentic/captcha-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { apiRequest, loginPasswordAdmin } from "../lib/mvp-client";
import { messageOf, useMvpSession } from "../lib/use-mvp-session";
import { FeedbackMessage } from "./feedback-toast";
import { PlatformLogo, PlatformName } from "./platform-branding";

export function PasswordAuthForm() {
  const auth = useMvpSession();
  const router = useRouter();
  const mounted = useRef(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    if (returnTo?.startsWith("/employee")) setDestination("/employee");
    void apiRequest<{ initialized: boolean }>("/auth/admin/installation")
      .then(({ initialized }) => {
        if (mounted.current && initialized === false) router.replace("/setup");
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(messageOf(reason));
      });
    return () => {
      mounted.current = false;
    };
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const challenge = await apiRequest<SmsChallenge>("/auth/captcha/password-challenge", {
        method: "POST",
        body: { username, purpose: "PASSWORD_LOGIN" },
      });
      const captcha = await solveSmsChallenge(challenge, setProgress, () => !mounted.current);
      if (!mounted.current) return;
      const session = await loginPasswordAdmin({ username, password, captcha });
      if (!mounted.current) return;
      auth.setSession(session);
      router.replace(
        session.adminAccess.scopes.length === 0
          ? "/employee"
          : (destination ?? (session.enterpriseId ? "/console" : "/console/enterprises")),
      );
    } catch (reason) {
      if (mounted.current) setError(messageOf(reason));
    } finally {
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  return (
    <main className="setupScreen">
      <section className="setupCard loginCard">
        <Link className="loginBrand" href="/">
          <PlatformLogo />
          <strong>
            <PlatformName />
          </strong>
        </Link>
        <span className="appEyebrow">WELCOME BACK</span>
        <h1>账号密码登录</h1>
        <p>使用管理员为你创建的账号登录企业内容协作系统。</p>
        <form className="loginForm" onSubmit={(event) => void submit(event)}>
          <label className="field">
            账号
            <input
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              minLength={3}
              maxLength={64}
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field">
            密码
            <input
              aria-label="密码"
              autoComplete="current-password"
              disabled={busy}
              maxLength={128}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
          <button className="primaryButton block" disabled={busy} type="submit">
            {busy ? (progress !== null ? `安全验证中 ${progress}%` : "正在登录…") : "登录"}
          </button>
        </form>
        <p className="loginSecurityNote">登录状态通过安全 Cookie 保存。没有账号请联系管理员。</p>
      </section>
    </main>
  );
}
