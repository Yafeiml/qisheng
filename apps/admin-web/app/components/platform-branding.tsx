"use client";

import Image from "next/image";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { API_BASE_URL } from "../lib/mvp-client";
import {
  defaultPlatformBranding,
  type PlatformBranding,
  parsePlatformBranding,
} from "../lib/platform-branding";

const brandingEvent = "platform-branding-updated";
const brandingStorageKey = "platform-branding-revision";
const BrandingContext = createContext<PlatformBranding>(defaultPlatformBranding);

export function notifyPlatformBrandingChanged() {
  window.dispatchEvent(new Event(brandingEvent));
  try {
    localStorage.setItem(brandingStorageKey, String(Date.now()));
  } catch {
    /* Storage may be unavailable. */
  }
}

export function PlatformBrandingProvider({
  initial,
  children,
}: Readonly<{ initial: PlatformBranding; children: ReactNode }>) {
  const [branding, setBranding] = useState(initial);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const response = await fetch(`${API_BASE_URL}/public/platform-branding`, {
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const next = parsePlatformBranding(await response.json());
      if (id === requestId.current)
        setBranding((old) =>
          old.name === next.name && old.logoDataUrl === next.logoDataUrl ? old : next,
        );
    } catch {
      /* Keep the last successful branding while offline. */
    }
  }, []);

  useEffect(() => {
    const update = () => {
      if (!document.hidden) void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === brandingStorageKey) update();
    };
    update();
    window.addEventListener(brandingEvent, update);
    window.addEventListener("focus", update);
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", update);
    const timer = window.setInterval(update, 60_000);
    return () => {
      requestId.current++;
      window.clearInterval(timer);
      window.removeEventListener(brandingEvent, update);
      window.removeEventListener("focus", update);
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);

  useEffect(() => {
    document.title = branding.name;
    for (const link of document.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"], link[rel="apple-touch-icon"]',
    )) {
      link.href = branding.logoDataUrl ?? "/platform-mark.svg";
    }
  }, [branding]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

export const usePlatformBranding = () => useContext(BrandingContext);
export function PlatformName() {
  return <>{usePlatformBranding().name}</>;
}
export function PlatformLogo({ className = "" }: Readonly<{ className?: string }>) {
  const branding = usePlatformBranding();
  return (
    <span
      aria-hidden="true"
      className={`platformLogo ${branding.logoDataUrl ? "hasImage" : ""} ${className}`}
    >
      {branding.logoDataUrl ? (
        <Image alt="" src={branding.logoDataUrl} width={44} height={44} unoptimized />
      ) : (
        branding.name.slice(0, 1)
      )}
    </span>
  );
}
