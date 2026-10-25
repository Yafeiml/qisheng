"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { FeedbackMessage } from "../../components/feedback-toast";
import { ApiError, apiRequest } from "../../lib/mvp-client";
import { messageOf } from "../../lib/use-mvp-session";
import styles from "./admin-sms-settings.module.css";

type Configuration = {
  accessKeyIdConfigured: boolean;
  accessKeySecretConfigured: boolean;
  accessKeyIdHint: string | null;
  signName: string;
  templateCode: string;
  configured: boolean;
  enabled: boolean;
};

export function AdminSmsSettings({ token }: { token: string }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [signName, setSignName] = useState("");
  const [templateCode, setTemplateCode] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<"SAVE" | "TEST" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const load = useCallback(async () => {
    setError(null);
    try {
      const saved = await apiRequest<Configuration>("/platform/settings/admin-sms", { token });
      setConfiguration(saved);
      setSignName(saved.signName);
      setTemplateCode(saved.templateCode);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const dirty = Boolean(
    accessKeyId.trim() ||
      accessKeySecret.trim() ||
      signName !== configuration?.signName ||
      templateCode !== configuration?.templateCode,
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("SAVE");
    setError(null);
    setNotice(null);
    try {
      const saved = await apiRequest<Configuration>("/platform/settings/admin-sms", {
        token,
        method: "POST",
        body: {
          accessKeyId: accessKeyId.trim() || undefined,
          accessKeySecret: accessKeySecret.trim() || undefined,
          signName: signName.trim(),
          templateCode: templateCode.trim(),
        },
      });
      setConfiguration(saved);
      setSignName(saved.signName);
      setTemplateCode(saved.templateCode);
      setAccessKeyId("");
      setAccessKeySecret("");
      setNotice("阿里云短信配置已保存，管理员登录验证码将通过阿里云发送。");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }
  async function sendTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("TEST");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{
        status: "ACCEPTED";
        phoneMasked: string;
        requestId: string;
      }>("/platform/settings/admin-sms/test", {
        token,
        method: "POST",
        body: { phone: phone.trim() },
      });
      setNotice(
        `阿里云已受理发往 ${result.phoneMasked} 的测试短信，请查看手机。请求编号：${result.requestId}`,
      );
      setCooldown(60);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 429) {
        setCooldown(60);
        setError("测试短信发送过于频繁，请稍后重试。");
      } else setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`panel ${styles.panel}`} aria-label="短信验证（可选兼容）">
      <header className={styles.header}>
        <div>
          <h2>短信验证（可选兼容）</h2>
          <p>账号密码登录无需短信。仅在使用兼容短信验证时配置。</p>
        </div>
        <span>
          {configuration?.enabled && configuration.configured ? "已配置阿里云" : "待配置"}
        </span>
      </header>
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <form onSubmit={save} aria-label="阿里云短信配置">
        <div className={styles.fields}>
          <label>
            ACCESS_KEY_ID
            <input
              aria-label="ACCESS_KEY_ID"
              type="password"
              autoComplete="new-password"
              value={accessKeyId}
              onChange={(event) => {
                setAccessKeyId(event.target.value);
                setNotice(null);
              }}
              required={!configuration?.accessKeyIdConfigured}
              maxLength={256}
              disabled={busy !== null || !configuration}
              placeholder={
                configuration?.accessKeyIdConfigured
                  ? `已保存 ${configuration.accessKeyIdHint}，留空保留`
                  : "填写阿里云 AccessKey ID"
              }
            />
          </label>
          <label>
            ACCESS_KEY_SECRET
            <input
              aria-label="ACCESS_KEY_SECRET"
              type="password"
              autoComplete="new-password"
              value={accessKeySecret}
              onChange={(event) => {
                setAccessKeySecret(event.target.value);
                setNotice(null);
              }}
              required={!configuration?.accessKeySecretConfigured}
              maxLength={256}
              disabled={busy !== null || !configuration}
              placeholder={
                configuration?.accessKeySecretConfigured
                  ? "已保存，留空保留"
                  : "填写阿里云 AccessKey Secret"
              }
            />
          </label>
          <label>
            SIGN_NAME（签名名称）
            <input
              aria-label="SIGN_NAME（签名名称）"
              value={signName}
              onChange={(event) => {
                setSignName(event.target.value);
                setNotice(null);
              }}
              required
              maxLength={80}
              disabled={busy !== null || !configuration}
              placeholder="填写已审核通过的短信签名"
            />
          </label>
          <label>
            TEMPLATE_CODE（模板 CODE）
            <input
              aria-label="TEMPLATE_CODE（模板 CODE）"
              value={templateCode}
              onChange={(event) => {
                setTemplateCode(event.target.value);
                setNotice(null);
              }}
              required
              pattern="SMS_[0-9]+"
              maxLength={64}
              disabled={busy !== null || !configuration}
              placeholder="例如：SMS_123456789"
            />
          </label>
        </div>
        <footer className={styles.actions}>
          <p>
            验证码模板需包含变量 <code>$&#123;code&#125;</code>
            。保存后立即用于短信验证（可选兼容）。
          </p>
          <button
            className="primaryButton"
            type={configuration ? "submit" : "button"}
            onClick={!configuration ? () => void load() : undefined}
            disabled={busy !== null || (!configuration && !error)}
          >
            {!configuration
              ? error
                ? "重新加载"
                : "加载中…"
              : busy === "SAVE"
                ? "保存中…"
                : "保存短信配置"}
          </button>
        </footer>
      </form>
      <div className={styles.test}>
        <h3>短信发送测试</h3>
        <form onSubmit={sendTest} className={styles.testForm} aria-label="短信发送测试">
          <label>
            接收手机号
            <input
              aria-label="接收手机号"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="填写接收测试短信的手机号"
              required
              pattern="1[3-9][0-9]{9}"
              maxLength={11}
              disabled={busy !== null}
            />
          </label>
          <button
            className="ghostButton"
            type="submit"
            disabled={busy !== null || !configuration?.configured || dirty || cooldown > 0}
          >
            {busy === "TEST" ? "发送中…" : cooldown > 0 ? `${cooldown} 秒后可重试` : "发送测试短信"}
          </button>
        </form>
        <p>
          {dirty || !configuration?.configured
            ? "请先保存完整配置，再发送测试短信。"
            : "测试使用已保存的配置，短信费用由阿里云按套餐计费。"}{" "}
          测试短信仅验证通道，不可用于登录。
        </p>
      </div>
    </section>
  );
}
