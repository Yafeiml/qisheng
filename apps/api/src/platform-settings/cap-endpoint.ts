import { ConflictException } from "@nestjs/common";

export function normalizeCapEndpoint(value: string): string {
  const endpoint = value.trim();
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid();
  }
  if (
    !/^https?:\/\/[^/?#@\s\\]+\/[A-Za-z0-9_-]+\/?$/iu.test(endpoint) ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw invalid();
  }
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/`;
  return url.toString();
}

function invalid(): ConflictException {
  return new ConflictException({
    code: "CAP_ENDPOINT_INVALID",
    key: "security.cap_endpoint",
    message:
      "Cap Endpoint 必须为不含账号、查询参数或 Fragment 的 HTTPS 地址，格式为 https://cap.example.com/<Site Key>/；仅本机回环地址允许 HTTP",
  });
}
