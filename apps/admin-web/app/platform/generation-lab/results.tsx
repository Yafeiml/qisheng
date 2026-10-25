"use client";
import { useEffect, useState } from "react";
import { API_BASE_URL } from "../../lib/mvp-client";
import styles from "./styles.module.css";
import { actionLabel, type Run, statusLabel } from "./types";

export function LabImage({
  runId,
  assetId,
  token,
  alt,
}: {
  runId: string;
  assetId: string;
  token: string;
  alt: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let objectUrl = "";
    const abort = new AbortController();
    setUrl("");
    setError(false);
    void fetch(`${API_BASE_URL}/platform/generation-lab/${runId}/images/${assetId}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法加载图片");
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [runId, assetId, token]);
  return url ? (
    // biome-ignore lint/performance/noImgElement: Authenticated private blob, not a public image URL.
    <img className={styles.image} src={url} alt={alt} />
  ) : (
    <span className={styles.imagePlaceholder}>{error ? "图片暂不可用" : "加载图片…"}</span>
  );
}

export function LabResult({ run, token }: { run: Run; token: string }) {
  const poster = run.assets.find((a) => a.kind === "POSTER");
  const copy = run.result?.copy;
  return (
    <article className={styles.result}>
      <div className={styles.row}>
        <h3>{run.title}</h3>
        <span className={styles.badge}>{statusLabel[run.status] ?? run.status}</span>
      </div>
      <small>
        {run.input.enterpriseName} · {actionLabel[run.action]} · {run.id.slice(-8)}
      </small>
      {poster ? (
        <div className={styles.poster}>
          <LabImage runId={run.id} assetId={poster.id} token={token} alt="生成海报" />
        </div>
      ) : (
        <div className={styles.empty}>
          {" "}
          {run.status === "DRAFT"
            ? "选择素材并开始测试，结果将显示在这里"
            : ["RUNNING", "QUEUED"].includes(run.status)
              ? "后台处理中，可离开页面，测试记录会保留"
              : "此版本尚未生成海报"}
        </div>
      )}
      {copy ? (
        <div className={styles.copyResult}>
          <h3>{copy.title}</h3>
          <p>{copy.body}</p>
          <small>{copy.hashtags.map((t) => `#${t}`).join(" ")}</small>
        </div>
      ) : null}
      {run.error ? (
        <p role="alert" className={styles.error}>
          {run.error}
        </p>
      ) : null}
      <div className={styles.review}>
        <strong>
          整体审核：{statusLabel[run.review?.decision ?? run.reviewStatus] ?? run.reviewStatus}
        </strong>
        {run.review?.message ? <p>{run.review.message}</p> : null}
        {run.review?.categories?.map((c) => (
          <p key={c.code}>{c.message}</p>
        ))}
      </div>
      {run.result?.localAssessment?.warnings.length ? (
        <p className={styles.error}>规则提示：{run.result.localAssessment.warnings.join("；")}</p>
      ) : null}
      {run.result?.localAssessment?.replacedBlocks.length ? (
        <small>已按正式规则替换：{run.result.localAssessment.replacedBlocks.join("；")}</small>
      ) : null}
      {run.result?.logo ? <small>{run.result.logo.composition}</small> : null}
      <LabCalls run={run} />
    </article>
  );
}

function LabCalls({ run }: { run: Run }) {
  const known = run.calls.filter((c) => typeof c.usage?.estimatedCost === "number");
  const unknown = run.calls.length - known.length;
  return (
    <details className={styles.details}>
      <summary>调用记录与实际提示词 · {run.calls.length} 条</summary>
      <p className={styles.hint}>
        金额为供应商配置币种下的估算，不是最终账单；不同币种不合计。
        {unknown ? ` ${unknown} 条费用未知。` : ""}
      </p>
      {run.calls.map((call) => (
        <details key={call.id} className={styles.call}>
          <summary>
            {actionLabel[call.kind] ?? call.kind} · {call.modelId} ·{" "}
            {call.latencyMs === null ? "待确认" : `${(call.latencyMs / 1000).toFixed(1)} 秒`} ·{" "}
            {typeof call.usage?.estimatedCost === "number"
              ? `估算 ${call.usage.estimatedCost.toFixed(4)}`
              : "费用未知"}
          </summary>
          <small>
            {call.status} · 输入 {call.usage?.inputUnits ?? "未知"} / 输出{" "}
            {call.usage?.outputUnits ?? "未知"}
          </small>
          {call.usage?.note ? <p>{call.usage.note}</p> : null}
          {call.error ? <p>{call.error}</p> : null}
          <pre>{JSON.stringify(call.request, null, 2)}</pre>
          {call.usage?.text ? (
            <details>
              <summary>模型原始返回</summary>
              <pre>{call.usage.text}</pre>
            </details>
          ) : null}
        </details>
      ))}
    </details>
  );
}
