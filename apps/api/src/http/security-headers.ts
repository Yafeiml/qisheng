import type { IncomingMessage, ServerResponse } from "node:http";

export function securityHeadersMiddleware(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const isApiDocs = request.url?.startsWith("/api-docs") ?? false;
  response.setHeader(
    "Content-Security-Policy",
    isApiDocs
      ? "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
      : "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}
