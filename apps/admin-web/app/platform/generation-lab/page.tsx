"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon } from "../../components/action-icon";
import { FeedbackMessage, useFeedbackToast } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { API_BASE_URL, apiRequest, platformNavigationPermissions } from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";
import { LabImage, LabResult } from "./results";
import styles from "./styles.module.css";
import { actionLabel, type Copy, emptyCopy, type Options, type Run, statusLabel } from "./types";

const base = "/platform/generation-lab";
type Prompts = {
  copyBasePrompt: string;
  imageBasePrompt: string;
  contentDirectionPrompt: string;
  imageStylePrompt: string;
};
const initialPrompts: Prompts = {
  copyBasePrompt: "",
  imageBasePrompt: "",
  contentDirectionPrompt: "",
  imageStylePrompt: "",
};

export default function GenerationLabPage() {
  const auth = useMvpSession();
  const feedback = useFeedbackToast();
  const token = auth.session?.platformToken;
  const [options, setOptions] = useState<Options | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [comparison, setComparison] = useState<Run | null>(null);
  const [enterpriseId, setEnterpriseId] = useState("");
  const medical = Boolean(run?.input.selectionSnapshot);
  const [enterpriseSearch, setEnterpriseSearch] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [keywords, setKeywords] = useState("");
  const [direction, setDirection] = useState("");
  const [imageStyle, setImageStyle] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [logo, setLogo] = useState("");
  const [copy, setCopy] = useState<Copy>(emptyCopy);
  const [prompts, setPrompts] = useState<Prompts>(initialPrompts);
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveKind, setSaveKind] = useState("CONTENT");
  const [saveName, setSaveName] = useState("");
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const draft = run?.status === "DRAFT";
  const running = Boolean(
    run &&
      (["CHECKING", "QUEUED", "RUNNING"].includes(run.status) ||
        ["QUEUED", "RUNNING"].includes(run.reviewStatus)),
  );

  const adopt = useCallback((next: Run) => {
    setRun(next);
    setComparison(null);
    setEnterpriseId(next.enterpriseId);
    setTitle(next.title);
    setBrief(next.input.brief);
    setKeywords(next.input.keywords);
    const style = next.input.generationStyle;
    setDirection(style.contentDirection.id);
    setImageStyle(style.imageStyle.id);
    setPrompts({
      copyBasePrompt: style.copyBasePrompt,
      imageBasePrompt: style.imageBasePrompt,
      contentDirectionPrompt: style.contentDirection.prompt,
      imageStylePrompt: style.imageStyle.prompt,
    });
    setCopy(next.result?.copy ?? next.input.copy ?? emptyCopy);
    setRefs(next.input.imageAssets.filter((a) => a.usage === "REFERENCE").map((a) => a.artifactId));
    setLogo(next.input.imageAssets.find((a) => a.usage === "LOGO")?.artifactId ?? "");
    window.history.replaceState(null, "", `${base}?run=${next.id}`);
  }, []);
  async function refreshHistory() {
    const rows = await apiRequest<Run[]>(base, { token });
    setHistory(rows);
    setHasMore(rows.length === 40);
  }
  async function perform(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void Promise.all([
      apiRequest<Options>(`${base}/options`, { token }),
      apiRequest<Run[]>(base, { token }),
    ])
      .then(async ([data, rows]) => {
        if (cancelled) return;
        setOptions(data);
        setHistory(rows);
        setHasMore(rows.length === 40);
        setDirection(data.styles.contentDirections.find((p) => p.enabled && p.isDefault)?.id ?? "");
        setImageStyle(data.styles.imageStyles.find((p) => p.enabled && p.isDefault)?.id ?? "");
        const id = new URLSearchParams(window.location.search).get("run");
        if (id) {
          const saved = await apiRequest<Run>(`${base}/${encodeURIComponent(id)}`, { token });
          if (!cancelled) adopt(saved);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(messageOf(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [token, adopt]);

  const runId = run?.id;
  useEffect(() => {
    if (!token || !runId || !running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await apiRequest<Run>(`${base}/${runId}`, { token });
        if (cancelled) return;
        setRun(next);
        if (next.result?.copy) setCopy(next.result.copy);
        if (
          !["CHECKING", "QUEUED", "RUNNING"].includes(next.status) &&
          !["QUEUED", "RUNNING"].includes(next.reviewStatus)
        )
          return;
      } catch (reason) {
        if (!cancelled) setError(messageOf(reason));
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, runId, running]);

  async function check(event: FormEvent) {
    event.preventDefault();
    await perform(async () => {
      adopt(
        await apiRequest<Run>(`${base}/check`, {
          token,
          method: "POST",
          body: {
            enterpriseId,
            title,
            brief,
            keywords,
            contentDirectionPresetId: direction,
            imageStylePresetId: imageStyle,
          },
        }),
      );
      await refreshHistory();
    });
  }
  function execute(action: "COPY" | "IMAGE" | "FULL") {
    if (!run) return;
    void perform(async () => {
      setRun(
        await apiRequest<Run>(`${base}/${run.id}/execute`, {
          token,
          method: "POST",
          body: {
            action,
            ...(!medical ? prompts : {}),
            referenceArtifactIds: refs,
            ...(!medical ? { logoArtifactId: logo } : {}),
            ...(action === "IMAGE" && !medical ? { copy } : {}),
          },
        }),
      );
      await refreshHistory();
    });
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!run || !file || !token) return;
    if (file.size > 4 * 1024 * 1024) {
      feedback.notify({ tone: "error", content: "图片不能超过 4 MB", field: fileInput });
      return;
    }
    await perform(async () => {
      const form = new FormData();
      form.set("file", file);
      form.set("description", description);
      const response = await fetch(`${API_BASE_URL}${base}/${run.id}/assets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
        body: form,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          typeof data.message === "string" ? data.message : "上传失败，请检查图片与说明",
        );
      }
      setRun(await response.json());
      setFile(null);
      setDescription("");
      if (fileInput.current) fileInput.current.value = "";
    });
  }
  function reset() {
    if (medical) {
      setTitle("");
      setBrief("");
      setKeywords("");
      setDirection(
        options?.styles.contentDirections.find((p) => p.enabled && p.isDefault)?.id ?? "",
      );
      setImageStyle(options?.styles.imageStyles.find((p) => p.enabled && p.isDefault)?.id ?? "");
      setPrompts(initialPrompts);
    }
    setRun(null);
    setComparison(null);
    setCopy(emptyCopy);
    setRefs([]);
    setLogo("");
    setError("");
    setNotice("");
    setSaveOpen(false);
    window.history.replaceState(null, "", base);
  }
  const temporary = run?.assets.filter((a) => a.kind === "REFERENCE") ?? [];
  const referenceCount = temporary.length + refs.length;
  const locked = busy || !draft;

  if (auth.session === undefined) return <main className="pageLoading">正在读取生成测试台…</main>;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  return (
    <SaasShell
      active="generation-lab"
      mode="platform"
      title="生成测试台"
      description="用真实素材微调文案与海报。供应商调用仍会产生费用。"
      navigationPermissions={platformNavigationPermissions(auth.session)}
    >
      <div className={styles.lab}>
        {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
        {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
        <div className={styles.toolbar}>
          <div className={styles.row}>
            <span className={styles.badge}>独立实验 · 不影响线上</span>
            <small>每次 1 份结果 · 无自动重试 · 手动审核</small>
          </div>
          <button type="button" disabled={busy} onClick={reset}>
            <ActionIcon name="plus" />
            新建测试
          </button>
        </div>
        <div className={styles.workspace}>
          <section className={styles.editor} aria-label="测试配置">
            <details className={styles.inputDetails} open={!run || draft}>
              <summary>
                01 / 测试需求{run && !draft ? ` · ${run.input.enterpriseName}` : ""}
              </summary>
              <form onSubmit={check} className={styles.form}>
                <div className={styles.row}>
                  <input
                    aria-label="搜索企业"
                    placeholder="输入企业名称查找"
                    value={enterpriseSearch}
                    disabled={busy || Boolean(run)}
                    onChange={(e) => setEnterpriseSearch(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={busy || Boolean(run)}
                    onClick={() =>
                      void perform(async () =>
                        setOptions(
                          await apiRequest<Options>(
                            `${base}/options?search=${encodeURIComponent(enterpriseSearch)}`,
                            { token },
                          ),
                        ),
                      )
                    }
                  >
                    查找
                  </button>
                </div>
                <label>
                  测试企业
                  <select
                    required
                    aria-label="测试企业"
                    value={enterpriseId}
                    disabled={busy || Boolean(run)}
                    onChange={(e) => setEnterpriseId(e.target.value)}
                  >
                    <option value="">请选择企业</option>
                    {enterpriseId && !options?.enterprises.some((e) => e.id === enterpriseId) ? (
                      <option value={enterpriseId}>{run?.input.enterpriseName}</option>
                    ) : null}
                    {options?.enterprises.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} · {e.tenant.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  测试名称
                  <input
                    required
                    minLength={2}
                    maxLength={200}
                    value={title}
                    disabled={busy || Boolean(run)}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：新品分享 · 生活实拍风格"
                  />
                </label>
                {
                  <>
                    <label>
                      活动需求
                      <textarea
                        required
                        minLength={4}
                        maxLength={6000}
                        rows={4}
                        value={brief}
                        disabled={busy || Boolean(run)}
                        onChange={(e) => setBrief(e.target.value)}
                        placeholder="描述宣传目标、核心主体和特殊要求，不必先写成文案"
                      />
                    </label>
                    <div className={styles.twoColumns}>
                      <label>
                        内容方向
                        <select
                          value={direction}
                          aria-label="内容方向"
                          disabled={busy || Boolean(run)}
                          onChange={(e) => setDirection(e.target.value)}
                        >
                          {options?.styles.contentDirections
                            .filter((p) => p.enabled)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        图片风格
                        <select
                          value={imageStyle}
                          aria-label="图片风格"
                          disabled={busy || Boolean(run)}
                          onChange={(e) => setImageStyle(e.target.value)}
                        >
                          {options?.styles.imageStyles
                            .filter((p) => p.enabled)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <label>
                      素材检索关键词
                      <input
                        maxLength={1000}
                        value={keywords}
                        disabled={busy || Boolean(run)}
                        onChange={(e) => setKeywords(e.target.value)}
                        placeholder="留空则按活动需求检索"
                      />
                    </label>
                  </>
                }
                {!run ? (
                  <button className={styles.primary} type="submit" disabled={busy || !options}>
                    <ActionIcon name="file-search" />
                    {busy ? "正在检查…" : "检查素材"}
                  </button>
                ) : (
                  <small>需求与素材已保存。调整需求或检索关键词，请点击“新建测试”。</small>
                )}
              </form>
            </details>
            {run ? (
              <>
                <section className={styles.section}>
                  <div className={styles.row}>
                    <h2>02 / 素材与参考图</h2>
                    <span className={styles.badge}>{referenceCount} / 3 张</span>
                  </div>
                  <details className={styles.details}>
                    <summary>文字依据 · {run.input.retrieval.hits.length} 条</summary>
                    <small>检索词：{run.input.retrieval.query}</small>
                    {run.input.retrieval.hits.length ? (
                      run.input.retrieval.hits.map((h) => (
                        <div className={styles.evidence} key={`${h.materialId}-${h.snippet}`}>
                          <strong>{h.materialTitle}</strong>
                          <p>{h.snippet}</p>
                          <small>匹配分数 {h.score.toFixed(3)}</small>
                        </div>
                      ))
                    ) : (
                      <p>未检索到文字资料。请检查关键词，避免生成没有依据的宣传内容。</p>
                    )}
                  </details>
                  <div className={styles.references}>
                    {run.input.retrieval.images
                      ?.filter(
                        (a) => a.usage === "REFERENCE" && (draft || refs.includes(a.artifactId)),
                      )
                      .map((a) => (
                        <label className={styles.reference} key={a.artifactId}>
                          <LabImage
                            runId={run.id}
                            assetId={a.artifactId}
                            token={token ?? ""}
                            alt={a.title}
                          />
                          <span className={styles.choice}>
                            <input
                              type="checkbox"
                              checked={refs.includes(a.artifactId)}
                              disabled={
                                locked || (!refs.includes(a.artifactId) && referenceCount >= 3)
                              }
                              onChange={(e) =>
                                setRefs(
                                  e.target.checked
                                    ? [...refs, a.artifactId]
                                    : refs.filter((id) => id !== a.artifactId),
                                )
                              }
                            />
                            <span>{a.title}</span>
                          </span>
                          <small>{a.description}</small>
                        </label>
                      ))}
                  </div>
                  {!medical ? (
                    <label>
                      企业 Logo
                      <select
                        value={logo}
                        aria-label="企业 Logo"
                        disabled={locked}
                        onChange={(e) => setLogo(e.target.value)}
                      >
                        <option value="">不使用 Logo</option>
                        {run.input.retrieval.images
                          ?.filter((a) => a.usage === "LOGO")
                          .map((a) => (
                            <option value={a.artifactId} key={a.artifactId}>
                              {a.title}
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : null}
                  {logo && !medical ? (
                    <div className={styles.logo}>
                      <LabImage
                        runId={run.id}
                        assetId={logo}
                        token={token ?? ""}
                        alt="选用的企业 Logo"
                      />
                      <small>原图合成，不交给模型重绘</small>
                    </div>
                  ) : null}
                  {temporary.map((a) => (
                    <div className={styles.temporary} key={a.id}>
                      <LabImage
                        runId={run.id}
                        assetId={a.id}
                        token={token ?? ""}
                        alt={a.description}
                      />
                      <span>
                        {a.description}
                        <small>仅用于本次测试</small>
                      </span>
                      {draft ? (
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`移除 ${a.description}`}
                          onClick={() =>
                            void perform(async () =>
                              setRun(
                                await apiRequest<Run>(`${base}/${run.id}/assets/${a.id}`, {
                                  token,
                                  method: "DELETE",
                                }),
                              ),
                            )
                          }
                        >
                          <ActionIcon name="x" />
                          移除
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {draft && !medical ? (
                    <form className={styles.upload} onSubmit={upload}>
                      <label>
                        临时参考图说明
                        <input
                          required
                          minLength={2}
                          maxLength={1000}
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          disabled={busy || referenceCount >= 3}
                          placeholder="例如：本人授权的工作形象照"
                        />
                      </label>
                      <div className={styles.row}>
                        <label className={styles.fileButton}>
                          选择图片
                          <input
                            ref={fileInput}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            disabled={busy || referenceCount >= 3}
                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                          />
                        </label>
                        <span className={styles.fileName}>
                          {file?.name ?? "JPG / PNG / WebP，最大 4 MB"}
                        </span>
                        <button type="submit" disabled={busy || !file || referenceCount >= 3}>
                          添加
                        </button>
                      </div>
                    </form>
                  ) : null}
                </section>
                {medical ? (
                  <p className={styles.evidence}>
                    历史医疗测试保留原有冻结计划；新建测试使用通用需求与风格配置。
                  </p>
                ) : null}
                {!medical ? (
                  <details className={styles.details}>
                    <summary>03 / 提示词微调（仅本版本生效）</summary>
                    <div className={styles.form}>
                      {(
                        [
                          ["contentDirectionPrompt", "内容方向提示词"],
                          ["imageStylePrompt", "图片风格提示词"],
                          ["copyBasePrompt", "文案基础提示词"],
                          ["imageBasePrompt", "海报基础提示词"],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <textarea
                            aria-label={label}
                            minLength={4}
                            maxLength={key.endsWith("BasePrompt") ? 4000 : 3000}
                            rows={5}
                            value={prompts[key]}
                            disabled={locked}
                            onChange={(e) => setPrompts({ ...prompts, [key]: e.target.value })}
                          />
                        </label>
                      ))}
                    </div>
                  </details>
                ) : null}
                {draft && !medical ? (
                  <details className={styles.details} open={Boolean(copy.body)}>
                    <summary>复用 / 编辑文案后单独生图</summary>
                    <div className={styles.form}>
                      <label>
                        文案标题
                        <input
                          maxLength={100}
                          aria-label="文案标题"
                          value={copy.title}
                          disabled={locked}
                          onChange={(e) => setCopy({ ...copy, title: e.target.value })}
                        />
                      </label>
                      <label>
                        正文
                        <textarea
                          rows={6}
                          aria-label="正文"
                          maxLength={3000}
                          value={copy.body}
                          disabled={locked}
                          onChange={(e) => setCopy({ ...copy, body: e.target.value })}
                        />
                      </label>
                      <label>
                        话题（空格分隔）
                        <input
                          value={copy.hashtags.join(" ")}
                          aria-label="话题（空格分隔）"
                          disabled={locked}
                          onChange={(e) =>
                            setCopy({
                              ...copy,
                              hashtags: e.target.value.split(/\s+/u).filter(Boolean),
                            })
                          }
                        />
                      </label>
                      <label>
                        图片提示词
                        <textarea
                          rows={5}
                          maxLength={1800}
                          aria-label="图片提示词"
                          value={copy.imagePrompt}
                          disabled={locked}
                          onChange={(e) => setCopy({ ...copy, imagePrompt: e.target.value })}
                        />
                      </label>
                    </div>
                  </details>
                ) : null}
                <div className={styles.execute}>
                  <small>
                    文案：{run.input.route.text.primary.externalModelId}
                    <br />
                    生图：{run.input.route.image.primary.externalModelId}
                  </small>
                  {draft ? (
                    <>
                      <div className={styles.actions}>
                        <button type="button" disabled={busy} onClick={() => execute("COPY")}>
                          生成文案
                        </button>
                        <button
                          type="button"
                          disabled={
                            busy ||
                            !copy.body ||
                            copy.title.length < 4 ||
                            copy.imagePrompt.length < 4
                          }
                          onClick={() => execute("IMAGE")}
                        >
                          {medical ? "生成图片" : "生成海报"}
                        </button>
                        <button
                          className={styles.primary}
                          type="button"
                          disabled={busy}
                          onClick={() => execute("FULL")}
                        >
                          <ActionIcon name="send" />
                          完整测试
                        </button>
                      </div>
                      <small>
                        {medical
                          ? "按已冻结的问题与图片方式制作；费用以实际调用为准，需另行审核。"
                          : "文案 2 次调用；海报 1 次；完整测试 3 次。不自动审核。"}
                      </small>
                    </>
                  ) : (
                    <div className={styles.actions}>
                      <button
                        type="button"
                        disabled={busy || running}
                        onClick={() =>
                          void perform(async () => {
                            adopt(
                              await apiRequest<Run>(`${base}/${run.id}/fork`, {
                                token,
                                method: "POST",
                              }),
                            );
                            await refreshHistory();
                          })
                        }
                      >
                        <ActionIcon name="copy" />
                        复制版本继续调整
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          running ||
                          run.reviewStatus !== "NONE" ||
                          run.status !== "SUCCEEDED" ||
                          !run.assets.some((a) => a.kind === "POSTER")
                        }
                        onClick={() =>
                          void perform(async () =>
                            setRun(
                              await apiRequest<Run>(`${base}/${run.id}/review`, {
                                token,
                                method: "POST",
                              }),
                            ),
                          )
                        }
                      >
                        <ActionIcon name="badge-check" />
                        审核一次
                      </button>
                      <button
                        type="button"
                        disabled={busy || running || run.status !== "SUCCEEDED"}
                        onClick={() =>
                          void perform(async () => {
                            setOptions(await apiRequest<Options>(`${base}/options`, { token }));
                            setSaveOpen(true);
                          })
                        }
                      >
                        保存为正式配置
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </section>
          <section className={styles.preview} aria-label="测试结果">
            {run && token ? (
              <LabResult run={run} token={token} />
            ) : (
              <div className={styles.welcome}>
                <ActionIcon name="file-search" />
                <h2>先找到依据，再打磨表达</h2>
                <p>检查素材 → 生成文案 / 海报 → 对比版本 → 手动审核</p>
                <small>无需创建活动，不分发员工任务。</small>
              </div>
            )}
          </section>
        </div>
        <section className={styles.history}>
          <div className={styles.toolbar}>
            <h2>测试记录</h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!options) window.location.reload();
                else void perform(refreshHistory);
              }}
            >
              <ActionIcon name="refresh" />
              {options ? "刷新记录" : "重新加载"}
            </button>
          </div>
          {history.length ? (
            history.map((h) => (
              <div key={h.id} className={styles.historyRow}>
                <div>
                  <strong>{h.title}</strong>
                  <small>
                    {h.id.slice(-8)} · {actionLabel[h.action]} · {statusLabel[h.status]} ·{" "}
                    {new Date(h.createdAt).toLocaleString("zh-CN")}
                  </small>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () =>
                        adopt(await apiRequest<Run>(`${base}/${h.id}`, { token })),
                      )
                    }
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    disabled={busy || !run || h.id === run.id}
                    onClick={() =>
                      void perform(async () =>
                        setComparison(await apiRequest<Run>(`${base}/${h.id}`, { token })),
                      )
                    }
                  >
                    与当前对比
                  </button>
                  <button
                    type="button"
                    disabled={busy || ["QUEUED", "RUNNING"].includes(h.status)}
                    onClick={() => {
                      if (window.confirm("归档将移除测试图片，保留提示词和用量记录。确定归档？"))
                        void perform(async () => {
                          await apiRequest(`${base}/${h.id}/archive`, { token, method: "POST" });
                          if (run?.id === h.id) reset();
                          await refreshHistory();
                        });
                    }}
                  >
                    归档
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className={styles.hint}>暂无测试记录</p>
          )}
          {hasMore ? (
            <button
              className={styles.loadMore}
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const rows = await apiRequest<Run[]>(`${base}?cursor=${history.at(-1)?.id}`, {
                    token,
                  });
                  setHistory([...history, ...rows]);
                  setHasMore(rows.length === 40);
                })
              }
            >
              加载更多
            </button>
          ) : null}
        </section>
      </div>
      <WorkspaceDrawer
        title="版本对比"
        wide
        open={Boolean(comparison)}
        onClose={() => setComparison(null)}
      >
        {run && comparison && token ? (
          <div className={`${styles.lab} ${styles.comparison}`}>
            <LabResult run={run} token={token} />
            <LabResult run={comparison} token={token} />
          </div>
        ) : null}
      </WorkspaceDrawer>
      <WorkspaceDrawer
        title="保存为正式配置"
        open={saveOpen}
        onClose={() => {
          if (!busy) setSaveOpen(false);
        }}
      >
        <form
          className={`${styles.lab} ${styles.form}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (run && options)
              void perform(async () => {
                await apiRequest(`${base}/${run.id}/promote`, {
                  token,
                  method: "POST",
                  body: { kind: saveKind, name: saveName, version: options.styles.version },
                });
                setSaveOpen(false);
                setNotice("已保存为正式配置，新活动可使用。历史活动与测试版本不变。");
              });
          }}
        >
          <label>
            保存类型
            <select
              aria-label="保存类型"
              value={saveKind}
              disabled={busy}
              onChange={(e) => setSaveKind(e.target.value)}
            >
              <option value="CONTENT">新增内容方向</option>
              <option value="IMAGE">新增图片风格</option>
              <option value="TEMPLATE" disabled={medical}>
                企业活动模板{medical ? "（历史医疗计划不能用于新活动）" : ""}
              </option>
              <option value="GLOBAL">全局基础提示词新版本</option>
            </select>
          </label>
          <label>
            名称
            <input
              required
              minLength={2}
              maxLength={60}
              value={saveName}
              disabled={busy}
              onChange={(e) => setSaveName(e.target.value)}
            />
          </label>
          <p className={styles.hint}>
            {saveKind === "GLOBAL"
              ? "将更新所有企业新活动使用的文案及海报基础提示词，不修改已有活动。请确认后保存。"
              : saveKind === "TEMPLATE"
                ? "保存到当前企业的活动模板，不包括临时图片和临时提示词。修改过的预设需先正式保存。"
                : "新增预设，不覆盖原有预设，不改变默认项。"}
          </p>
          <button className={styles.primary} type="submit" disabled={busy}>
            确认保存
          </button>
        </form>
      </WorkspaceDrawer>
    </SaasShell>
  );
}
