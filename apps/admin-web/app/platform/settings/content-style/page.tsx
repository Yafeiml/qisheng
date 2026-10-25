"use client";

import type { components } from "@xhs-agentic/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FeedbackMessage, useFeedbackToast } from "../../../components/feedback-toast";
import { MvpSetup } from "../../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../../components/saas-shell";
import { WorkspaceDrawer } from "../../../components/workspace-drawer";
import { WorkspaceTabs } from "../../../components/workspace-tabs";
import { randomBrowserId } from "../../../lib/browser-capabilities";
import { apiRequest, platformNavigationPermissions } from "../../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../../lib/use-mvp-session";
import styles from "./styles.module.css";

type Configuration = components["schemas"]["GenerationStylesResponseDto"];
type Preset = components["schemas"]["GenerationStylePresetDto"];
type Kind = "contentDirections" | "imageStyles";

export default function ContentStylePage() {
  const auth = useMvpSession();
  const feedback = useFeedbackToast();
  const token = auth.session?.platformToken;
  const [data, setData] = useState<Configuration | null>(null);
  const [kind, setKind] = useState<Kind>("contentDirections");
  const [copyBase, setCopyBase] = useState("");
  const [imageBase, setImageBase] = useState("");
  const [editing, setEditing] = useState<Preset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const locked = useRef(false);
  const title = kind === "contentDirections" ? "内容方向" : "图片风格";

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter intentionally starts a new request.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiRequest<Configuration>("/platform/generation-styles", { token })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setCopyBase(result.copyBasePrompt);
        setImageBase(result.imageBasePrompt);
      })
      .catch((reason) => {
        if (!cancelled) setError(messageOf(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, loadAttempt]);

  const unsaved = Boolean(
    editing || (data && (copyBase !== data.copyBasePrompt || imageBase !== data.imageBasePrompt)),
  );
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  async function save(next: Configuration, message: string) {
    if (!token || locked.current) return false;
    if (new TextEncoder().encode(JSON.stringify(next)).length > 90_000) {
      feedback.notify({ tone: "error", content: "提示词配置总量过大，请精简提示词后保存。" });
      return false;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<Configuration>("/platform/generation-styles", {
        token,
        method: "POST",
        body: next,
      });
      setData(result);
      setNotice(message);
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function savePreset(event: FormEvent) {
    event.preventDefault();
    if (!data || !editing) return;
    let presets = [...data[kind]];
    const index = presets.findIndex((p) => p.id === editing.id);
    if (index < 0) presets.push(editing);
    else presets[index] = editing;
    if (editing.isDefault) presets = presets.map((p) => ({ ...p, isDefault: p.id === editing.id }));
    if (await save({ ...data, [kind]: presets }, `${title}已保存，新活动可立即使用。`))
      setEditing(null);
  }

  function move(index: number, offset: number) {
    if (!data) return;
    const presets = [...data[kind]];
    const target = index + offset;
    if (!presets[index] || !presets[target]) return;
    [presets[index], presets[target]] = [presets[target], presets[index]];
    void save({ ...data, [kind]: presets }, "展示顺序已保存。");
  }

  if (auth.session === undefined) return <main className="pageLoading">正在读取生成风格…</main>;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  return (
    <SaasShell
      active="settings"
      activeSub="content-style"
      mode="platform"
      navigationPermissions={platformNavigationPermissions(auth.session)}
      title="生成风格"
      description="统一维护小红书文案与图片基础要求。方向和风格预设保留给内部测试，新活动按传播目标生成。"
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <WorkspaceTabs
        active={kind}
        onChange={setKind}
        ariaLabel="生成风格分类"
        tabs={[
          { key: "contentDirections", label: "内容方向", count: data?.contentDirections.length },
          { key: "imageStyles", label: "图片风格", count: data?.imageStyles.length },
        ]}
      />
      {data ? (
        <>
          <details className={`panel ${styles.base}`}>
            <summary>
              {kind === "contentDirections" ? "文案" : "图片"}基础要求{" "}
              <small>对所有{title}生效</small>
            </summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(
                  {
                    ...data,
                    ...(kind === "contentDirections"
                      ? { copyBasePrompt: copyBase }
                      : { imageBasePrompt: imageBase }),
                  },
                  "基础要求已保存，只影响新活动。",
                );
              }}
            >
              <label className="field">
                <span>{kind === "contentDirections" ? "文案" : "图片"}基础提示词</span>
                <textarea
                  aria-label={kind === "contentDirections" ? "文案基础提示词" : "图片基础提示词"}
                  required
                  minLength={4}
                  maxLength={4000}
                  rows={7}
                  value={kind === "contentDirections" ? copyBase : imageBase}
                  onChange={(event) =>
                    kind === "contentDirections"
                      ? setCopyBase(event.target.value)
                      : setImageBase(event.target.value)
                  }
                />
              </label>
              <button
                className="primaryButton"
                disabled={
                  busy ||
                  (kind === "contentDirections"
                    ? copyBase === data.copyBasePrompt
                    : imageBase === data.imageBasePrompt)
                }
                type="submit"
              >
                保存基础要求
              </button>
            </form>
          </details>
          <section className={`panel ${styles.presets}`} aria-label={`${title}预设`}>
            <header className={styles.header}>
              <div>
                <h2>{title}预设</h2>
                <p>用户不作选择时使用默认项。停用后不再供新活动选择，历史活动仍保留原方案。</p>
              </div>
              <button
                className="primaryButton"
                type="button"
                disabled={busy || data[kind].length >= 40}
                onClick={() => {
                  setError(null);
                  setEditing({
                    id: randomBrowserId(),
                    name: "",
                    description: "",
                    prompt: "",
                    enabled: true,
                    isDefault: false,
                  });
                }}
              >
                新增{title}
              </button>
            </header>
            <div className={styles.list}>
              {data[kind].map((preset, index) => (
                <article key={preset.id} className={styles.card}>
                  <div>
                    <div className={styles.name}>
                      <h3>{preset.name}</h3>
                      {preset.isDefault ? <StatusBadge tone="success">默认</StatusBadge> : null}
                      {!preset.enabled ? <StatusBadge tone="warning">已停用</StatusBadge> : null}
                    </div>
                    <p>{preset.description || "暂无说明"}</p>
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="ghostButton"
                      disabled={busy || index === 0}
                      aria-label={`上移${preset.name}`}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ghostButton"
                      disabled={busy || index === data[kind].length - 1}
                      aria-label={`下移${preset.name}`}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="ghostButton"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setEditing({ ...preset });
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ghostButton"
                      disabled={busy || preset.isDefault || !preset.enabled}
                      onClick={() =>
                        void save(
                          {
                            ...data,
                            [kind]: data[kind].map((p) => ({
                              ...p,
                              isDefault: p.id === preset.id,
                            })),
                          },
                          `默认${title}已更新。`,
                        )
                      }
                    >
                      设为默认
                    </button>
                    <button
                      type="button"
                      className="ghostButton"
                      disabled={busy || preset.isDefault}
                      title={preset.isDefault ? "请先将其他预设设为默认，再停用此项" : undefined}
                      onClick={() =>
                        void save(
                          {
                            ...data,
                            [kind]: data[kind].map((p) =>
                              p.id === preset.id ? { ...p, enabled: !p.enabled } : p,
                            ),
                          },
                          preset.enabled ? "预设已停用。" : "预设已启用。",
                        )
                      }
                    >
                      {preset.enabled ? "停用" : "启用"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : loading ? (
        <p>正在加载预设…</p>
      ) : (
        <section className="panel" aria-label="预设加载失败">
          <p>暂时无法读取风格预设，请重试。</p>
          <button
            type="button"
            className="primaryButton"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            重新加载
          </button>
        </section>
      )}
      <WorkspaceDrawer
        open={Boolean(editing)}
        title={`编辑${title}`}
        description="名称和说明展示给企业用户，提示词用于实际生成。保存后新活动生效。"
        onClose={() => {
          if (!busy) setEditing(null);
        }}
      >
        {editing ? (
          <form onSubmit={savePreset} className={styles.editor}>
            {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
            <label className="field">
              <span>预设名称</span>
              <input
                required
                maxLength={60}
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>简短说明</span>
              <input
                maxLength={240}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </label>
            <label className="field">
              <span>生成提示词</span>
              <textarea
                aria-label="生成提示词"
                required
                minLength={4}
                maxLength={3000}
                rows={12}
                value={editing.prompt}
                onChange={(event) => setEditing({ ...editing, prompt: event.target.value })}
              />
              <small>与基础要求、活动主题及授权资料共同参与生成。</small>
            </label>
            <fieldset className={styles.options}>
              <legend className={styles.optionsLegend}>预设状态</legend>
              <label className={styles.option}>
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  disabled={editing.isDefault}
                  onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })}
                />
                <span>启用，供新活动选择</span>
              </label>
              <label className={styles.option}>
                <input
                  type="checkbox"
                  checked={editing.isDefault}
                  disabled={
                    !editing.enabled || data?.[kind].some((p) => p.id === editing.id && p.isDefault)
                  }
                  onChange={(event) => setEditing({ ...editing, isDefault: event.target.checked })}
                />
                <span>设为默认</span>
              </label>
            </fieldset>
            <div className={styles.editorActions}>
              <button className="primaryButton" type="submit" disabled={busy}>
                {busy ? "正在保存…" : "保存预设"}
              </button>
            </div>
          </form>
        ) : null}
      </WorkspaceDrawer>
    </SaasShell>
  );
}
