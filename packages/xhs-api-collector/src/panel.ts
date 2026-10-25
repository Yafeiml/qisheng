import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { normalizePanelPublicUrl, SignedReadbackApi } from "./job-api";
import { fetchNoteDetail } from "./note-detail";
import type { PanelState } from "./panel-state";
import { noteIdFromInput } from "./smoke";

type LoginAttempt = { count: number; until: number };
const attempts = new Map<string, LoginAttempt>();
const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
} as const;

export async function startPanel(
  state: PanelState,
): Promise<{ state: PanelState; close: () => Promise<void> }> {
  const configuredHost = (process.env.READBACK_PANEL_HOST ?? "127.0.0.1")
    .trim()
    .replace(/^\[(.*)\]$/u, "$1");
  const host =
    isIP(configuredHost) === 6
      ? new URL(`http://[${configuredHost}]/`).hostname.slice(1, -1)
      : configuredHost;
  const port = Number(process.env.READBACK_PANEL_PORT || "13110");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("PANEL_PORT_INVALID");
  if (!host) throw new Error("PANEL_HOST_INVALID");
  const setupIps = (process.env.READBACK_PANEL_SETUP_IPS ?? "127.0.0.1,::1")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeIp);
  if (!setupIps.length) throw new Error("PANEL_SETUP_IPS_INVALID");
  const configuredPanelUrl = process.env.READBACK_PANEL_PUBLIC_URL || undefined;
  if (!configuredPanelUrl && (host === "0.0.0.0" || host === "::"))
    throw new Error("PANEL_PUBLIC_URL_REQUIRED");
  const panelUrl = normalizePanelPublicUrl(
    configuredPanelUrl ?? `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
  );
  const expectedOrigin = new URL(panelUrl).origin;
  const secureCookie = expectedOrigin.startsWith("https:");
  const api = new SignedReadbackApi(
    required("PUBLICATION_READBACK_API_BASE_URL"),
    required("PUBLICATION_READBACK_NODE_ID"),
    required("PUBLICATION_READBACK_NODE_KEY"),
  );
  let probing = false;
  let cached: { at: number; value: Awaited<ReturnType<SignedReadbackApi["operations"]>> } | null =
    null;
  const server = createServer(async (req, res) => {
    setHeaders(res);
    try {
      const address = req.url ?? "";
      if (address.includes("?")) return json(res, 400, { error: "INVALID_REQUEST" });
      if (req.method === "GET" && address === "/health") return json(res, 200, { status: "ok" });
      if (req.method === "GET" && Object.hasOwn(assets, address)) {
        const [file, type] = assets[address as keyof typeof assets];
        res.writeHead(200, { "content-type": type });
        res.end(readFileSync(join(__dirname, "public", file)));
        return;
      }
      const remoteIp = normalizeIp(req.socket.remoteAddress ?? "");
      const cookie =
        /(?:^|;\s*)readback_session=([^;]+)/u.exec(req.headers.cookie ?? "")?.[1] ?? "";
      const session = state.session(cookie);
      if (req.method === "GET" && address === "/api/state") {
        return json(
          res,
          200,
          session
            ? {
                authenticated: true,
                setupRequired: false,
                csrf: session.csrf,
                endpoint: state.endpoint,
                endpointConfigured: Boolean(state.endpoint),
                tokenConfigured: state.tokenConfigured,
                workerEnabled: state.workerEnabled,
                probe: state.probe,
              }
            : {
                authenticated: false,
                setupRequired: state.setupRequired,
                setupAllowed: setupIps.includes(remoteIp),
              },
        );
      }
      if (req.method === "GET" && address === "/api/operations") {
        if (!session) return json(res, 401, { error: "LOGIN_REQUIRED" });
        if (!cached || Date.now() - cached.at > 5_000) {
          cached = { at: Date.now(), value: await api.operations() };
        }
        return json(res, 200, cached.value);
      }
      if (req.method !== "POST" || !address.startsWith("/api/"))
        return json(res, 404, { error: "NOT_FOUND" });
      if (
        req.headers.origin !== expectedOrigin ||
        req.headers["content-type"]?.split(";")[0] !== "application/json"
      )
        return json(res, 403, { error: "ORIGIN_REQUIRED" });
      const body = await readBody(req);
      if (address === "/api/setup") {
        if (!state.setupRequired) return json(res, 409, { error: "ALREADY_INITIALIZED" });
        if (!setupIps.includes(remoteIp))
          return json(res, 403, { error: "SETUP_DEVICE_NOT_ALLOWED" });
        if (blocked(remoteIp)) return json(res, 429, { error: "TOO_MANY_ATTEMPTS" });
        try {
          state.setup(String(body.password ?? ""));
        } catch (error) {
          recordAttempt(remoteIp);
          throw error;
        }
        return sessionResponse(res, state, secureCookie);
      }
      if (address === "/api/login") {
        if (state.setupRequired) return json(res, 409, { error: "SETUP_REQUIRED" });
        if (blocked(remoteIp)) return json(res, 429, { error: "TOO_MANY_ATTEMPTS" });
        if (!state.verifyPassword(String(body.password ?? ""))) {
          recordAttempt(remoteIp);
          return json(res, 401, { error: "PASSWORD_INCORRECT" });
        }
        attempts.delete(remoteIp);
        return sessionResponse(res, state, secureCookie);
      }
      if (!session) return json(res, 401, { error: "LOGIN_REQUIRED" });
      if (req.headers["x-panel-csrf"] !== session.csrf)
        return json(res, 403, { error: "CSRF_INVALID" });
      switch (address) {
        case "/api/logout":
          state.logout(cookie);
          res.setHeader(
            "set-cookie",
            `readback_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? "; Secure" : ""}`,
          );
          return json(res, 200, { ok: true });
        case "/api/password": {
          state.changePassword(String(body.currentPassword ?? ""), String(body.newPassword ?? ""));
          return sessionResponse(res, state, secureCookie);
        }
        case "/api/token":
          if (typeof body.token !== "string") throw new Error("TOKEN_FORMAT_INVALID");
          state.configureToken(body.token);
          return json(res, 200, { ok: true, tokenConfigured: true });
        case "/api/provider":
          if (typeof body.endpoint !== "string") throw new Error("PROVIDER_ENDPOINT_INVALID");
          if (body.token !== undefined && typeof body.token !== "string")
            throw new Error("TOKEN_FORMAT_INVALID");
          state.configureProvider(body.endpoint, body.token as string | undefined);
          return json(res, 200, { ok: true, tokenConfigured: true, endpointConfigured: true });
        case "/api/worker":
          if (typeof body.enabled !== "boolean") throw new Error("INVALID_INPUT");
          state.enable(body.enabled);
          return json(res, 200, { ok: true, workerEnabled: state.workerEnabled });
        case "/api/probe": {
          if (body.confirmed !== true || typeof body.link !== "string")
            throw new Error("PAID_PROBE_CONFIRMATION_REQUIRED");
          if (probing) return json(res, 409, { error: "PROBE_ALREADY_RUNNING" });
          const noteId = noteIdFromInput(body.link);
          const endpoint = state.endpoint;
          if (!endpoint) throw new Error("PROVIDER_ENDPOINT_MISSING");
          const token = state.token();
          if (!token) throw new Error("TOKEN_MISSING");
          state.reserveProbe(new Date());
          const configurationVersion = state.configurationVersion;
          probing = true;
          try {
            const result = await fetchNoteDetail({ endpoint, token, noteId });
            if (state.configurationVersion !== configurationVersion)
              return json(res, 409, { error: "PROVIDER_CONFIGURATION_CHANGED" });
            const complete =
              result.status === "AVAILABLE" &&
              Boolean(result.note.title.trim() && result.note.body.trim()) &&
              result.note.likes !== null &&
              result.note.comments !== null &&
              result.note.favorites !== null;
            state.recordProbe(
              result.status === "AVAILABLE" && !complete ? "INCOMPLETE_NOTE" : result.status,
              new Date(),
            );
            return json(
              res,
              200,
              result.status === "AVAILABLE"
                ? {
                    status: result.status,
                    titlePresent: result.note.title.length > 0,
                    bodyPresent: result.note.body.length > 0,
                    metrics: {
                      likes: result.note.likes,
                      comments: result.note.comments,
                      favorites: result.note.favorites,
                    },
                  }
                : { status: result.status, code: result.code },
            );
          } finally {
            probing = false;
          }
        }
        default:
          return json(res, 404, { error: "NOT_FOUND" });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "UNKNOWN";
      const allowed = new Set([
        "PASSWORD_LENGTH_INVALID",
        "PASSWORD_INCORRECT",
        "TOKEN_FORMAT_INVALID",
        "TOKEN_MISSING",
        "PROVIDER_ENDPOINT_INVALID",
        "PROVIDER_ENDPOINT_MISSING",
        "SUCCESSFUL_SAMPLE_REQUIRED",
        "PROBE_DAILY_LIMIT",
        "PAID_PROBE_CONFIRMATION_REQUIRED",
        "NOTE_LINK_INVALID",
        "NOTE_LINK_UNSUPPORTED",
        "NOTE_ID_REQUIRED",
        "INVALID_INPUT",
      ]);
      return json(res, allowed.has(code) ? 400 : 502, {
        error: allowed.has(code) ? code : "SERVICE_UNAVAILABLE",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write("READBACK_PANEL_READY\n");
  let closing: Promise<void> | null = null;
  return {
    state,
    close: () => {
      closing ??= new Promise<void>((resolve) => server.close(() => resolve()));
      return closing;
    },
  };
}

function normalizeIp(value: string): string {
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6) {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/u.exec(canonical);
    if (!mapped) return canonical;
    const high = Number.parseInt(mapped[1] ?? "", 16);
    const low = Number.parseInt(mapped[2] ?? "", 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  throw new Error("PANEL_SETUP_IPS_INVALID");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function setHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sessionResponse(res: ServerResponse, state: PanelState, secure: boolean): void {
  const session = state.createSession();
  res.setHeader(
    "set-cookie",
    `readback_session=${session.cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? "; Secure" : ""}`,
  );
  json(res, 200, { ok: true, csrf: session.csrf });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error("BODY_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_BODY");
  return body as Record<string, unknown>;
}

function blocked(ip: string): boolean {
  const entry = attempts.get(ip);
  return Boolean(entry && entry.until > Date.now() && entry.count >= 5);
}

function recordAttempt(ip: string): void {
  const entry = attempts.get(ip);
  attempts.set(
    ip,
    entry && entry.until > Date.now()
      ? { ...entry, count: entry.count + 1 }
      : { count: 1, until: Date.now() + 15 * 60_000 },
  );
}
