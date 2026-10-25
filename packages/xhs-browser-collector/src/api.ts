import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Claim, Health, Job, JobSource, LeaseHealth, NoteEvidence } from "./types";

const PREFIX = "/integrations/v2/collection-jobs";

export class SignedJobSource implements JobSource {
  private readonly origin: string;

  constructor(
    baseUrl: string,
    private readonly id: string,
    private readonly secret: string,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("COLLECTOR_API_HTTPS_ORIGIN_REQUIRED");
    }
    if (!/^[A-Za-z0-9_-]{4,100}$/u.test(id) || secret.length < 32) {
      throw new Error("COLLECTOR_AUTH_CONFIGURATION_INVALID");
    }
    this.origin = url.origin;
  }

  status(): Promise<Health> {
    return this.request("GET", `${PREFIX}/status`);
  }

  async claim(): Promise<Claim> {
    const result = await this.request<Claim>("POST", `${PREFIX}/claim`, { limit: 1 });
    if (typeof result.paused !== "boolean" || !(result.job === null || validJob(result.job))) {
      throw new Error("COLLECTOR_CLAIM_MALFORMED");
    }
    return result;
  }

  heartbeat(job: Job): Promise<LeaseHealth> {
    return this.request("POST", `${PREFIX}/${encodeURIComponent(job.id)}/heartbeat`, {
      leaseToken: job.leaseToken,
    });
  }

  evidence(job: Job, evidence: NoteEvidence): Promise<void> {
    const exactMetrics = evidence.metrics
      ? Object.fromEntries(
          Object.entries(evidence.metrics)
            .filter(([, metric]) => metric.precision === "EXACT" && metric.value !== null)
            .map(([key, metric]) => [key, metric.value]),
        )
      : undefined;
    const { metrics, ...coreEvidence } = evidence;
    const metricsRaw = metrics
      ? Object.fromEntries(
          Object.entries(metrics).map(([key, metric]) => [
            key,
            {
              precision: metric.precision,
              value: metric.precision === "EXACT" ? metric.value : null,
              raw: metric.precision === "UNAVAILABLE" ? null : metric.raw,
            },
          ]),
        )
      : undefined;
    return this.request("POST", `${PREFIX}/${encodeURIComponent(job.id)}/evidence`, {
      leaseToken: job.leaseToken,
      ...coreEvidence,
      ...(metrics ? { metrics: exactMetrics, metricsRaw } : {}),
    });
  }

  pause(reason: string): Promise<void> {
    return this.request("POST", `${PREFIX}/pause`, { reason });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestId = randomUUID();
    const digest = createHash("sha256").update(payload).digest("hex");
    const message = `${method}\n${path}\n${timestamp}\n${requestId}\n${digest}`;
    const signature = createHmac("sha256", this.secret).update(message).digest("hex");
    const response = await fetch(`${this.origin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "content-type": "application/json",
        "x-collector-id": this.id,
        "x-collector-timestamp": timestamp,
        "x-collector-request-id": requestId,
        "x-collector-signature": signature,
      },
      ...(body === undefined ? {} : { body: payload }),
    });
    // Never put remote response bodies, access URLs or auth material in model-visible errors.
    if (!response.ok) throw new Error(`COLLECTOR_API_HTTP_${response.status}`);
    const content = await response.text();
    if (content.length > 1_000_000) throw new Error("COLLECTOR_API_RESPONSE_TOO_LARGE");
    return content ? (JSON.parse(content) as T) : (undefined as T);
  }
}

function validJob(value: unknown): value is Job {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === "string" &&
    /^[A-Za-z0-9_-]{6,128}$/u.test(job.id) &&
    (job.kind === "VERIFY" || job.kind === "METRICS") &&
    typeof job.accessUrl === "string" &&
    typeof job.leaseToken === "string" &&
    job.leaseToken.length >= 24 &&
    typeof job.leaseExpiresAt === "string" &&
    Number.isFinite(Date.parse(job.leaseExpiresAt)) &&
    typeof job.submittedAt === "string" &&
    typeof job.dueAt === "string" &&
    (job.windowHours === null || typeof job.windowHours === "number")
  );
}
