"use client";

import { useRouter } from "next/navigation";
import { platformNavigationPermissions } from "../lib/mvp-client";
import { useMvpSession } from "../lib/use-mvp-session";

export function EntrySwitcher({
  current,
}: Readonly<{ current: "console" | "employee" | "platform" }>) {
  const auth = useMvpSession();
  const router = useRouter();
  if (!auth.session) return null;

  const canUseWorkspace =
    current === "console" ||
    auth.session.adminAccess.scopes.some(
      ({ scopeType }) => scopeType === "TENANT" || scopeType === "ENTERPRISE",
    );
  const canUseSettings =
    current === "platform" || platformNavigationPermissions(auth.session).length > 0;
  const entries = [
    ...(canUseWorkspace ? [{ href: "/console", label: "工作空间" }] : []),
    { href: "/employee", label: "员工发布" },
    ...(canUseSettings ? [{ href: "/platform", label: "系统设置" }] : []),
  ];

  return (
    <label className="entrySwitcher">
      <span>切换入口</span>
      <select
        aria-label="切换入口"
        disabled={entries.length < 2}
        value={`/${current}`}
        onChange={(event) => {
          const target = event.target.value;
          if (target !== `/${current}` && entries.some(({ href }) => href === target))
            router.push(target);
        }}
      >
        {entries.map(({ href, label }) => (
          <option key={href} value={href}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
