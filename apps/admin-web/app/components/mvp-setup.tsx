"use client";

import Link from "next/link";
import { FeedbackMessage } from "./feedback-toast";
import { PlatformName } from "./platform-branding";

export function MvpSetup({
  busy,
  error,
  initialize,
}: Readonly<{ busy: boolean; error: string | null; initialize: () => Promise<void> }>) {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          WORKSPACE
        </span>
        <h1>
          登录 <PlatformName /> 管理后台
        </h1>
        <p>使用账号密码登录，进入团队的内容协作工作空间。</p>
        <Link className="primaryButton block" href="/login">
          账号密码登录
        </Link>
        {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
        {process.env.NODE_ENV !== "production" ? (
          <>
            <div className="setupDivider">
              <span>本机开发工具</span>
            </div>
            <p>首次演示可在 dev_xhs_agentic 中幂等创建集团、企业、3 名员工和授权素材。</p>
            <div className="setupFacts">
              <span>PostgreSQL / Redis：本机 Docker</span>
              <span>文案与图片：明确标记的 synthetic 适配器</span>
              <span>真实微信 / 小红书：保持生产接入边界</span>
            </div>
            <button
              className="ghostButton block"
              disabled={busy}
              onClick={() => void initialize()}
              type="button"
            >
              {busy ? "正在初始化…" : "初始化本机演示数据"}
            </button>
          </>
        ) : null}
      </section>
    </main>
  );
}
