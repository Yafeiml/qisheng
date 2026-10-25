"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FeedbackMessage } from "../components/feedback-toast";
import { apiRequest } from "../lib/mvp-client";
import { messageOf, useMvpSession } from "../lib/use-mvp-session";

export default function VerifyEmailPage() {
  const { session } = useMvpSession();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (value) {
      setToken(/^[a-f0-9]{64}$/u.test(value) ? value : null);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function confirm() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/auth/admin/email/confirm", { method: "POST", body: { token } });
      setVerified(true);
      setToken(null);
      window.dispatchEvent(new Event("qisheng:admin-account-changed"));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setupScreen">
      <section className="setupCard emailVerificationCard">
        <h1>{verified ? "邮箱验证成功" : "确认邮箱验证"}</h1>
        <p>
          {verified
            ? "你的管理员邮箱已验证，可以返回个人中心继续使用。"
            : "点击下方按钮确认邮箱。链接有效期为 30 分钟，且只能使用一次。"}
        </p>
        {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
        {!verified && !token ? (
          <p>缺少有效验证链接，请从邮件中重新打开链接，或前往个人中心重新发送。</p>
        ) : null}
        {!verified && token ? (
          <button
            className="primaryButton"
            disabled={busy}
            onClick={() => void confirm()}
            type="button"
          >
            {busy ? "正在验证…" : "确认验证邮箱"}
          </button>
        ) : null}
        <Link
          className="ghostButton"
          href={
            session
              ? session.adminAccess.scopes.some((scope) => scope.scopeType !== "PLATFORM")
                ? "/console/account"
                : "/platform/account"
              : "/login"
          }
        >
          {session ? "返回个人中心" : "前往登录"}
        </Link>
      </section>
    </main>
  );
}
