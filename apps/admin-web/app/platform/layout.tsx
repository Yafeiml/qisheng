import type { ReactNode } from "react";
import { SaasRouteLayout } from "../components/saas-shell";

export default function PlatformLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <SaasRouteLayout mode="platform">{children}</SaasRouteLayout>;
}
