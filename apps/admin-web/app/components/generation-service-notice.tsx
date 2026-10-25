"use client";

import type { components } from "@xhs-agentic/contracts";
import { useEffect, useState } from "react";
import { apiRequest, consoleNavigationPermissions, type MvpSession } from "../lib/mvp-client";
import styles from "./generation-service-notice.module.css";

type Status = components["schemas"]["GenerationStatusResponseDto"];

export function GenerationServiceNotice({ session }: { session: MvpSession }) {
  const permissions = consoleNavigationPermissions(session);
  const group = permissions.includes("tenant.dashboard.read");
  const allowed = group || permissions.includes("campaign.read");
  const path =
    allowed && session.tenantId
      ? `/console/tenants/${encodeURIComponent(session.tenantId)}${group ? "" : `/enterprises/${encodeURIComponent(session.enterpriseId)}`}/generation-status`
      : null;
  const [result, setResult] = useState<{ path: string; status: Status } | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!path) return;
    const endpoint = path;
    let cancelled = false;
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const status = await apiRequest<Status>(endpoint, { token: session.adminToken });
        if (!cancelled) {
          setResult({ path: endpoint, status });
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [path, session.adminToken]);
  const status = result?.path === path ? result?.status : null;
  if (!status?.notices.length) return null;
  return (
    <aside className={styles.notice} role="status" aria-label="生成服务提示">
      <strong>
        {group
          ? `${status.affectedEnterpriseCount} 家企业的生成服务需要处理`
          : "当前企业的生成服务需要处理"}
      </strong>
      {status.notices.map((notice) => (
        <p key={notice.notificationStatus}>
          {group ? `${notice.affectedEnterpriseCount} 家企业：` : ""}
          {notice.message}
        </p>
      ))}
      <small>
        已生成内容及其他业务功能可继续使用。
        {stale ? "状态刷新暂时失败，当前显示最近一次结果。" : "状态会自动更新。"}
      </small>
    </aside>
  );
}
