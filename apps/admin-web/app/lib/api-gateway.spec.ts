import { afterEach, describe, expect, it, vi } from "vitest";
import { internalApiBaseUrl, proxyApiRequest } from "./api-gateway";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(path = "/auth/admin/password-login", headers: HeadersInit = {}) {
  return new Request(`http://192.0.2.20:3101/api${path}`, {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "Example-password123" }),
    headers: {
      "content-type": "application/json",
      host: "192.0.2.20:3101",
      origin: "http://192.0.2.20:3101",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
}

function upstreamCookies() {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    "xhs_admin_refresh=fixture; Max-Age=3600; Path=/auth/admin; HttpOnly; SameSite=Strict; Secure",
  );
  headers.append("set-cookie", "another=fixture; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/");
  return new Response("{}", { headers });
}

describe("same-origin API gateway", () => {
  it.each(["//untrusted.example/path", "/%2F%2Funtrusted.example/path"])(
    "keeps %s on the fixed internal host while streaming its query and credentials",
    async (path) => {
      vi.stubEnv("INTERNAL_API_BASE_URL", "http://api:3100");
      const upstream = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", upstream);
      const incoming = request(`${path}?next=https%3A%2F%2Fother.example`, {
        authorization: "Bearer fixture-access",
        cookie: "xhs_admin_refresh=fixture-refresh",
        "x-forwarded-for": "192.0.2.99",
        connection: "x-private-hop",
        "x-private-hop": "remove-me",
      });
      expect((await proxyApiRequest(incoming)).status).toBe(200);
      const [url, init] = upstream.mock.calls[0] ?? [];
      expect(url.origin).toBe("http://api:3100");
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("next")).toBe("https://other.example");
      expect(init.body).toBe(incoming.body);
      expect(init.duplex).toBe("half");
      expect(init.redirect).toBe("manual");
      expect(init.headers.get("authorization")).toBe("Bearer fixture-access");
      expect(init.headers.get("cookie")).toBe("xhs_admin_refresh=fixture-refresh");
      for (const name of ["host", "origin", "x-forwarded-for", "connection", "x-private-hop"])
        expect(init.headers.has(name)).toBe(false);
      expect(init.headers.get("accept-encoding")).toBe("identity");
    },
  );

  const foreignBrowserHeaders: Record<string, string>[] = [
    { origin: "https://untrusted.example" },
    { origin: "null" },
    { origin: "http://192.0.2.20:3101/" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "cross-site" },
  ];
  it.each(foreignBrowserHeaders)(
    "rejects foreign browser requests before reaching the API: %j",
    async (headers) => {
      const upstream = vi.fn();
      vi.stubGlobal("fetch", upstream);
      expect((await proxyApiRequest(request(undefined, headers))).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(["same-site", "cross-site"])(
    "rejects %s writes without Origin using Fetch Metadata",
    async (site) => {
      const incoming = request();
      incoming.headers.delete("origin");
      incoming.headers.set("sec-fetch-site", site);
      const upstream = vi.fn();
      vi.stubGlobal("fetch", upstream);
      expect((await proxyApiRequest(incoming)).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("accepts HTTPS through an unregistered reverse-proxy hostname", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstreamCookies()));
    const response = await proxyApiRequest(
      request(undefined, {
        origin: "https://new-install.example:8443",
        "x-forwarded-host": "new-install.example:8443",
        "x-forwarded-proto": "https",
      }),
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("Path=/api/auth/admin");
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("SameSite=Strict");
    expect(cookies[0]).toMatch(/; Secure$/u);
    expect(cookies[1]).toContain("Expires=Wed, 21 Oct 2037 07:28:00 GMT");
  });

  it("permits refresh cookies on plain HTTP IP access without changing other cookies", async () => {
    const source = upstreamCookies();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(source));
    const response = await proxyApiRequest(request());
    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toContain("Path=/api/auth/admin");
    expect(cookies[0]).not.toMatch(/; Secure(?:;|$)/u);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("SameSite=Strict");
    expect(cookies[1]).toBe(source.headers.getSetCookie()[1]);
  });

  it("keeps clearing cookies on the same proxy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: {
            "set-cookie":
              "xhs_admin_refresh=; Max-Age=0; Path=/auth/admin; HttpOnly; SameSite=Strict; Secure",
          },
        }),
      ),
    );
    const response = await proxyApiRequest(request("/auth/admin/logout"));
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(response.headers.getSetCookie()[0]).toContain("Path=/api/auth/admin");
  });

  it("streams binary responses and removes transport and CORS policy headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([0, 128, 255]), {
          headers: {
            "content-type": "image/png",
            "content-length": "999",
            "content-encoding": "gzip",
            "strict-transport-security": "max-age=31536000; includeSubDomains",
            "access-control-allow-origin": "https://untrusted.example",
            "access-control-allow-credentials": "true",
            connection: "x-private-hop",
            "x-private-hop": "remove-me",
          },
        }),
      ),
    );
    const response = await proxyApiRequest(new Request("http://192.0.2.20:3101/api/image"));
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 128, 255]);
    expect(response.headers.get("content-type")).toBe("image/png");
    for (const name of [
      "content-length",
      "content-encoding",
      "strict-transport-security",
      "connection",
      "x-private-hop",
      "access-control-allow-origin",
      "access-control-allow-credentials",
    ])
      expect(response.headers.has(name)).toBe(false);
  });

  it.each([
    "file:///private/fixture",
    "http://user:fixture@api:3100",
    "http://api:3100/?token=fixture",
    "http://api:3100/#fixture",
  ])("fails closed without exposing invalid internal configuration %s", async (url) => {
    vi.stubEnv("INTERNAL_API_BASE_URL", url);
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await proxyApiRequest(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(url);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the internal service in production and does not use a public domain for server requests", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTERNAL_API_BASE_URL", "");
    vi.stubEnv("PLATFORM_API_INTERNAL_URL", "");
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://not-resolved.example/api");
    expect(internalApiBaseUrl()).toBe("http://api:3100");
  });
});
