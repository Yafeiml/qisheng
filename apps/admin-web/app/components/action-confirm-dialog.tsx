"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

export type ConfirmDialogState = Readonly<{
  confirmLabel: string;
  compact?: boolean;
  defaultReason?: string;
  minReasonLength?: number;
  impacts: readonly string[];
  reasonLabel: string;
  reasonOptions?: readonly { value: string; label: string }[];
  summary: string;
  title: string;
  tone?: "danger" | "warning";
}>;

export function ActionConfirmDialog({
  busy,
  onCancel,
  onConfirm,
  state,
}: Readonly<{
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  state: ConfirmDialogState | null;
}>) {
  const [reason, setReason] = useState("");
  const reasonInputId = useId();
  const reasonHelpId = `${reasonInputId}-help`;

  useEffect(() => {
    setReason(state?.defaultReason ?? "");
  }, [state]);

  if (!state || typeof document === "undefined") return null;
  const submittedReason = state.compact ? (state.defaultReason ?? "") : reason.trim();
  return createPortal(
    <div
      aria-labelledby="action-confirm-title"
      aria-modal="true"
      className="dialogBackdrop"
      role="dialog"
    >
      <section
        className={`actionConfirmDialog ${state.tone ?? "warning"}${state.compact ? " compact" : ""}`}
      >
        <header>
          {!state.compact ? (
            <span>{state.tone === "danger" ? "请确认不可逆影响" : "请确认操作影响"}</span>
          ) : null}
          <h2 id="action-confirm-title">{state.title}</h2>
          <p>{state.summary}</p>
        </header>
        {state.impacts.length ? (
          <div className="actionImpactList">
            {state.impacts.map((impact) => (
              <p key={impact}>{impact}</p>
            ))}
          </div>
        ) : null}
        {!state.compact ? (
          <label className="field" htmlFor={reasonInputId}>
            <span>{state.reasonLabel}</span>
            {state.reasonOptions ? (
              <select
                id={reasonInputId}
                aria-label={state.reasonLabel}
                aria-describedby={reasonHelpId}
                value={reason}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              >
                <option value="">请选择原因</option>
                {state.reasonOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <textarea
                id={reasonInputId}
                aria-label={state.reasonLabel}
                aria-describedby={reasonHelpId}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                value={reason}
              />
            )}
            <small id={reasonHelpId}>该说明会进入活动记录，方便其他同事理解这次决定。</small>
          </label>
        ) : null}
        <footer>
          <button className="ghostButton" disabled={busy} onClick={onCancel} type="button">
            {state.compact ? "暂不取消" : "返回检查"}
          </button>
          <button
            className={state.tone === "danger" ? "dangerButton" : "primaryButton"}
            disabled={busy || submittedReason.length < (state.minReasonLength ?? 2)}
            onClick={() => onConfirm(submittedReason)}
            type="button"
          >
            {busy ? "正在处理…" : state.confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
