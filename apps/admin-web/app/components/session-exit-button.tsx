"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { logoutFormalAdmin } from "../lib/mvp-client";
import { useMvpSession } from "../lib/use-mvp-session";

export function SessionExitButton() {
  const auth = useMvpSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function exit(): Promise<void> {
    setBusy(true);
    try {
      await logoutFormalAdmin();
    } finally {
      auth.setSession(null);
      router.replace("/login");
    }
  }

  return (
    <button className="sidebarExit" disabled={busy} onClick={() => void exit()} type="button">
      {busy ? "正在退出…" : "退出登录"}
    </button>
  );
}
