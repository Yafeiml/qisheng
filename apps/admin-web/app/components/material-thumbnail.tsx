"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/mvp-client";

export function MaterialThumbnail({
  endpoint,
  token,
  label,
  onClick,
}: {
  endpoint: string;
  token: string;
  label: string;
  onClick: () => void;
}) {
  const element = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void apiRequest<{ optimizedDataUrl: string | null }>(endpoint, { token })
          .then((value) => {
            if (!cancelled) {
              setSrc(value.optimizedDataUrl);
              setFailed(!value.optimizedDataUrl);
            }
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
      },
      { rootMargin: "100px" },
    );
    if (element.current) observer.observe(element.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [endpoint, token]);
  return (
    <button
      ref={element}
      type="button"
      className="materialThumbnail"
      onClick={onClick}
      aria-label={`预览${label}`}
    >
      {src ? (
        <Image src={src} alt={label} width={160} height={120} unoptimized />
      ) : (
        <span>{failed ? "点击查看" : "加载预览…"}</span>
      )}
    </button>
  );
}
