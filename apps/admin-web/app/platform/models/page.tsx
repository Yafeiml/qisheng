"use client";

import type { components } from "@xhs-agentic/contracts";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { WorkspaceTabs } from "../../components/workspace-tabs";
import { randomBrowserId } from "../../lib/browser-capabilities";
import { providerExplanation, providerPurpose } from "../../lib/model-catalog";
import { ApiError, apiRequest, platformNavigationPermissions } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";
import { ModelReadiness } from "./model-readiness";
import styles from "./models.module.css";

type Model = components["schemas"]["ModelDefinitionResponseDto"];
type Provider = components["schemas"]["ModelProviderResponseDto"];
type Catalog = components["schemas"]["ModelCatalogResponseDto"];
type Policy = components["schemas"]["RuntimePolicyResponseDto"];
type Selection = { providerId: string; externalModelId: string };
type Draft = {
  textModel: Selection | null;
  imageModel: Selection | null;
  embeddingModel: Selection | null;
  materialAnalysisModel: Selection | null;
};
type Available = { externalModelId: string; displayName: string; suggestedCapabilities: string[] };
type Discovery = { loading: boolean; models: Available[]; error?: string };
const EMPTY: Draft = {
  textModel: null,
  imageModel: null,
  embeddingModel: null,
  materialAnalysisModel: null,
};

export default function ModelsPage() {
  const auth = useMvpSession();
  const token = auth.session?.platformToken;
  const [catalog, setCatalog] = useState<Catalog>({ providers: [], routes: [] });
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saved, setSaved] = useState<Draft>(EMPTY);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [discovery, setDiscovery] = useState<Record<string, Discovery>>({});
  const discovering = useRef(new Set<string>());
  const [view, setView] = useState<"MODELS" | "PROVIDERS">("MODELS");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerDrawer, setProviderDrawer] = useState<"NEW" | Provider | null>(null);
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const discover = useCallback(
    async (provider: Provider) => {
      if (!token || discovering.current.has(provider.id)) return;
      discovering.current.add(provider.id);
      setDiscovery((current) => ({
        ...current,
        [provider.id]: { loading: true, models: current[provider.id]?.models ?? [] },
      }));
      try {
        const result = await apiRequest<{ models: Available[] }>(
          `/platform/model-providers/${provider.id}/available-models`,
          { token },
        );
        setDiscovery((current) => ({
          ...current,
          [provider.id]: { loading: false, models: result.models },
        }));
      } catch (reason) {
        setDiscovery((current) => ({
          ...current,
          [provider.id]: {
            loading: false,
            models: current[provider.id]?.models ?? [],
            error: messageOf(reason),
          },
        }));
      } finally {
        discovering.current.delete(provider.id);
      }
    },
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const [data, policy] = await Promise.all([
        apiRequest<Catalog>("/platform/model-catalog", { token }),
        apiRequest<Policy>("/platform/runtime-policy", { token }),
      ]);
      setCatalog(data);
      setPolicy(policy);
      const next = draftFrom(data, policy);
      setDraft(next);
      setSaved(next);
      setLoaded(true);
      for (const provider of data.providers)
        if (
          providerPurpose(provider) === "FORMAL" &&
          provider.status === "ACTIVE" &&
          provider.credentialConfigured
        )
          void discover(provider);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [token, discover]);
  useEffect(() => {
    void load();
  }, [load]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const formalProviders = catalog.providers.filter((p) => providerPurpose(p) === "FORMAL");
  const otherProviders = catalog.providers.filter((p) => providerPurpose(p) !== "FORMAL");
  const selectedProviderIds = new Set(
    Object.values(draft).map((selection) => selection?.providerId),
  );
  const choices = catalog.providers.filter(
    (p) => providerPurpose(p) === "FORMAL" || selectedProviderIds.has(p.id),
  );
  function change(key: keyof Draft, selection: Selection | null) {
    setDraft((current) => ({ ...current, [key]: selection }));
    setNotice(null);
    setError(null);
  }
  function openProvider(provider: Provider | "NEW") {
    setProviderDrawer(provider);
    setProviderName(provider === "NEW" ? "" : provider.name);
    setBaseUrl(provider === "NEW" ? "" : provider.baseUrl);
    setApiKey("");
    setDrawerError(null);
  }
  function closeProvider() {
    if (busy) return;
    setProviderDrawer(null);
    setApiKey("");
    setDrawerError(null);
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !providerDrawer) return;
    setBusy(true);
    setDrawerError(null);
    try {
      let provider: Provider;
      if (providerDrawer === "NEW") {
        provider = await apiRequest<Provider>("/platform/model-providers", {
          token,
          method: "POST",
          body: {
            name: providerName.trim(),
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
            code: `API_${randomBrowserId().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
            synthetic: false,
          },
        });
        setCatalog((current) => ({ ...current, providers: [...current.providers, provider] }));
      } else {
        provider = await apiRequest<Provider>(
          `/platform/model-providers/${providerDrawer.id}/connection`,
          {
            token,
            method: "POST",
            body: {
              name: providerName.trim(),
              baseUrl: baseUrl.trim(),
              apiKey: apiKey.trim() || undefined,
              reason: "在模型配置页更新供应商连接",
            },
          },
        );
        setCatalog((current) => ({
          ...current,
          providers: current.providers.map((p) => (p.id === provider.id ? provider : p)),
        }));
      }
      setProviderDrawer(null);
      setApiKey("");
      setNotice("供应商已保存，正在自动读取模型列表。选好模型后点击“保存配置”。");
      void discover(provider);
    } catch (reason) {
      setDrawerError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveModels(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<components["schemas"]["SaveModelSetupResponseDto"]>(
        "/platform/model-setup",
        { token, method: "POST", body: draft },
      );
      setPolicy(result.runtimePolicy);
      setSaved(draft);
      try {
        setCatalog(await apiRequest<Catalog>("/platform/model-catalog", { token }));
      } catch {
        /* Save succeeded; retain the selected configuration if catalog refresh fails. */
      }
      setNotice("配置已保存，四项模型选择已统一生效。");
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.status >= 400 && reason.status < 500
          ? `保存失败，原配置保持不变。${messageOf(reason)}`
          : "暂未确认保存结果，请刷新配置后核对。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function providerOperation(provider: Provider, operation: "enable" | "disable" | "reset") {
    if (!token) return;
    setBusy(true);
    setDrawerError(null);
    try {
      const result = await apiRequest<Provider>(
        `/platform/model-providers/${provider.id}/${operation === "reset" ? "circuit/reset" : "settings"}`,
        {
          token,
          method: "POST",
          body:
            operation === "reset"
              ? { reason: "管理员在模型配置页重置调用保护" }
              : {
                  status: operation === "enable" ? "ACTIVE" : "DISABLED",
                  emergency: operation === "disable",
                  reason: "管理员在模型配置页变更供应商启用状态",
                },
        },
      );
      setCatalog((current) => ({
        ...current,
        providers: current.providers.map((p) => (p.id === result.id ? result : p)),
      }));
      setProviderDrawer(result);
      if (operation === "enable") void discover(result);
    } catch (reason) {
      setDrawerError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  if (auth.session === undefined) return <main className="loadingState">正在加载模型配置…</main>;
  if (auth.session === null)
    return <MvpSetup busy={busy} error={auth.error} initialize={auth.initialize} />;
  return (
    <SaasShell
      active="models"
      mode="platform"
      title="模型配置"
      description="添加供应商，选择文案、生图、Embedding 和资料理解模型，统一保存。"
      navigationPermissions={platformNavigationPermissions(auth.session)}
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <div className="workspaceActionBar">
        <WorkspaceTabs
          active={view}
          ariaLabel="模型配置标签页"
          onChange={setView}
          tabs={[
            { key: "MODELS", label: "模型选择" },
            { key: "PROVIDERS", label: "供应商", count: formalProviders.length },
          ]}
        />
      </div>
      {view === "PROVIDERS" ? (
        <section className={`panel ${styles.providers}`} aria-label="模型供应商">
          <header className={styles.sectionHeader}>
            <h2>模型供应商</h2>
            <button
              className="ghostButton"
              type="button"
              disabled={!loaded && !error}
              onClick={loaded ? () => openProvider("NEW") : () => void load()}
            >
              {loaded ? "＋ 添加供应商" : error ? "重新加载" : "加载中…"}
            </button>
          </header>
          <p className={styles.hint}>填写 API 地址和密钥，自动读取可用模型。</p>
          <div className={styles.providerGrid}>
            {!formalProviders.length ? (
              <div className={styles.empty}>
                <p>还没有添加供应商</p>
                <button className="primaryButton" type="button" onClick={() => openProvider("NEW")}>
                  添加第一个供应商
                </button>
              </div>
            ) : (
              formalProviders.map((provider) => {
                const result = discovery[provider.id];
                return (
                  <article className={styles.provider} key={provider.id}>
                    <div className={styles.providerHeading}>
                      <strong>{provider.name}</strong>
                      <StatusBadge
                        tone={
                          provider.status !== "ACTIVE"
                            ? "neutral"
                            : result?.error
                              ? "warning"
                              : "success"
                        }
                      >
                        {provider.status !== "ACTIVE"
                          ? "已停用"
                          : result?.loading
                            ? "读取中"
                            : result?.error
                              ? "读取失败"
                              : result
                                ? "列表已读取"
                                : "等待读取"}
                      </StatusBadge>
                    </div>
                    <span className={styles.url}>{provider.baseUrl}</span>
                    <small className={styles.hint}>
                      {result?.loading
                        ? "正在读取模型列表…"
                        : result?.error
                          ? result.error
                          : result
                            ? `${result.models.length} 个可选模型`
                            : "等待读取模型列表"}
                    </small>
                    <div className={styles.providerActions}>
                      <button
                        type="button"
                        disabled={result?.loading || provider.status !== "ACTIVE"}
                        onClick={() => void discover(provider)}
                      >
                        刷新模型列表
                      </button>
                      <button type="button" onClick={() => openProvider(provider)}>
                        连接设置
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
          {otherProviders.length ? (
            <details className={styles.testRecords}>
              <summary>开发与测试连接（{otherProviders.length}）</summary>
              {otherProviders.map((provider) => (
                <article key={provider.id}>
                  <strong>{provider.name}</strong>
                  <p>{providerExplanation(provider)}</p>
                  <button type="button" onClick={() => openProvider(provider)}>
                    连接设置
                  </button>
                </article>
              ))}
            </details>
          ) : null}
        </section>
      ) : (
        <form
          className={`panel ${styles.configuration}`}
          onSubmit={saveModels}
          aria-label="模型配置"
        >
          <header className={styles.sectionHeader}>
            <h2>选择模型</h2>
            <span className={styles.hint}>
              {!loaded ? (error ? "加载失败" : "加载中…") : dirty ? "有未保存的更改" : "当前配置"}
            </span>
          </header>
          <p className={styles.hint}>标有 * 的模型为必填项，其余可选。</p>
          {!formalProviders.length ? (
            <p className={styles.hint}>
              请先到
              <button
                className={styles.inlineAction}
                type="button"
                onClick={() => setView("PROVIDERS")}
              >
                供应商
              </button>
              标签页添加供应商。
            </p>
          ) : null}
          <div className={styles.selectionGrid}>
            <ModelPicker
              label="文案模型"
              description="用于生成活动文案。"
              capability="TEXT"
              value={draft.textModel}
              providers={choices}
              discovery={discovery}
              onChange={(selection) => change("textModel", selection)}
              disabled={busy || !loaded}
            />
            <ModelPicker
              label="生图模型"
              description="用于生成活动配图。"
              capability="IMAGE"
              value={draft.imageModel}
              providers={choices}
              discovery={discovery}
              onChange={(selection) => change("imageModel", selection)}
              disabled={busy || !loaded}
            />
            <ModelPicker
              label="Embedding 模型"
              description="可选增强语义检索；留空使用本地基础检索，无需额外模型。"
              capability="EMBEDDING"
              value={draft.embeddingModel}
              providers={choices.filter((p) => !p.synthetic)}
              discovery={discovery}
              onChange={(selection) => change("embeddingModel", selection)}
              disabled={busy || !loaded}
              optional="本地基础检索"
            />
            <ModelPicker
              label="资料理解模型"
              description="留空跟随文案模型；识别资料并提炼信息，需要支持图片输入。"
              capability="TEXT"
              value={draft.materialAnalysisModel}
              providers={choices.filter((p) => !p.synthetic)}
              discovery={discovery}
              onChange={(selection) => change("materialAnalysisModel", selection)}
              disabled={busy || !loaded}
              optional="跟随文案模型"
            />
          </div>
          {catalog.routes.some((r) => r.scopeType !== "PLATFORM") ? (
            <details className={styles.advanced}>
              <summary>高级设置</summary>
              {catalog.routes.filter((r) => r.scopeType !== "PLATFORM").length ? (
                <p className={styles.hint}>
                  已有 {catalog.routes.filter((r) => r.scopeType !== "PLATFORM").length}{" "}
                  项集团或企业专用配置，仍优先于平台默认配置。
                </p>
              ) : null}
            </details>
          ) : null}
          <footer className={styles.saveBar}>
            <span className={styles.hint}>四个用途可以选择不同供应商的模型。</span>
            <button
              className="primaryButton"
              type={loaded ? "submit" : "button"}
              onClick={!loaded ? () => void load() : undefined}
              disabled={
                busy ||
                (!loaded
                  ? !error
                  : !draft.textModel?.externalModelId ||
                    !draft.imageModel?.externalModelId ||
                    (Boolean(draft.embeddingModel) && !draft.embeddingModel?.externalModelId) ||
                    (Boolean(draft.materialAnalysisModel) &&
                      !draft.materialAnalysisModel?.externalModelId))
              }
            >
              {!loaded ? (error ? "重新加载" : "加载中…") : busy ? "正在保存…" : "保存配置"}
            </button>
          </footer>
        </form>
      )}
      {loaded && token && policy ? (
        <ModelReadiness
          token={token}
          catalog={catalog}
          policy={policy}
          disabled={busy || dirty || providerDrawer !== null}
          setBusy={setBusy}
          onCatalog={setCatalog}
        />
      ) : null}
      <WorkspaceDrawer
        open={providerDrawer !== null}
        onClose={closeProvider}
        title={providerDrawer === "NEW" ? "添加供应商" : "连接设置"}
        description={
          providerDrawer === "NEW"
            ? "连接后会自动读取模型列表。"
            : "修改连接信息后会重新读取模型列表。"
        }
      >
        <form className={styles.providerForm} onSubmit={saveProvider}>
          {drawerError ? <FeedbackMessage tone="error">{drawerError}</FeedbackMessage> : null}
          <label>
            供应商名称
            <input
              value={providerName}
              onChange={(event) => setProviderName(event.target.value)}
              placeholder="例如：白山智算"
              required
              minLength={2}
              maxLength={120}
              disabled={busy}
            />
          </label>
          <label>
            API 地址
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              type="url"
              required
              disabled={busy}
            />
          </label>
          {providerDrawer === "NEW" || (providerDrawer && !providerDrawer.synthetic) ? (
            <label>
              API Key
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  providerDrawer === "NEW" ? "粘贴供应商提供的密钥" : "留空则保留现有密钥"
                }
                type="password"
                autoComplete="new-password"
                required={providerDrawer === "NEW"}
                minLength={4}
                disabled={busy}
              />
            </label>
          ) : null}
          <button className="primaryButton" type="submit" disabled={busy}>
            {busy ? "正在连接…" : providerDrawer === "NEW" ? "连接并读取模型" : "保存连接"}
          </button>
        </form>
        {providerDrawer && providerDrawer !== "NEW" ? (
          <details className={styles.advanced}>
            <summary>连接维护</summary>
            <p className={styles.hint}>停用供应商会影响所有使用它的模型。</p>
            <button
              className="ghostButton"
              type="button"
              disabled={busy}
              onClick={() =>
                void providerOperation(
                  providerDrawer,
                  providerDrawer.status === "ACTIVE" ? "disable" : "enable",
                )
              }
            >
              {providerDrawer.status === "ACTIVE" ? "停用供应商" : "启用供应商"}
            </button>
            {providerDrawer.circuitState !== "CLOSED" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void providerOperation(providerDrawer, "reset")}
              >
                重置调用保护
              </button>
            ) : null}
          </details>
        ) : null}
      </WorkspaceDrawer>
    </SaasShell>
  );
}

function ModelPicker({
  label,
  description,
  capability,
  value,
  providers,
  discovery,
  onChange,
  disabled,
  optional,
}: {
  label: string;
  description: string;
  capability: string;
  value: Selection | null;
  providers: Provider[];
  discovery: Record<string, Discovery>;
  onChange: (selection: Selection | null) => void;
  disabled: boolean;
  optional?: string;
}) {
  const controlId = useId();
  const [manual, setManual] = useState(false);
  const [search, setSearch] = useState("");
  const provider = providers.find((p) => p.id === value?.providerId);
  const result = provider ? discovery[provider.id] : undefined;
  const choices = new Map<string, Available>();
  for (const model of result?.models ?? []) choices.set(model.externalModelId, model);
  for (const model of provider?.models ?? [])
    if (model.status === "ACTIVE")
      choices.set(model.externalModelId, {
        externalModelId: model.externalModelId,
        displayName: model.displayName,
        suggestedCapabilities: model.capabilities,
      });
  const models = [...choices.values()].filter(
    (m) =>
      !search ||
      `${m.externalModelId} ${m.displayName}`.toLowerCase().includes(search.toLowerCase()),
  );
  const suggested = models.filter((m) => m.suggestedCapabilities.includes(capability));
  const others = models.filter((m) => !m.suggestedCapabilities.includes(capability));
  const missingSelected =
    value?.externalModelId && !models.some((m) => m.externalModelId === value.externalModelId);
  return (
    <section className={styles.picker} aria-label={label}>
      <div className={styles.pickerTitle}>
        <h3>
          <span>
            {!optional ? (
              <span className={styles.requiredMarker} aria-hidden="true">
                *
              </span>
            ) : null}
            {label}
          </span>
          <span className={styles.requirement}>{optional ? "可选" : "必填"}</span>
        </h3>
        <p>{description}</p>
      </div>
      <div className={styles.pickerFields}>
        <label>
          <span>供应商</span>
          <select
            aria-label={`${label}供应商`}
            value={value?.providerId ?? ""}
            disabled={disabled}
            required={!optional}
            onChange={(event) => {
              onChange(
                event.target.value ? { providerId: event.target.value, externalModelId: "" } : null,
              );
              setSearch("");
              setManual(false);
            }}
          >
            <option value="">{optional ?? "选择供应商"}</option>
            {providers.map((p) => (
              <option value={p.id} key={p.id} disabled={p.status !== "ACTIVE"}>
                {p.name}
                {p.status !== "ACTIVE" ? "（已停用）" : p.synthetic ? "（开发演示）" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.modelField}>
          <label htmlFor={controlId}>
            <span>模型</span>
            {manual ? (
              <input
                id={controlId}
                aria-label={`${label} ID`}
                value={value?.externalModelId ?? ""}
                onChange={(event) =>
                  provider &&
                  onChange({ providerId: provider.id, externalModelId: event.target.value })
                }
                placeholder="填写供应商提供的模型 ID"
                required={Boolean(provider)}
                maxLength={200}
                disabled={disabled || !provider}
              />
            ) : (
              <select
                id={controlId}
                aria-label={label}
                value={value?.externalModelId ?? ""}
                required={Boolean(provider)}
                disabled={disabled || !provider}
                onChange={(event) =>
                  provider &&
                  onChange({ providerId: provider.id, externalModelId: event.target.value })
                }
              >
                <option value="">
                  {!provider && optional
                    ? optional
                    : result?.loading
                      ? "正在读取模型…"
                      : "选择模型"}
                </option>
                {missingSelected ? (
                  <option value={value.externalModelId}>{value.externalModelId}（已选择）</option>
                ) : null}
                {suggested.length ? (
                  <optgroup label="适合此用途">
                    {suggested.map((m) => (
                      <option key={m.externalModelId} value={m.externalModelId}>
                        {m.displayName}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {others.length ? (
                  <optgroup label="其他模型">
                    {others.map((m) => (
                      <option key={m.externalModelId} value={m.externalModelId}>
                        {m.displayName}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            )}
          </label>
          {!manual && choices.size > 12 ? (
            <input
              className={styles.search}
              type="search"
              aria-label={`${label}搜索`}
              placeholder="输入名称筛选模型"
              value={search}
              disabled={disabled}
              onChange={(event) => setSearch(event.target.value)}
            />
          ) : null}
          {provider ? (
            <button
              className={styles.manualToggle}
              type="button"
              disabled={disabled}
              onClick={() => setManual(!manual)}
            >
              {manual ? "返回模型列表" : "找不到模型？手动输入 ID"}
            </button>
          ) : null}
        </div>
      </div>
      {result?.error && !manual ? (
        <small className={styles.hint}>
          列表暂时无法读取，已保存的模型仍可选择，也可以手动输入 ID。
        </small>
      ) : null}
    </section>
  );
}

function selectionOf(model?: Pick<Model, "providerId" | "externalModelId">): Selection | null {
  return model ? { providerId: model.providerId, externalModelId: model.externalModelId } : null;
}
function draftFrom(catalog: Catalog, policy: Policy): Draft {
  const route = catalog.routes.find((r) => r.scopeType === "PLATFORM");
  const models = catalog.providers.flatMap((p) => p.models ?? []);
  return {
    textModel: selectionOf(route?.textModel),
    imageModel: selectionOf(route?.imageModel),
    embeddingModel: selectionOf(models.find((m) => m.id === policy.embeddingModelId)),
    materialAnalysisModel: selectionOf(models.find((m) => m.id === policy.materialAnalysisModelId)),
  };
}
