"use client";

import type { components } from "@xhs-agentic/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackMessage, useFeedbackToast } from "../../../components/feedback-toast";
import { MvpSetup } from "../../../components/mvp-setup";
import { notifyPlatformBrandingChanged } from "../../../components/platform-branding";
import { PlatformLogoUpload } from "../../../components/platform-logo-upload";
import { SaasShell, StatusBadge } from "../../../components/saas-shell";
import {
  apiRequest,
  platformNavigationPermissions,
  selectedAdminRoleName,
} from "../../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../../lib/use-mvp-session";
import { AdminSmsSettings } from "../admin-sms-settings";
import { ContentSafetySettings } from "../content-safety-settings";

type SettingValue = boolean | number | string | null;

type Setting = Readonly<{
  configured: boolean;
  description: string;
  group: string;
  key: string;
  label: string;
  maskedValue: string | null;
  max: number | null;
  maxLength: number | null;
  min: number | null;
  minLength: number | null;
  nullable: boolean;
  options: readonly Readonly<{ label: string; value: string }>[];
  restartRequired: boolean;
  secret: boolean;
  source: "DATABASE" | "DEFAULT" | "ENVIRONMENT" | "UNCONFIGURED";
  step: number;
  store: "PLATFORM_SETTING" | "RUNTIME_POLICY";
  unit: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  value: SettingValue;
  valueType: "BOOLEAN" | "DECIMAL" | "ENUM" | "INTEGER" | "SECRET" | "STRING" | "URL";
  version: number | null;
}>;

type SettingGroup = Readonly<{
  configuredCount: number;
  description: string;
  group: string;
  label: string;
  mark: string;
  settings: readonly Setting[];
  slug: string;
  totalCount: number;
}>;

type SettingsResponse = Readonly<{ groups: readonly SettingGroup[] }>;

type PublicationPolicyEvidence = components["schemas"]["PublicationPolicyEvidenceResponseDto"];

export default function PlatformSettingsGroupPage() {
  const auth = useMvpSession();
  const { notify } = useFeedbackToast();
  const changeReasonInput = useRef<HTMLInputElement>(null);
  const publicationTestInput = useRef<HTMLInputElement>(null);
  const evidenceFileInput = useRef<HTMLInputElement>(null);
  const evidenceJsonInput = useRef<HTMLTextAreaElement>(null);
  const evidenceReasonInput = useRef<HTMLInputElement>(null);
  const params = useParams<{ group: string }>();
  const groupSlug = params.group;
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [smsExpanded, setSmsExpanded] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
  const [changeReason, setChangeReason] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publicationTestUrl, setPublicationTestUrl] = useState("");
  const [publicationEvidence, setPublicationEvidence] = useState<PublicationPolicyEvidence | null>(
    null,
  );
  const [publicationEvidenceJson, setPublicationEvidenceJson] = useState("");
  const [publicationEvidenceFileName, setPublicationEvidenceFileName] = useState<string | null>(
    null,
  );
  const [publicationEvidenceReason, setPublicationEvidenceReason] = useState(
    "登记正式 P-014 真实样本验收证据",
  );

  const load = useCallback(async () => {
    if (!auth.session) return;
    setError(null);
    try {
      const [response, evidence] = await Promise.all([
        apiRequest<SettingsResponse>("/platform/settings", {
          token: auth.session.platformToken,
        }),
        groupSlug === "publication"
          ? apiRequest<PublicationPolicyEvidence | null>(
              "/platform/settings/publication-verification/evidence",
              { token: auth.session.platformToken },
            )
          : Promise.resolve(null),
      ]);
      setData(response);
      setSettingsRevision((value) => value + 1);
      setPublicationEvidence(evidence);
      setDrafts(settingDrafts(response));
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session, groupSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const rawGroup = data?.groups.find(({ slug }) => slug === groupSlug) ?? null;
  const storageProvider = drafts["storage.provider"] ?? "S3";
  const versioningRequired =
    rawGroup?.settings.find((setting) => setting.key === "storage.versioning_required")?.value !==
    false;
  const groupSettings =
    rawGroup?.settings.filter(
      (setting) =>
        !setting.key.startsWith("security.admin_sms_") &&
        (groupSlug !== "storage" ||
          storageProvider !== "LOCAL" ||
          ["storage.provider", "storage.signed_url_ttl_seconds"].includes(setting.key)),
    ) ?? [];
  const storageChanged =
    groupSlug === "storage" &&
    groupSettings.some((setting) => isSettingChanged(setting, drafts[setting.key]));
  const group = rawGroup
    ? {
        ...rawGroup,
        settings: groupSettings,
        totalCount: groupSettings.length,
        configuredCount: groupSettings.filter((setting) => setting.configured).length,
      }
    : null;
  const notificationChannel = drafts["notification.channel"];
  const visibleSettings = group?.settings
    .filter((setting) => {
      if (groupSlug !== "miniapp") return true;
      if (setting.key.startsWith("notification.wechat_"))
        return notificationChannel === "WECHAT_TEMPLATE";
      if (setting.key.startsWith("notification.sms_")) return notificationChannel === "ALIYUN_SMS";
      return true;
    })
    .sort((left, right) => {
      const priority = (setting: Setting) =>
        setting.key === "notification.enabled"
          ? -3
          : setting.key === "notification.channel"
            ? -2
            : setting.key.startsWith("notification.")
              ? -1
              : 0;
      return priority(left) - priority(right);
    });
  const totals = useMemo(() => {
    const settings = data?.groups.flatMap(({ settings }) => settings) ?? [];
    return {
      configured: settings.filter(({ configured }) => configured).length,
      restart: settings.filter(({ restartRequired }) => restartRequired).length,
      secrets: settings.filter(({ secret }) => secret).length,
      total: settings.length,
    };
  }, [data]);

  async function saveChanges() {
    if (!auth.session) return;
    const reason = changeReason.trim();
    if (reason.length < 2) {
      notify({
        tone: "error",
        content: "保存参数前，请填写至少 2 个字的变更原因",
        field: changeReasonInput,
      });
      return;
    }
    const changedSettings =
      group?.settings.filter((setting) => isSettingChanged(setting, drafts[setting.key])) ?? [];
    if (changedSettings.length === 0) {
      notify({ tone: "error", content: "当前没有需要保存的参数变更" });
      return;
    }
    setBusyKey("settings.save-all");
    setError(null);
    setNotice(null);
    try {
      if (groupSlug === "miniapp") {
        if (changedSettings.some(({ key }) => key.startsWith("miniapp.debug_code_")))
          await apiRequest("/platform/settings/miniapp-debug", {
            body: {
              enabled: drafts["miniapp.debug_code_enabled"] === true,
              phones: String(drafts["miniapp.debug_code_phones"] ?? ""),
              ips: String(drafts["miniapp.debug_code_ips"] ?? ""),
              until: String(drafts["miniapp.debug_code_until"] ?? ""),
              reason,
            },
            method: "POST",
            token: auth.session.platformToken,
          });
        const regularSettings = changedSettings.filter(
          ({ key }) => !key.startsWith("miniapp.debug_code_"),
        );
        regularSettings.sort((left, right) => {
          const priority = (setting: Setting) =>
            setting.key === "notification.enabled"
              ? draftValue(setting, drafts[setting.key]) === true
                ? 2
                : -1
              : setting.key === "notification.channel"
                ? 1
                : 0;
          return priority(left) - priority(right);
        });
        for (const setting of regularSettings)
          await apiRequest(`/platform/settings/${encodeURIComponent(setting.key)}`, {
            body: { reason, value: draftValue(setting, drafts[setting.key]) },
            method: "POST",
            token: auth.session.platformToken,
          });
      } else {
        const ordered = [...changedSettings].sort(
          (a, b) =>
            (a.key === "storage.provider"
              ? 2
              : a.key === "security.cap_enabled"
                ? drafts[a.key] === true
                  ? 1
                  : -1
                : 0) -
            (b.key === "storage.provider"
              ? 2
              : b.key === "security.cap_enabled"
                ? drafts[b.key] === true
                  ? 1
                  : -1
                : 0),
        );
        for (const setting of ordered) {
          await apiRequest(`/platform/settings/${encodeURIComponent(setting.key)}`, {
            body: { reason, value: draftValue(setting, drafts[setting.key]) },
            method: "POST",
            token: auth.session.platformToken,
          });
        }
      }
      setNotice(`${changedSettings.length} 项参数已保存到数据库并写入审计记录`);
      setChangeReason("");

      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      if (
        changedSettings.some(
          ({ key }) => key === "general.platform_name" || key === "general.platform_logo",
        )
      )
        notifyPlatformBrandingChanged();
      setBusyKey(null);
    }
  }

  async function testStorage() {
    if (!auth.session) return;
    setBusyKey("storage.test");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{
        bucket: string;
        byteSize: number;
        signedReadVerified: boolean;
      }>("/platform/settings/storage/test", {
        body: { reason: "在参数中心验证对象存储写入、签名读取和清理" },
        method: "POST",
        token: auth.session.platformToken,
      });
      setNotice(
        `存储连接正常：${result.bucket} · ${result.byteSize} bytes · 签名读取${result.signedReadVerified ? "通过" : "失败"}`,
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyKey(null);
    }
  }

  async function applyStorageLifecycle() {
    if (!auth.session) return;
    setBusyKey("storage.lifecycle");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{
        abortIncompleteMultipartUploadDays: number | null;
        enabled: boolean;
        noncurrentVersionExpirationDays: number | null;
        versioning: "DISABLED" | "ENABLED" | "SUSPENDED";
      }>("/platform/settings/storage/lifecycle/apply", {
        body: { reason: "应用对象版本控制、历史版本保留和未完成上传清理策略" },
        method: "POST",
        token: auth.session.platformToken,
      });
      if (
        result.versioning !== "ENABLED" ||
        !result.enabled ||
        result.noncurrentVersionExpirationDays === null
      ) {
        setError(
          "策略请求已返回，但读回结果尚未生效。请检查 S3 API Endpoint、Bucket 名称及供应商的版本控制和生命周期支持，稍后刷新生产引导确认。",
        );
        return;
      }
      setNotice(
        `生命周期策略已应用并读回确认：版本控制已启用 · 历史版本 ${result.noncurrentVersionExpirationDays} 天 · 未完成上传 ${result.abortIncompleteMultipartUploadDays ?? "未确认"} 天。请刷新生产就绪引导。`,
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyKey(null);
    }
  }

  async function testPublicationVerification() {
    if (!auth.session) return;
    const url = publicationTestUrl.trim();
    if (!url) {
      notify({
        tone: "error",
        content: "请先输入一条用于连通测试的小红书公开链接",
        field: publicationTestInput,
      });
      return;
    }
    setBusyKey("publication.test");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{
        available: boolean;
        imageCount: number;
        latencyMs: number;
        policyVersion: string;
        provider: string;
      }>("/platform/settings/publication-verification/test", {
        body: { reason: "在参数中心验证小红书公开内容解析与图片指纹响应契约", url },
        method: "POST",
        token: auth.session.platformToken,
      });
      setNotice(
        result.available
          ? `发布验真服务正常：${result.provider} · ${result.latencyMs} ms · ${result.imageCount} 张公开图片 · 策略 ${result.policyVersion}`
          : `验真服务已响应但当前公开内容不可用：${result.provider} · ${result.latencyMs} ms · 策略 ${result.policyVersion}`,
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyKey(null);
    }
  }

  async function selectPublicationEvidence(file: File | null) {
    if (!file) return;
    if (file.size > 128 * 1024) {
      notify({
        tone: "error",
        content: "acceptance-report.json 不能超过 128 KiB",
        field: evidenceFileInput,
      });
      return;
    }
    try {
      const value = await file.text();
      JSON.parse(value);
      setPublicationEvidenceJson(value);
      setPublicationEvidenceFileName(file.name);
      setError(null);
    } catch {
      notify({ tone: "error", content: "选择的文件不是有效 JSON", field: evidenceFileInput });
    }
  }

  async function registerPublicationEvidence() {
    if (!auth.session) return;
    const reason = publicationEvidenceReason.trim();
    if (publicationEvidenceJson.trim().length === 0) {
      notify({
        tone: "error",
        content: "请先选择或粘贴 acceptance-report.json",
        field: evidenceJsonInput,
      });
      return;
    }
    if (reason.length < 2) {
      notify({ tone: "error", content: "请填写证据登记原因", field: evidenceReasonInput });
      return;
    }
    setBusyKey("publication.evidence");
    setError(null);
    setNotice(null);
    try {
      const evidence = await apiRequest<PublicationPolicyEvidence>(
        "/platform/settings/publication-verification/evidence",
        {
          body: { acceptanceReportJson: publicationEvidenceJson, reason },
          method: "POST",
          token: auth.session.platformToken,
        },
      );
      setPublicationEvidence(evidence);
      setPublicationEvidenceJson("");
      setPublicationEvidenceFileName(null);
      setNotice(
        `P-014 证据已登记：${evidence.benchmarkId} · ${evidence.sampleCount} 条真实样本 · 策略 ${evidence.policyVersion}`,
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyKey(null);
    }
  }

  if (auth.session === undefined) return <SettingsLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  return (
    <SaasShell
      active="settings"
      activeSub={groupSlug}
      description="管理工作空间的运行参数。密钥加密保存，前端不回显明文。"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      title="平台参数设置"
      toolbar={
        <div className="buttonRow settingsToolbar">
          {groupSlug === "miniapp" && notificationChannel === "WECHAT_TEMPLATE" ? (
            <button
              className="lightButton"
              disabled={busyKey !== null}
              type="button"
              onClick={() => {
                setDrafts((current) => ({
                  ...current,
                  "notification.wechat_template_id": "F2Vwz548apm3jIVCeJDwsaMr3q9h1vKXtwCBT8oPP6c",
                  "notification.wechat_template_fields":
                    '{"thing4":"TASK_TITLE","time5":"EXPIRES_AT","thing12":"TASK_TYPE","thing11":"REMARK","thing13":"TASK_PLATFORM"}',
                }));
                notify({
                  tone: "success",
                  content: "已填入任务新增通知模板和五个字段映射，请保存更改。",
                });
              }}
            >
              填入新任务通知模板
            </button>
          ) : null}
          {groupSlug === "storage" ? (
            <>
              <button
                className="lightButton"
                disabled={busyKey !== null || storageChanged}
                onClick={() => void testStorage()}
                title={storageChanged ? "请先保存存储配置，再测试连接" : "验证当前已保存的存储配置"}
                type="button"
              >
                测试存储连接
              </button>
              {storageProvider === "S3" ? (
                <button
                  className="lightButton"
                  disabled={busyKey !== null || !versioningRequired || storageChanged}
                  onClick={() => void applyStorageLifecycle()}
                  title={
                    versioningRequired
                      ? "启用版本控制并应用历史版本保留策略"
                      : "强制版本控制已关闭，无需应用；重新开启并保存后可操作"
                  }
                  type="button"
                >
                  {versioningRequired ? "应用生命周期策略" : "生命周期策略不强制"}
                </button>
              ) : null}
            </>
          ) : null}
          <button
            className="ghostButton refreshButton"
            disabled={busyKey !== null}
            onClick={() => void load()}
            type="button"
          >
            刷新参数
          </button>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      {groupSlug === "miniapp" ? (
        <div className="inlineWarning">
          {notificationChannel === "ALIYUN_SMS" ? (
            <span>
              素材开放后，短信通知已验证手机号的员工，无需微信订阅授权。阿里云凭据和短信签名复用
              <Link href="/platform/settings/security">安全设置中的短信通道</Link>；
              请单独配置审核通过的无变量通知模板，不使用验证码模板或验证码字段。每日发送量受下方上限限制。
            </span>
          ) : notificationChannel === "NONE" ? (
            "当前渠道不发送通知。选择通知渠道并开启素材开放通知总开关后生效。"
          ) : (
            "微信提醒需先配置此小程序的 AppSecret、订阅模板和实际字段映射；员工主动订阅后才能收到消息，每次授权仅对应一次通知。"
          )}
          下方临时调试验证码开关应在测试结束后关闭。
        </div>
      ) : null}
      {groupSlug === "storage" ? (
        <div className="inlineWarning">
          {storageProvider === "LOCAL" ? (
            "本机存储将文件保存在部署服务器的持久化数据目录，通过短期签名地址访问，无需 S3 凭据或域名。请预留足够磁盘空间。"
          ) : (
            <>
              Endpoint 请填写供应商的 S3 API 服务地址，Bucket 单独填写实际桶名。
              {versioningRequired
                ? "强制版本控制已开启。若供应商不支持，可关闭下方开关并保存；应用策略仍须读回确认才算成功。"
                : "强制版本控制已关闭：生产检查跳过历史版本治理要求，仍检查连接和私有交付。此开关不会关闭云端已有规则。"}
            </>
          )}
          调整存储前，请先停止 Worker 并暂停上传和创建任务；保存并验证后重启 Worker。
          文件不会自动搬迁，有业务文件或任务时不能直接切换，原有配置和文件会保留。
        </div>
      ) : null}

      {groupSlug === "content-safety" ? (
        data ? (
          <ContentSafetySettings key={settingsRevision} token={auth.session.platformToken} />
        ) : null
      ) : groupSlug === "security" ? (
        data ? (
          <details className="panel" onToggle={(event) => setSmsExpanded(event.currentTarget.open)}>
            <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 28 }}>
              短信验证（可选兼容）
            </summary>
            {smsExpanded ? (
              <AdminSmsSettings key={settingsRevision} token={auth.session.platformToken} />
            ) : null}
          </details>
        ) : null
      ) : (
        <section className="metricGrid four settingsMetrics">
          <Metric detail="平台参数目录" label="参数总数" value={totals.total} />
          <Metric detail="数据库、环境或默认值" label="当前可用" value={totals.configured} />
          <Metric detail="前端永不返回明文" label="密钥参数" value={totals.secrets} />
          <Metric detail="保存后需要重启 Worker" label="重启生效" value={totals.restart} />
        </section>
      )}

      {groupSlug === "content-safety" ? null : !data ? (
        <section className="panel emptyState compact">正在读取平台参数目录…</section>
      ) : !group ? (
        <section className="panel emptyState compact">
          参数分组不存在，请从二级菜单重新选择。
        </section>
      ) : (
        <section className="panel parameterPanel">
          <div className="panelHeader parameterHeader">
            <div>
              <span className="sectionKicker">PLATFORM PARAMETERS · {group.group}</span>
              <h2>{group.label}</h2>
              <p>{group.description}</p>
            </div>
            <StatusBadge tone={group.configuredCount === group.totalCount ? "success" : "warning"}>
              {group.configuredCount} / {group.totalCount} 可用
            </StatusBadge>
          </div>

          {group.slug === "security" ? (
            <div className="inlineWarning">
              <span>
                <strong>Cap 人机验证（可选）</strong>：默认关闭。开启前请填写 Cap 验证服务 Endpoint
                和 Cap 验证服务 Secret Key。站点请使用
                format-1（SHA-256）挑战，并关闭浏览器环境检测（Browser
                Instrumentation），以兼容员工小程序。
                密钥留空会保留已保存值，输入新密钥后保存即可替换。
              </span>
            </div>
          ) : null}
          {group.slug === "notification" ? (
            <>
              {platformNavigationPermissions(auth.session).includes("platform.monitor.read") ? (
                <div className="processingIssuesEntry">
                  <div>
                    <strong>处理异常</strong>
                    <p>自动汇总素材处理中的用户、企业、失败原因及处理建议，方便管理员跟进解决。</p>
                  </div>
                  <Link href="/platform/processing-issues">查看处理异常</Link>
                </div>
              ) : null}
              <div className="inlineWarning">
                邮件通知为可选配置，未配置不影响注册、登录和内容生成。
              </div>
            </>
          ) : null}
          {group.slug === "worker" ? (
            <div className="inlineWarning">
              Worker 参数保存后不会热切换；请在业务低峰滚动重启 Worker 进程。
            </div>
          ) : null}
          {group.slug === "publication" ? (
            <>
              <div className="inlineWarning">
                平台只接收正式验真服务返回的公开正文、规范链接和图片指纹，不以员工账号归属作为通过条件。服务不可用时保留按时提交事实并进入待重试队列，不处罚员工。
              </div>
              <div className="publicationTestPanel">
                <label className="field publicationTestField">
                  <span>小红书公开链接连通测试</span>
                  <input
                    aria-label="小红书公开链接连通测试"
                    ref={publicationTestInput}
                    onChange={(event) => setPublicationTestUrl(event.target.value)}
                    placeholder="https://www.xiaohongshu.com/explore/..."
                    type="url"
                    value={publicationTestUrl}
                  />
                </label>
                <button
                  className="lightButton"
                  disabled={busyKey !== null || publicationTestUrl.trim().length === 0}
                  onClick={() => void testPublicationVerification()}
                  type="button"
                >
                  {busyKey === "publication.test" ? "测试中…" : "测试验真服务"}
                </button>
                <small>
                  测试结果只展示服务标识、可用性、图片数量、策略版本和延迟，不回显 API Key
                  或供应商原始响应。
                </small>
              </div>
              <div className="publicationEvidencePanel">
                <div className="publicationEvidenceHeader">
                  <div>
                    <span className="sectionKicker">P-014 POLICY EVIDENCE</span>
                    <strong>真实样本策略证据</strong>
                    <small>
                      只接受验收器生成的 accepted、非 synthetic
                      报告；供应商、评分实现、策略版本和全部阈值必须与当前配置一致。
                    </small>
                  </div>
                  <StatusBadge tone={publicationEvidence ? "success" : "warning"}>
                    {publicationEvidence ? "证据已匹配" : "尚未登记"}
                  </StatusBadge>
                </div>
                {publicationEvidence ? (
                  <div className="publicationEvidenceFacts">
                    <span>
                      <small>基准</small>
                      <strong>{publicationEvidence.benchmarkId}</strong>
                    </span>
                    <span>
                      <small>真实样本</small>
                      <strong>{publicationEvidence.sampleCount}</strong>
                    </span>
                    <span>
                      <small>策略</small>
                      <strong>{publicationEvidence.policyVersion}</strong>
                    </span>
                    <span>
                      <small>登记时间</small>
                      <strong>{formatDateTime(publicationEvidence.createdAt)}</strong>
                    </span>
                  </div>
                ) : null}
                <div className="publicationEvidenceInput">
                  <label className="filePicker">
                    <span>选择 acceptance-report.json</span>
                    <input
                      accept="application/json,.json"
                      ref={evidenceFileInput}
                      onChange={(event) =>
                        void selectPublicationEvidence(event.target.files?.[0] ?? null)
                      }
                      type="file"
                    />
                    <strong>{publicationEvidenceFileName ?? "尚未选择文件"}</strong>
                  </label>
                  <label>
                    <span>或粘贴报告 JSON</span>
                    <textarea
                      aria-label="P-014 acceptance report JSON"
                      ref={evidenceJsonInput}
                      maxLength={131072}
                      onChange={(event) => {
                        setPublicationEvidenceJson(event.target.value);
                        setPublicationEvidenceFileName(null);
                      }}
                      placeholder='{"accepted": true, ...}'
                      rows={5}
                      value={publicationEvidenceJson}
                    />
                  </label>
                  <label>
                    <span>登记原因</span>
                    <input
                      maxLength={500}
                      onChange={(event) => setPublicationEvidenceReason(event.target.value)}
                      ref={evidenceReasonInput}
                      value={publicationEvidenceReason}
                    />
                  </label>
                  <button
                    className="primaryButton"
                    disabled={busyKey !== null || publicationEvidenceJson.trim().length === 0}
                    onClick={() => void registerPublicationEvidence()}
                    type="button"
                  >
                    {busyKey === "publication.evidence" ? "校验并登记中…" : "校验并登记证据"}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          <div className="parameterReasonBar">
            <label htmlFor="parameter-change-reason">本次变更原因</label>
            <input
              id="parameter-change-reason"
              ref={changeReasonInput}
              maxLength={500}
              onChange={(event) => setChangeReason(event.target.value)}
              placeholder={`例如：调整${group.label}配置`}
              value={changeReason}
            />
            <button
              className="primaryButton"
              disabled={
                busyKey !== null ||
                !group.settings.some((setting) => isSettingChanged(setting, drafts[setting.key]))
              }
              onClick={() => void saveChanges()}
              type="button"
            >
              {busyKey === "settings.save-all" ? "保存中…" : "保存更改"}
            </button>
          </div>

          <div className="parameterRows">
            {visibleSettings?.map((setting) => (
              <article aria-label={setting.label} className="parameterRow" key={setting.key}>
                <div className="parameterIdentity">
                  <div>
                    <strong>{setting.label}</strong>
                    {setting.restartRequired ? <span>需重启</span> : null}
                    {setting.secret ? <span>加密</span> : null}
                  </div>
                  <p>{setting.description}</p>
                  <code>{setting.key}</code>
                </div>

                <SettingControl
                  disabled={busyKey !== null}
                  draft={drafts[setting.key]}
                  metadata={
                    setting.updatedAt
                      ? `${formatDateTime(setting.updatedAt)} · ${setting.updatedBy ?? "SYSTEM"}`
                      : "尚无数据库变更记录"
                  }
                  onChange={(value) =>
                    setDrafts((current) => ({ ...current, [setting.key]: value }))
                  }
                  setting={setting}
                />

                <div className="parameterState">
                  <StatusBadge tone={sourceTone(setting.source)}>
                    {sourceLabel(setting.source)}
                  </StatusBadge>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </SaasShell>
  );
}

function SettingControl({
  disabled,
  draft,
  metadata,
  onChange,
  setting,
}: Readonly<{
  disabled: boolean;
  draft: boolean | string | undefined;
  metadata: string;
  onChange(value: boolean | string): void;
  setting: Setting;
}>) {
  const header = (
    <span className="parameterControlHeader">
      <span>参数值{setting.unit ? ` · ${setting.unit}` : ""}</span>
      <small title={metadata}>{metadata}</small>
    </span>
  );

  if (setting.key === "general.platform_logo") {
    return (
      <div className="parameterControl">
        {header}
        <PlatformLogoUpload
          disabled={disabled}
          value={typeof draft === "string" ? draft : ""}
          onChange={onChange}
        />
      </div>
    );
  }
  if (setting.valueType === "BOOLEAN") {
    return (
      <div className="parameterControl">
        {header}
        <fieldset aria-label={setting.label} className="parameterToggle">
          <button
            aria-pressed={draft === true}
            className={draft === true ? "active" : undefined}
            disabled={disabled}
            onClick={() => onChange(true)}
            type="button"
          >
            启用
          </button>
          <button
            aria-pressed={draft !== true}
            className={draft !== true ? "active" : undefined}
            disabled={disabled}
            onClick={() => onChange(false)}
            type="button"
          >
            禁用
          </button>
        </fieldset>
      </div>
    );
  }
  if (setting.key === "notification.wechat_template_fields") {
    return (
      <label className="parameterControl">
        {header}
        <textarea
          aria-label={setting.label}
          disabled={disabled}
          maxLength={setting.maxLength ?? undefined}
          onChange={(event) => onChange(event.target.value)}
          placeholder='{"thing4":"TASK_TITLE","time5":"EXPIRES_AT","thing12":"TASK_TYPE","thing11":"REMARK","thing13":"TASK_PLATFORM"}'
          rows={4}
          value={typeof draft === "string" ? draft : ""}
        />
      </label>
    );
  }
  if (setting.valueType === "ENUM") {
    return (
      <label className="parameterControl">
        {header}
        <select
          aria-label={setting.label}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          value={typeof draft === "string" ? draft : ""}
        >
          {setting.nullable ? <option value="">未指定</option> : null}
          {setting.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="parameterControl">
      {header}
      <input
        aria-label={setting.label}
        disabled={disabled}
        max={setting.max ?? undefined}
        maxLength={setting.maxLength ?? undefined}
        min={setting.min ?? undefined}
        minLength={setting.minLength ?? undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          setting.secret
            ? (setting.maskedValue ?? "输入新密钥")
            : setting.key === "security.cap_endpoint"
              ? "https://cap.example.com/<Site Key>/"
              : undefined
        }
        step={setting.step}
        type={inputType(setting)}
        value={typeof draft === "string" ? draft : ""}
      />
    </label>
  );
}

function settingDrafts(data: SettingsResponse): Record<string, string | boolean> {
  return Object.fromEntries(
    data.groups.flatMap(({ settings }) =>
      settings.map((setting) => [setting.key, initialSettingDraft(setting)]),
    ),
  );
}

function initialSettingDraft(setting: Setting): string | boolean {
  if (setting.secret) return "";
  if (typeof setting.value === "boolean") return setting.value;
  return setting.value === null ? "" : String(setting.value);
}

function isSettingChanged(setting: Setting, draft: string | boolean | undefined): boolean {
  if (draft === undefined) return false;
  if (setting.secret) return typeof draft === "string" && draft.length > 0;
  return draft !== initialSettingDraft(setting);
}

function draftValue(setting: Setting, draft: string | boolean | undefined): SettingValue {
  if (setting.valueType === "BOOLEAN") return draft === true;
  const value = typeof draft === "string" ? draft : "";
  if (setting.valueType === "INTEGER") return Number.parseInt(value, 10);
  if (setting.valueType === "DECIMAL") return Number(value);
  if (setting.nullable && value === "") {
    return setting.store === "RUNTIME_POLICY" ? null : "";
  }
  return value;
}

function inputType(setting: Setting): "number" | "password" | "text" | "url" {
  if (setting.secret) return "password";
  if (setting.valueType === "INTEGER" || setting.valueType === "DECIMAL") return "number";
  if (setting.valueType === "URL") return "url";
  return "text";
}

function sourceLabel(source: Setting["source"]): string {
  return {
    DATABASE: "数据库",
    DEFAULT: "系统默认",
    ENVIRONMENT: "环境回退",
    UNCONFIGURED: "未配置",
  }[source];
}

function sourceTone(source: Setting["source"]): "danger" | "info" | "neutral" | "success" {
  if (source === "DATABASE") return "success";
  if (source === "ENVIRONMENT") return "info";
  if (source === "UNCONFIGURED") return "danger";
  return "neutral";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function Metric({
  detail,
  label,
  value,
}: Readonly<{ detail: string; label: string; value: number }>) {
  return (
    <article className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function SettingsLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          PLATFORM PARAMETERS
        </span>
        <h1 suppressHydrationWarning>正在读取平台参数…</h1>
      </section>
    </main>
  );
}
