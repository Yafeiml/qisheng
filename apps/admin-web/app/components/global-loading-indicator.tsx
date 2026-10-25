"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentTrackedRequestCount, subscribeRequestActivity } from "../lib/mvp-client";
import { useMvpSession } from "../lib/use-mvp-session";

export function GlobalLoadingIndicator() {
  const pathname = usePathname();
  const enterpriseId = useMvpSession().session?.enterpriseId;
  const activeRequests = useSyncExternalStore(
    subscribeRequestActivity,
    currentTrackedRequestCount,
    () => 0,
  );
  const [routePending, setRoutePending] = useState(false);
  const [pendingEnterpriseId, setPendingEnterpriseId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const pendingRoutePath = useRef<string | null>(null);
  const previousEnterpriseId = useRef<string | null>(null);
  const visibleSince = useRef(0);
  const scopePending = pendingEnterpriseId !== null;

  useEffect(() => {
    const previous = previousEnterpriseId.current;
    previousEnterpriseId.current = enterpriseId ?? null;
    if (!enterpriseId) setPendingEnterpriseId(null);
    else if (previous && previous !== enterpriseId) setPendingEnterpriseId(enterpriseId);
  }, [enterpriseId]);

  useEffect(() => {
    if (!pendingEnterpriseId) return;
    // Show even for cached pages; normal tracked requests keep it visible if data takes longer.
    const timeout = window.setTimeout(() => setPendingEnterpriseId(null), 500);
    return () => window.clearTimeout(timeout);
  }, [pendingEnterpriseId]);

  useEffect(() => {
    function handleNavigationClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname === window.location.pathname ||
        destination.hash
      ) {
        return;
      }
      pendingRoutePath.current = destination.pathname;
      setRoutePending(true);
    }

    document.addEventListener("click", handleNavigationClick, true);
    return () => document.removeEventListener("click", handleNavigationClick, true);
  }, []);

  useEffect(() => {
    if (routePending && pendingRoutePath.current === pathname) {
      pendingRoutePath.current = null;
      setRoutePending(false);
    }
  }, [pathname, routePending]);

  useEffect(() => {
    if (!routePending) return;
    const timeout = window.setTimeout(() => {
      pendingRoutePath.current = null;
      setRoutePending(false);
    }, 8_000);
    return () => window.clearTimeout(timeout);
  }, [routePending]);

  useEffect(() => {
    let timer: number | undefined;
    if (activeRequests > 0 || routePending || scopePending) {
      timer = window.setTimeout(() => {
        visibleSince.current = Date.now();
        setVisible(true);
      }, 90);
    } else if (visible) {
      const remaining = Math.max(0, 260 - (Date.now() - visibleSince.current));
      timer = window.setTimeout(() => setVisible(false), remaining);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [activeRequests, routePending, scopePending, visible]);

  return (
    <div
      aria-hidden={!visible}
      aria-live="polite"
      className={`globalLoading ${visible ? "visible" : ""}`}
      role="status"
    >
      <div className="globalLoadingCard">
        <span aria-hidden="true" className="xhsLoader">
          <i />
          <i />
          <i />
        </span>
        <strong suppressHydrationWarning>
          {scopePending ? "正在切换企业" : routePending ? "正在预载页面" : "正在加载内容"}
        </strong>
        <small>
          {scopePending
            ? "正在同步所选企业的数据"
            : routePending
              ? "正在准备页面结构和最新数据"
              : "请稍候，数据正在同步"}
        </small>
      </div>
    </div>
  );
}
