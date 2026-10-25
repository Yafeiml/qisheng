const hopByHopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function internalApiBaseUrl(): string {
  const value =
    process.env.INTERNAL_API_BASE_URL ||
    process.env.PLATFORM_API_INTERNAL_URL ||
    (process.env.NODE_ENV === "production" ? "http://api:3100" : "http://127.0.0.1:3100");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid internal API configuration");
  return url.href.replace(/\/$/u, "");
}

function forwardedValue(headers: Headers, name: string): string | null {
  return headers.get(name)?.split(",", 1)[0]?.trim() || null;
}

function externalOrigin(request: Request): URL {
  const requested = new URL(request.url);
  const host =
    forwardedValue(request.headers, "x-forwarded-host") ||
    request.headers.get("host") ||
    requested.host;
  const forwardedProtocol = forwardedValue(request.headers, "x-forwarded-proto");
  const protocol = forwardedProtocol ? `${forwardedProtocol.toLowerCase()}:` : requested.protocol;
  if (!["http:", "https:"].includes(protocol) || /[/\\@?#\s]/u.test(host))
    throw new Error("Invalid request origin");
  return new URL(`${protocol}//${host}`);
}

function isSameOriginRequest(request: Request, expected: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== expected.origin) return false;
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
  }
  return true;
}

function removeHopByHopHeaders(headers: Headers) {
  const connectionHeaders = headers.get("connection")?.split(",") ?? [];
  for (const name of [...hopByHopHeaders, ...connectionHeaders.map((value) => value.trim())])
    if (name) headers.delete(name);
}

function refreshCookieForGateway(cookie: string, secure: boolean): string {
  if (!cookie.startsWith("xhs_admin_refresh=")) return cookie;
  const attributes = cookie
    .split(";")
    .map((value) => value.trim())
    .filter((value) => !/^path=/iu.test(value) && !/^secure$/iu.test(value));
  attributes.push("Path=/api/auth/admin");
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export async function proxyApiRequest(request: Request): Promise<Response> {
  let origin: URL;
  try {
    origin = externalOrigin(request);
    if (!isSameOriginRequest(request, origin))
      return Response.json({ message: "不允许跨站调用此接口" }, { status: 403 });
  } catch {
    return Response.json({ message: "请求来源无效" }, { status: 403 });
  }
  try {
    const incoming = new URL(request.url);
    const upstream = new URL(internalApiBaseUrl());
    // Assign the path without parsing user input as a new URL or upstream host.
    upstream.pathname = `${upstream.pathname.replace(/\/$/u, "")}${incoming.pathname.slice(4)}`;
    upstream.search = incoming.search;
    const headers = new Headers(request.headers);
    removeHopByHopHeaders(headers);
    for (const name of [...headers.keys()])
      if (
        name === "host" ||
        name === "origin" ||
        name === "forwarded" ||
        name.startsWith("x-forwarded-")
      )
        headers.delete(name);
    headers.set("accept-encoding", "identity");
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      duplex: "half",
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    };
    const response = await fetch(upstream, init);
    const responseHeaders = new Headers(response.headers);
    removeHopByHopHeaders(responseHeaders);
    for (const name of [...responseHeaders.keys()])
      if (
        name === "set-cookie" ||
        name === "strict-transport-security" ||
        name === "content-encoding" ||
        name === "content-length" ||
        name.startsWith("access-control-")
      )
        responseHeaders.delete(name);
    for (const cookie of response.headers.getSetCookie())
      responseHeaders.append(
        "set-cookie",
        refreshCookieForGateway(cookie, origin.protocol === "https:"),
      );
    responseHeaders.set("cache-control", "no-store");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ message: "API 服务暂时不可用，请稍后重试" }, { status: 502 });
  }
}
