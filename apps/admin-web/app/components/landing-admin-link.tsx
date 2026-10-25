"use client";

import Link from "next/link";
import { useMvpSession } from "../lib/use-mvp-session";

export function LandingAdminLink({ className = "" }: Readonly<{ className?: string }>) {
  const { session } = useMvpSession();

  if (session === undefined) {
    return (
      <span aria-busy="true" className={className} role="status">
        正在确认登录状态…
      </span>
    );
  }

  const href = session
    ? session.adminAccess.scopes.length === 0
      ? "/employee"
      : "/console"
    : "/login";

  return (
    <Link className={className} href={href}>
      {session ? "进入控制台" : "已有账号？登录后台"}
      <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
        <path
          d="M4 10h11m-4-4 4 4-4 4"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
    </Link>
  );
}
