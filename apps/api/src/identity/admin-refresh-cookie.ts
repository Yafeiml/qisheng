export type CookieResponse = Readonly<{
  setHeader(name: string, value: string): void;
}>;

export const ADMIN_REFRESH_COOKIE = "xhs_admin_refresh";

export function refreshTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name !== ADMIN_REFRESH_COOKIE) continue;
    const value = segment.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function setAdminRefreshCookie(
  response: CookieResponse,
  refreshToken: string,
  maxAgeSeconds: number,
): void {
  response.setHeader(
    "set-cookie",
    serializeCookie(encodeURIComponent(refreshToken), `Max-Age=${maxAgeSeconds}`),
  );
}

export function clearAdminRefreshCookie(response: CookieResponse): void {
  response.setHeader("set-cookie", serializeCookie("", "Max-Age=0"));
}

function serializeCookie(value: string, lifetime: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_REFRESH_COOKIE}=${value}; ${lifetime}; Path=/auth/admin; HttpOnly; SameSite=Strict${secure}`;
}
