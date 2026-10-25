import type { ReactNode } from "react";
import { SaasRouteLayout } from "../components/saas-shell";

export default function ConsoleLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <SaasRouteLayout mode="console">{children}</SaasRouteLayout>;
}
