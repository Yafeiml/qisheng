import { createHash, createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  type NoteDetailResult,
  normalizeNoteDetailAuthorization,
  normalizeNoteDetailEndpoint,
} from "./note-detail";

const PREFIX = "/integrations/v1/publication-readback";

export type ReadbackJob = Readonly<{
  id: string;
  noteId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  dueAt: string;
}>;

export type ReadbackClaim = Readonly<{
  paused: boolean;
  reason: string | null;
  job: ReadbackJob | null;
}>;

export type ManagedReadbackClaim = ReadbackClaim &
  Readonly<{ provider: Readonly<{ endpoint: string; token: string }> | null }>;

export type ReadbackOperations = Readonly<{
  paused: boolean;
  reason: string | null;
  today: string;
  dailyLimit: number;
  total: number;
  queued: number;
  retrying: number;
  leased: number;
  completed: number;
  needsReview: number;
  budget: readonly Readonly<{ day: string; used: number }>[];
  jobs: readonly Readonly<{
    id: string;
    status: string;
    attempts: number;
    createdAt: string;
    dueAt: string;
    updatedAt: string;
    completedAt: string | null;
    errorCode: string | null;
    leaseOwner: string | null;
  }>[];
}>;

export class SignedReadbackApi {
  private readonly origin: string;
  private readonly publicPrefix: string;

  constructor(
    baseUrl: string,
    private readonly nodeId: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = parseHttpUrl(baseUrl, "READBACK_API_BASE_URL_INVALID");
    if (!/^[A-Za-z0-9_.-]{3,80}$/u.test(nodeId) || secret.length < 32)
      throw new Error("READBACK_AUTH_CONFIGURATION_INVALID");
    this.origin = url.origin;
    // The reverse proxy strips its public prefix; HMAC signs Nest's originalUrl only.
    this.publicPrefix = url.pathname.replace(/\/+$/u, "");
  }

  status(): Promise<{ paused: boolean; reason: string | null }> {
    return this.request("GET", `${PREFIX}/status`);
  }

  operations(): Promise<ReadbackOperations> {
    return this.request("GET", `${PREFIX}/operations`);
  }

  async claim(): Promise<ReadbackClaim> {
    const result = await this.request<ReadbackClaim>("POST", `${PREFIX}/claim`, { limit: 1 });
    if (typeof result.paused !== "boolean" || !(result.job === null || validJob(result.job)))
      throw new Error("READBACK_CLAIM_MALFORMED");
    return result;
  }

  async managedClaim(): Promise<ManagedReadbackClaim> {
    if (this.nodeId !== "selfhost-readback") throw new Error("MANAGED_NODE_ID_INVALID");
    const result = await this.request<ManagedReadbackClaim>("POST", `${PREFIX}/claim-managed`, {
      limit: 1,
    });
    if (
      !result ||
      typeof result.paused !== "boolean" ||
      !(result.reason === null || typeof result.reason === "string") ||
      !(result.job === null || validJob(result.job)) ||
      (result.paused && result.job !== null)
    )
      throw new Error("READBACK_CLAIM_MALFORMED");
    if (!result.job) {
      if (result.provider !== null) throw new Error("READBACK_CLAIM_MALFORMED");
      return result;
    }
    if (
      !result.provider ||
      typeof result.provider.endpoint !== "string" ||
      typeof result.provider.token !== "string"
    )
      throw new Error("READBACK_CLAIM_MALFORMED");
    normalizeNoteDetailEndpoint(result.provider.endpoint);
    normalizeNoteDetailAuthorization(result.provider.token);
    return result;
  }

  async result(
    job: ReadbackJob,
    response: NoteDetailResult,
    observedAt: Date,
  ): Promise<{ status: string }> {
    const input =
      response.status === "AVAILABLE"
        ? {
            leaseToken: job.leaseToken,
            source: "API_PROVIDER",
            status: "AVAILABLE",
            code: "NOTE_AVAILABLE",
            observedAt: observedAt.toISOString(),
            note: {
              ...response.note,
              publishedAt: response.note.publishedAt?.toISOString() ?? null,
            },
          }
        : {
            leaseToken: job.leaseToken,
            source: "API_PROVIDER",
            status: response.status,
            code: response.code,
          };
    const path = `${PREFIX}/${encodeURIComponent(job.id)}/result`;
    try {
      return await this.request("POST", path, input);
    } catch (error) {
      // Lost acknowledgements can be replayed with a fresh signed nonce.
      if (error instanceof Error && /^READBACK_API_HTTP_4\d\d$/u.test(error.message)) throw error;
      return this.request("POST", path, input);
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestId = randomUUID();
    const digest = createHash("sha256").update(payload).digest("hex");
    const panelUrl = configuredPanelPublicUrl();
    const signature = createHmac("sha256", this.secret)
      .update(
        [method, path, timestamp, requestId, digest, ...(panelUrl ? [panelUrl] : [])].join("\n"),
      )
      .digest("hex");
    const response = await this.fetcher(`${this.origin}${this.publicPrefix}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "content-type": "application/json",
        "x-collector-id": this.nodeId,
        ...(panelUrl ? { "x-collector-panel-url": panelUrl } : {}),
        "x-collector-timestamp": timestamp,
        "x-collector-request-id": requestId,
        "x-collector-signature": signature,
      },
      ...(body === undefined ? {} : { body: payload }),
    });
    if (!response.ok) throw new Error(`READBACK_API_HTTP_${response.status}`);
    const size = Number(response.headers.get("content-length"));
    if (size > 1_000_000) throw new Error("READBACK_API_RESPONSE_TOO_LARGE");
    const content = await response.text();
    if (content.length > 1_000_000) throw new Error("READBACK_API_RESPONSE_TOO_LARGE");
    return JSON.parse(content) as T;
  }
}

export function normalizePanelPublicUrl(value: string): string {
  const url = parseHttpUrl(value, "READBACK_PANEL_PUBLIC_URL_INVALID");
  if (url.pathname !== "/" || ["0.0.0.0", "[::]"].includes(url.hostname))
    throw new Error("READBACK_PANEL_PUBLIC_URL_INVALID");
  return url.toString();
}

function configuredPanelPublicUrl(): string | null {
  if (process.env.READBACK_PANEL_PUBLIC_URL)
    return normalizePanelPublicUrl(process.env.READBACK_PANEL_PUBLIC_URL);
  const host = process.env.READBACK_PANEL_HOST?.trim();
  if (!host || ["0.0.0.0", "::", "[::]"].includes(host)) return null;
  const address = isIP(host) === 6 ? `[${host}]` : host;
  const url = parseHttpUrl(
    `http://${address}:${process.env.READBACK_PANEL_PORT || "13110"}`,
    "READBACK_PANEL_PUBLIC_URL_INVALID",
  );
  return ["0.0.0.0", "[::]"].includes(url.hostname)
    ? null
    : normalizePanelPublicUrl(url.toString());
}

function parseHttpUrl(value: string, errorCode: string): URL {
  const authority = /^https?:\/\/([^/\\?#]*)/iu.exec(value)?.[1];
  const hasControl = Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (!authority || authority.includes("@") || /[?#]/u.test(value) || hasControl)
    throw new Error(errorCode);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error(errorCode);
  return url;
}

function validJob(value: unknown): value is ReadbackJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === "string" &&
    /^[a-zA-Z0-9_-]{6,128}$/u.test(job.id) &&
    typeof job.noteId === "string" &&
    /^[a-zA-Z0-9_-]{6,128}$/u.test(job.noteId) &&
    typeof job.leaseToken === "string" &&
    /^[a-f\d-]{36}$/iu.test(job.leaseToken) &&
    typeof job.dueAt === "string" &&
    Number.isFinite(Date.parse(job.dueAt)) &&
    typeof job.leaseExpiresAt === "string" &&
    Date.parse(job.leaseExpiresAt) > Date.now()
  );
}
