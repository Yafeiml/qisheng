export type ServiceStatus = "ok" | "error";

export interface DependencyCheck {
  latencyMs: number;
  status: ServiceStatus;
}

export interface ReadinessResponse {
  checks: Record<string, DependencyCheck>;
  status: ServiceStatus;
}

export type { components, operations, paths } from "./generated/openapi";
