import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePanelPublicUrl, SignedReadbackApi } from "./job-api";
import { runOnce } from "./runner";

const key = "f".repeat(64);
const leaseToken = "754db0e9-29d2-4ccc-9f95-756b13098de5";

describe("distributed readback client", () => {
  beforeEach(() => {
    vi.stubEnv("READBACK_PANEL_HOST", "");
    vi.stubEnv("READBACK_PANEL_PORT", "");
    vi.stubEnv("READBACK_PANEL_PUBLIC_URL", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("signs each request with a unique nonce and calls the vendor only once", async () => {
    const seen: { path: string; input: Record<string, unknown> }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const signedPath = path.replace(/^\/api(?=\/integrations\/)/u, "");
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      const signature = createHmac("sha256", key)
        .update(
          [
            init?.method,
            signedPath,
            headers.get("x-collector-timestamp"),
            headers.get("x-collector-request-id"),
            createHash("sha256").update(body).digest("hex"),
          ].join("\n"),
        )
        .digest("hex");
      expect(headers.get("x-collector-signature")).toBe(signature);
      expect(headers.get("x-collector-id")).toBe("node-1");
      if (body) seen.push({ path, input: JSON.parse(body) as Record<string, unknown> });
      const response = path.endsWith("/claim")
        ? {
            paused: false,
            reason: null,
            job: {
              id: "testjob123",
              noteId: "abc123xyz",
              leaseToken,
              dueAt: new Date(Date.now() - 1000).toISOString(),
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }
        : { status: "COMPLETED" };
      return new Response(JSON.stringify(response), { status: 201 });
    });
    const api = new SignedReadbackApi("https://api.example.org/api/", "node-1", key, fetcher);
    const vendor = vi.fn(async () => ({
      status: "AVAILABLE" as const,
      note: {
        noteId: "abc123xyz",
        title: "样本",
        body: "正文",
        authorId: null,
        publishedAt: null,
        imageCount: 1,
        hashtags: [],
        likes: 0,
        comments: null,
        favorites: 8,
      },
    }));
    expect(
      await runOnce(
        api,
        { endpoint: "https://provider.example.org/note", token: "secret-only-node" },
        vendor,
      ),
    ).toBe("COMMITTED");
    expect(vendor).toHaveBeenCalledOnce();
    expect(vendor).toHaveBeenCalledWith({
      endpoint: "https://provider.example.org/note",
      token: "secret-only-node",
      noteId: "abc123xyz",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.path).toBe("/api/integrations/v1/publication-readback/claim");
    expect(seen[1]?.input).toMatchObject({
      source: "API_PROVIDER",
      status: "AVAILABLE",
      observedAt: expect.any(String),
    });
    expect(JSON.stringify(seen)).not.toContain("secret-only-node");
    const ids = fetcher.mock.calls.map(([, input]) =>
      new Headers(input?.headers).get("x-collector-request-id"),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("does not call a supplier when no job is due", async () => {
    const api = new SignedReadbackApi(
      "https://api.example.org",
      "node-1",
      key,
      async () =>
        new Response(JSON.stringify({ paused: false, reason: null, job: null }), { status: 201 }),
    );
    const vendor = vi.fn(async () => {
      throw new Error("should not run");
    });
    expect(
      await runOnce(
        api,
        { endpoint: "https://provider.example.org/note", token: "secret-only-node" },
        vendor,
      ),
    ).toBe("IDLE");
    expect(vendor).not.toHaveBeenCalled();
  });

  it.each([
    { endpoint: "", token: "secret-only-node" },
    { endpoint: "https://provider.example.org/note", token: "" },
  ])("does not claim a job with incomplete provider configuration", async (provider) => {
    const request = vi.fn<typeof fetch>();
    const api = new SignedReadbackApi("https://api.example.org", "node-1", key, request);
    expect(await runOnce(api, provider)).toBe("IDLE");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an unsafe configured endpoint before claiming a job", async () => {
    const request = vi.fn<typeof fetch>();
    const api = new SignedReadbackApi("https://api.example.org", "node-1", key, request);
    await expect(
      runOnce(api, { endpoint: "https://127.0.0.1/note", token: "secret-only-node" }),
    ).rejects.toThrow("PROVIDER_ENDPOINT_INVALID");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an invalid token before claiming a job", async () => {
    const request = vi.fn<typeof fetch>();
    const api = new SignedReadbackApi("https://api.example.org", "node-1", key, request);
    await expect(
      runOnce(api, {
        endpoint: "https://provider.example.org/note",
        token: "secret\r\nX-Injected: value",
      }),
    ).rejects.toThrow("PROVIDER_TOKEN_INVALID");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["http://api:3100/api/", "http://api:3100/api/integrations/v1/publication-readback/status"],
    ["http://localhost:3100", "http://localhost:3100/integrations/v1/publication-readback/status"],
    [
      "http://192.168.1.20:8080/企声/api///",
      "http://192.168.1.20:8080/%E4%BC%81%E5%A3%B0/api/integrations/v1/publication-readback/status",
    ],
    [
      "https://example.org:8443/services/qisheng",
      "https://example.org:8443/services/qisheng/integrations/v1/publication-readback/status",
    ],
    ["http://[::1]:3100/", "http://[::1]:3100/integrations/v1/publication-readback/status"],
  ])("accepts user-managed API networking and proxy prefix %s", async (baseUrl, expectedUrl) => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(expectedUrl);
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      const signature = createHmac("sha256", key)
        .update(
          [
            "GET",
            "/integrations/v1/publication-readback/status",
            headers.get("x-collector-timestamp"),
            headers.get("x-collector-request-id"),
            createHash("sha256").update("").digest("hex"),
          ].join("\n"),
        )
        .digest("hex");
      expect(headers.get("x-collector-signature")).toBe(signature);
      return new Response(JSON.stringify({ paused: false, reason: null }));
    });
    await new SignedReadbackApi(baseUrl, "node-1", key, request).status();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    "ftp://api.example.org",
    "https://user:password@api.example.org",
    "https://@api.example.org",
    "http://api:3100/api?x=1",
    "http://api:3100/api?",
    "http://api:3100/api#fragment",
    "http://api:3100/api#",
    "http://api:3100/a\nb",
    "http://api:3100/a\u007fb",
  ])("rejects malformed or credential-bearing API URL %j", (baseUrl) => {
    expect(() => new SignedReadbackApi(baseUrl, "node-1", key)).toThrow(
      "READBACK_API_BASE_URL_INVALID",
    );
  });

  it.each([
    ["https://collector.example.org:8443", "https://collector.example.org:8443/"],
    ["http://localhost:13110/", "http://localhost:13110/"],
    ["http://192.168.1.20:8080", "http://192.168.1.20:8080/"],
    ["http://[::1]:13110", "http://[::1]:13110/"],
  ])("signs the configured public panel URL %s", async (panelUrl, canonicalUrl) => {
    vi.stubEnv("READBACK_PANEL_PUBLIC_URL", panelUrl);
    vi.stubEnv("READBACK_PANEL_HOST", "0.0.0.0");
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-collector-panel-url")).toBe(canonicalUrl);
      expect(headers.has("x-collector-panel-host")).toBe(false);
      const signed = [
        "GET",
        "/integrations/v1/publication-readback/status",
        headers.get("x-collector-timestamp"),
        headers.get("x-collector-request-id"),
        createHash("sha256").update("").digest("hex"),
        canonicalUrl,
      ];
      expect(headers.get("x-collector-signature")).toBe(
        createHmac("sha256", key).update(signed.join("\n")).digest("hex"),
      );
      expect(headers.get("x-collector-signature")).not.toBe(
        createHmac("sha256", key)
          .update([...signed.slice(0, 5), "http://other.example.org/"].join("\n"))
          .digest("hex"),
      );
      return new Response(JSON.stringify({ paused: false, reason: null }));
    });
    await new SignedReadbackApi("http://api:3100/api", "node-1", key, request).status();
  });

  it.each([
    ["192.168.1.20", "8080", "http://192.168.1.20:8080/"],
    ["collector", "13110", "http://collector:13110/"],
    ["::1", "13110", "http://[::1]:13110/"],
    ["0.0.0.0", "13110", null],
    ["::", "13110", null],
    ["0:0:0:0:0:0:0:0", "13110", null],
    ["0x0", "13110", null],
    ["", "13110", null],
  ])("derives panel shortcuts only from concrete bind hosts %s", async (host, port, expected) => {
    vi.stubEnv("READBACK_PANEL_HOST", host);
    vi.stubEnv("READBACK_PANEL_PORT", port);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-collector-panel-url")).toBe(expected);
      expect(headers.has("x-collector-panel-host")).toBe(false);
      return new Response(JSON.stringify({ paused: false, reason: null }));
    });
    await new SignedReadbackApi("http://api:3100", "node-1", key, request).status();
  });

  it("uses the panel's default port for a concrete bind host", async () => {
    vi.stubEnv("READBACK_PANEL_HOST", "localhost");
    delete process.env.READBACK_PANEL_PORT;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("x-collector-panel-url")).toBe(
        "http://localhost:13110/",
      );
      return new Response(JSON.stringify({ paused: false, reason: null }));
    });
    await new SignedReadbackApi("http://api:3100", "node-1", key, request).status();
  });

  it.each([
    "javascript:alert(1)",
    "https://user:password@collector.example.org",
    "https://@collector.example.org",
    "https://collector.example.org/panel",
    "https://collector.example.org/?a=b",
    "https://collector.example.org/?",
    "https://collector.example.org/#x",
    "https://collector.example.org/#",
    "https://collector.example.org/\n",
    "http://0.0.0.0:13110",
    "http://[::]:13110",
    "http://[0:0:0:0:0:0:0:0]:13110",
  ])("rejects malformed or credential-bearing public panel URL %j", async (panelUrl) => {
    expect(() => normalizePanelPublicUrl(panelUrl)).toThrow("READBACK_PANEL_PUBLIC_URL_INVALID");
    vi.stubEnv("READBACK_PANEL_PUBLIC_URL", panelUrl);
    const request = vi.fn<typeof fetch>();
    await expect(
      new SignedReadbackApi("http://api:3100", "node-1", key, request).status(),
    ).rejects.toThrow("READBACK_PANEL_PUBLIC_URL_INVALID");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not follow main service redirects", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("unexpected redirect");
    });
    await expect(
      new SignedReadbackApi("http://api:3100", "node-1", key, request).status(),
    ).rejects.toThrow("unexpected redirect");
    expect(request).toHaveBeenCalledOnce();
  });
});
