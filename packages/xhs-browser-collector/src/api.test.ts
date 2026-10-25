import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignedJobSource } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("HMAC collector API", () => {
  it("signs GET with an empty body and POST over exact JSON bytes", async () => {
    const observed: Array<{ input: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      observed.push({ input, init });
      return new Response(JSON.stringify({ paused: false, reason: null }), { status: 200 });
    });
    const secret = "super-secret-for-the-collector-test-only-abcdef";
    const api = new SignedJobSource("https://api.example.test", "collector_001", secret);
    await api.status();
    await api.pause("CHALLENGE_REQUIRED");
    for (const { input, init } of observed) {
      const headers = new Headers(init.headers);
      const path = new URL(input).pathname;
      const payload = typeof init.body === "string" ? init.body : "";
      const msg = [
        init.method,
        path,
        headers.get("x-collector-timestamp"),
        headers.get("x-collector-request-id"),
        createHash("sha256").update(payload).digest("hex"),
      ].join("\n");
      expect(headers.get("x-collector-signature")).toBe(
        createHmac("sha256", secret).update(msg).digest("hex"),
      );
      expect(init.redirect).toBe("error");
    }
    expect(observed[0]?.init.body).toBeUndefined();
    expect(observed[1]?.init.body).toBe(JSON.stringify({ reason: "CHALLENGE_REQUIRED" }));
  });

  it("never sends an approximate metric as an exact value", async () => {
    let uploaded: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
      uploaded = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: "NEEDS_REVIEW" }), { status: 200 });
    });
    const api = new SignedJobSource(
      "https://api.example.test",
      "collector_001",
      "super-secret-for-the-collector-test-only-abcdef",
    );
    await api.evidence(
      {
        id: "server-0001",
        kind: "VERIFY",
        accessUrl: "https://www.xiaohongshu.com/explore/mock0001?xsec_token=private",
        leaseToken: "00000000-0000-4000-8000-000000000001",
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        submittedAt: new Date().toISOString(),
        dueAt: new Date().toISOString(),
        windowHours: null,
      },
      {
        status: "PARTIAL",
        observedAt: new Date().toISOString(),
        visibilityContext: "COLLECTOR_ACCOUNT",
        metrics: {
          likes: { value: 12000, raw: "1.2万", precision: "APPROXIMATE" },
          comments: { value: null, raw: "评论", precision: "UNAVAILABLE" },
          favorites: { value: 0, raw: "0", precision: "EXACT" },
        },
      },
    );
    expect(uploaded?.metrics).toEqual({ favorites: 0 });
    expect(uploaded?.metricsRaw).toEqual({
      likes: { value: null, raw: "1.2万", precision: "APPROXIMATE" },
      comments: { value: null, raw: null, precision: "UNAVAILABLE" },
      favorites: { value: 0, raw: "0", precision: "EXACT" },
    });
    expect(JSON.stringify(uploaded)).not.toContain("xsec_token");
  });
});
