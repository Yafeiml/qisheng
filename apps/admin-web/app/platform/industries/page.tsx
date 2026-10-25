"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ActionIcon } from "../../components/action-icon";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { apiRequest, type MvpSession, platformNavigationPermissions } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type Industry = Readonly<{
  createdAt: string;
  id: string;
  name: string;
  sortOrder: number;
  updatedAt: string;
  generationGuidance: string;
}>;

export default function IndustryManagementPage() {
  const auth = useMvpSession();
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Industry | null>(null);
  const [guidance, setGuidance] = useState("");
  const [saving, setSaving] = useState(false);
  const [guidanceError, setGuidanceError] = useState<string | null>(null);
  const canManage = canManageIndustries(auth.session);

  const load = useCallback(async () => {
    if (!auth.session) return;
    setError(null);
    try {
      setIndustries(
        await apiRequest<Industry[]>("/platform/industries", {
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

  const summary = useMemo(() => `${industries.length} 个可选行业`, [industries.length]);

  async function createIndustry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const industryName = name.trim();
    if (!auth.session || !industryName || !canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest<Industry>("/platform/industries", {
        body: { name: industryName },
        method: "POST",
        token: auth.session.platformToken,
      });
      setName("");
      setNotice(`“${industryName}”已加入行业目录，企业资料中可立即选择。`);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveGuidance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !editing || !canManage || saving) return;
    setSaving(true);
    setGuidanceError(null);
    try {
      const updated = await apiRequest<Industry>(
        `/platform/industries/${editing.id}/generation-guidance`,
        {
          body: { generationGuidance: guidance.trim(), expectedUpdatedAt: editing.updatedAt },
          method: "PATCH",
          token: auth.session.platformToken,
        },
      );
      setIndustries((current) =>
        current.map((industry) => (industry.id === updated.id ? updated : industry)),
      );
      setNotice(`“${updated.name}”的补充规则已保存，将用于新活动和新建生成测试。`);
      setEditing(null);
    } catch (reason) {
      setGuidanceError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }

  if (auth.session === undefined) return <IndustriesLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  return (
    <SaasShell
      active="industries"
      description="维护行业目录与内容生成补充规则。系统按企业所属行业自动使用规则，运营人员无需额外选择。"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      title="行业管理"
      toolbar={
        <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
          刷新行业
        </button>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}

      <section className="metricGrid four">
        <Metric detail="企业资料可直接选择" label="行业总数" value={industries.length} />
        <Metric detail="按维护顺序展示" label="目录状态" value="已启用" />
        <Metric
          detail="事实选点与表达建议"
          label="已配置补充规则"
          value={industries.filter((industry) => industry.generationGuidance?.trim()).length}
        />
        <Metric detail="已有活动保持创建时的规则" label="规则生效范围" value="新活动" />
      </section>

      <section className="contentGrid industryAdminLayout">
        <article className="panel industryCatalog">
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">INDUSTRY CATALOG</span>
              <h2>预设行业</h2>
              <p>
                {summary}。补充规则帮助海报选出主体身份和有依据的重点；未配置时使用通用信息规划。
              </p>
            </div>
          </div>
          <div className="industryOptionList">
            {industries.map((industry) => (
              <div className="industryOption" key={industry.id}>
                <div className="industryOptionHead">
                  <span>{industry.name}</span>
                  <small
                    className={industry.generationGuidance?.trim() ? "industryRuleConfigured" : ""}
                  >
                    {industry.generationGuidance?.trim() ? "行业补充规则" : "通用规则"}
                  </small>
                </div>
                <p>
                  {industry.generationGuidance?.trim() ||
                    "按活动目标与授权资料，规划准确主体身份和两三个具体重点。"}
                </p>
                <div className="industryOptionActions">
                  <small>排序 {industry.sortOrder}</small>
                  <button
                    aria-label={`${canManage ? "编辑" : "查看"}${industry.name}的补充规则`}
                    className="ghostButton industryRuleButton"
                    onClick={() => {
                      setEditing(industry);
                      setGuidance(industry.generationGuidance ?? "");
                      setGuidanceError(null);
                    }}
                    type="button"
                  >
                    <ActionIcon name="file-text" />
                    {canManage ? "编辑规则" : "查看规则"}
                  </button>
                </div>
              </div>
            ))}
            {industries.length === 0 ? <p className="emptyHint">暂未配置行业。</p> : null}
          </div>
        </article>

        <form
          className="panel formPanel industryCreator"
          onSubmit={(event) => void createIndustry(event)}
        >
          <div className="panelHeader">
            <div>
              <span className="sectionKicker">ADD INDUSTRY</span>
              <h2>新增行业</h2>
              <p>添加后会出现在企业资料和客户开通页面的下拉选择中。</p>
            </div>
          </div>
          <label className="field">
            <span>行业名称</span>
            <input
              disabled={!canManage}
              maxLength={100}
              minLength={2}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：新能源"
              required
              value={name}
            />
          </label>
          {!canManage ? <p className="formHint">当前管理员仅有查看权限，无法新增行业。</p> : null}
          <button className="primaryButton block" disabled={busy || !canManage} type="submit">
            {busy ? "正在添加…" : "添加行业"}
          </button>
        </form>
      </section>
      <WorkspaceDrawer
        description="补充本行业的事实选点与表达要求，不需要填写企业事实。保存后用于新活动；已有活动保留创建时的规则。"
        footer={
          <div className="industryRuleFooter">
            <button
              className="ghostButton"
              disabled={saving}
              onClick={() => setEditing(null)}
              type="button"
            >
              {canManage ? "取消" : "关闭"}
            </button>
            {canManage ? (
              <button
                className="primaryButton"
                disabled={saving || guidance.trim() === (editing?.generationGuidance ?? "").trim()}
                form="industry-guidance-form"
                type="submit"
              >
                <ActionIcon name="check" />
                {saving ? "正在保存…" : "保存规则"}
              </button>
            ) : null}
          </div>
        }
        onClose={() => {
          if (!saving) setEditing(null);
        }}
        open={editing !== null}
        title={`${editing?.name ?? "行业"} · 补充规则`}
      >
        <form
          className="industryRuleEditor"
          id="industry-guidance-form"
          onSubmit={(event) => void saveGuidance(event)}
        >
          <p className="industryRuleExplanation">
            通用要求始终保留：主体准确、重点有依据、图片适合手机阅读。行业规则补充展示重点与表达边界，不能替代资料或放宽内容安全要求。
          </p>
          <label className="field">
            <span>行业补充规则</span>
            <textarea
              disabled={saving}
              maxLength={6000}
              onChange={(event) => setGuidance(event.target.value)}
              placeholder="例如：优先寻找哪些身份、产品或服务信息；数字应保留什么口径；哪些表达需要限制。留空时使用通用规则。"
              readOnly={!canManage}
              rows={12}
              value={guidance}
            />
          </label>
          <div className="industryRuleHint">
            <span>留空表示不附加行业规则。</span>
            <span>{guidance.length} / 6000</span>
          </div>
          {!canManage ? <p className="formHint">当前管理员仅有查看权限。</p> : null}
          {guidanceError ? (
            <p className="industryRuleError" role="alert">
              {guidanceError}
            </p>
          ) : null}
        </form>
      </WorkspaceDrawer>
    </SaasShell>
  );
}

function canManageIndustries(session: MvpSession | null | undefined): boolean {
  return Boolean(
    session?.platformAccess.scopes.some(
      (scope) =>
        scope.scopeType === "PLATFORM" && scope.permissions.includes("platform.tenant.manage"),
    ),
  );
}

function Metric({
  detail,
  label,
  value,
}: Readonly<{ detail: string; label: string; value: number | string }>) {
  return (
    <article className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function IndustriesLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          INDUSTRIES
        </span>
        <h1 suppressHydrationWarning>正在读取行业目录…</h1>
      </section>
    </main>
  );
}
