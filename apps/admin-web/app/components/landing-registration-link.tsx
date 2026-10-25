"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { apiRequest } from "../lib/mvp-client";

export function LandingRegistrationLink({ className }: Readonly<{ className?: string }>) {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    void apiRequest<{ initialized: boolean }>("/auth/admin/installation")
      .then(({ initialized }) => {
        if (active && initialized === false) router.replace("/setup");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [router]);
  return (
    <Link className={className} href="/login">
      登录系统 <span aria-hidden="true">→</span>
    </Link>
  );
}
