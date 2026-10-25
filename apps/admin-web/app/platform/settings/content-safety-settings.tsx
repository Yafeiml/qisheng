"use client";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { FeedbackMessage } from "../../components/feedback-toast";
import { apiRequest } from "../../lib/mvp-client";
import { messageOf } from "../../lib/use-mvp-session";
import styles from "./content-safety-settings.module.css";

type Configuration = {
  mode: string;
  modelProviderId: string;
  model: string;
  provider: string;
  endpoint: string;
  apiKeyConfigured: boolean;
  timeoutMs: number;
  verified: boolean;
  checkedAt: string | null;
  providers: { id: string; name: string }[];
};
type Choice = { externalModelId: string; suggestedCapabilities: string[] };
export function ContentSafetySettings({ token }: { token: string }) {
  const [saved, setSaved] = useState<Configuration | null>(null);
  const [mode, setMode] = useState("MODEL");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(90);
  const [models, setModels] = useState<Choice[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"SAVE" | "TEST" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const apply = useCallback((value: Configuration) => {
    setSaved(value);
    setMode(value.mode === "DISABLED" ? "MODEL" : value.mode);
    setProviderId(value.modelProviderId);
    setModel(value.model);
    setEndpoint(value.endpoint);
    setProvider(value.provider);
    setTimeoutSeconds(value.timeoutMs / 1000);
    setApiKey("");
  }, []);
  const load = useCallback(async () => {
    setError(null);
    try {
      apply(await apiRequest<Configuration>("/platform/settings/content-safety", { token }));
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [token, apply]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let active = true;
    setModels([]);
    setModelsError(null);
    if (!providerId || mode !== "MODEL") {
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    void apiRequest<{ models: Choice[] }>(
      `/platform/model-providers/${encodeURIComponent(providerId)}/available-models`,
      { token },
    )
      .then((result) => {
        if (active)
          setModels(
            result.models.filter(
              (choice) =>
                !choice.suggestedCapabilities.includes("EMBEDDING") &&
                !choice.suggestedCapabilities.includes("IMAGE"),
            ),
          );
      })
      .catch(() => {
        if (active) setModelsError("暂时无法读取模型列表，可手动填写模型 ID，或检查供应商连接。 ");
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [providerId, mode, token]);
  const dirty =
    !!saved &&
    (mode !== saved.mode ||
      timeoutSeconds * 1000 !== saved.timeoutMs ||
      (mode === "MODEL"
        ? providerId !== saved.modelProviderId || model !== saved.model
        : endpoint !== saved.endpoint || provider !== saved.provider || apiKey !== ""));
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("SAVE");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<Configuration>("/platform/settings/content-safety", {
        token,
        method: "POST",
        body: {
          mode,
          timeoutMs: Math.round(timeoutSeconds * 1000),
          ...(mode === "MODEL"
            ? { modelProviderId: providerId, model: model.trim() }
            : {
                endpoint: endpoint.trim(),
                provider: provider.trim(),
                apiKey: apiKey || undefined,
              }),
        },
      });
      apply(result);
      setNotice(
        result.verified
          ? "配置已保存，当前配置的测试结果仍有效。"
          : "配置已保存，请点击「测试图文审核」验证后启用 Worker。",
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  }
  async function test() {
    setBusy("TEST");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ imageRiskDetected: boolean }>(
        "/platform/settings/content-safety/test",
        { token, method: "POST", body: { reason: "验证当前图文审核配置" } },
      );
      await load();
      setNotice(
        result.imageRiskDetected
          ? "测试通过：正常图文可通过，图片中的危险医疗宣传已识别。重启 Worker 后生效。"
          : "独立审核服务测试通过，重启 Worker 后生效。",
      );
    } catch (reason) {
      setError(messageOf(reason));
      if (saved) setSaved({ ...saved, verified: false });
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className={`panel ${styles.panel}`} aria-label="内容安全审核">
      <header className={styles.header}>
        <div>
          <h2>内容安全审核</h2>
          <p>生成的文案和图片一起审核，通过后再进入内容交付。</p>
        </div>
        <span className={saved?.verified && !dirty ? styles.ready : styles.pending}>
          {dirty ? "配置未保存" : saved?.verified ? "测试已通过" : "待配置或测试"}
        </span>
      </header>
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <form onSubmit={save}>
        <label className={styles.field}>
          审核方式
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            disabled={busy !== null || !saved}
          >
            <option value="MODEL">使用现有多模态模型（推荐）</option>
            <option value="HTTP">独立审核服务</option>
          </select>
        </label>
        {mode === "MODEL" ? (
          <>
            <div className={styles.fields}>
              <label className={styles.field}>
                模型供应商
                <select
                  aria-label="审核模型供应商"
                  value={providerId}
                  onChange={(e) => {
                    setProviderId(e.target.value);
                    setModel("");
                  }}
                  disabled={busy !== null || !saved}
                  required
                >
                  <option value="">请选择供应商</option>
                  {saved?.providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                图文审核模型
                <input
                  aria-label="图文审核模型"
                  list="content-safety-model-list"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={modelsLoading ? "正在读取模型列表…" : "选择或输入支持图片理解的模型"}
                  disabled={busy !== null || !providerId}
                  maxLength={200}
                  required
                />
                <datalist id="content-safety-model-list">
                  {models.map((item) => (
                    <option key={item.externalModelId} value={item.externalModelId} />
                  ))}
                </datalist>
              </label>
            </div>
            <p className={styles.help}>
              自动使用供应商已保存的地址和密钥，无需重复填写。
              <Link href="/platform/models">管理供应商</Link>
            </p>
            {modelsError ? <p className={styles.help}>{modelsError}</p> : null}
          </>
        ) : (
          <>
            <p className={styles.help}>
              填写专用图文审核接口的完整地址。普通模型供应商的 /v1
              地址请使用「现有多模态模型」方式。
            </p>
            <div className={styles.fields}>
              <label className={styles.field}>
                审核接口地址
                <input
                  aria-label="审核接口地址"
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  required
                  disabled={busy !== null || !saved}
                />
              </label>
              <label className={styles.field}>
                服务标识
                <input
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  required
                  maxLength={80}
                  disabled={busy !== null || !saved}
                />
              </label>
              <label className={styles.field}>
                API Key
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={saved?.apiKeyConfigured ? "已保存，留空保留" : "填写审核服务密钥"}
                  required={!saved?.apiKeyConfigured}
                  disabled={busy !== null || !saved}
                />
              </label>
            </div>
          </>
        )}
        <details className={styles.advanced}>
          <summary>高级设置</summary>
          <label className={styles.field}>
            单次审核超时（秒）
            <input
              type="number"
              value={timeoutSeconds}
              min={1}
              max={120}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
              disabled={busy !== null || !saved}
            />
          </label>
        </details>
        <div className={styles.actions}>
          <button
            className="primaryButton"
            type={saved ? "submit" : "button"}
            onClick={!saved ? () => void load() : undefined}
            disabled={busy !== null || (!saved && !error)}
          >
            {!saved ? (error ? "重新加载" : "加载中…") : busy === "SAVE" ? "保存中…" : "保存配置"}
          </button>
          <button
            className="lightButton"
            type="button"
            onClick={() => void test()}
            disabled={busy !== null || !saved || dirty || saved.mode === "DISABLED"}
          >
            {busy === "TEST" ? "正在审核测试图文…" : "测试图文审核"}
          </button>
        </div>
        <p className={styles.help}>
          测试结果持续有效；更换模型、密钥或审核配置后需重新测试。审核异常时暂停交付，不会默认放行。
        </p>
      </form>
    </section>
  );
}
