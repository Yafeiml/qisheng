import "server-only";
import { cache } from "react";
import { internalApiBaseUrl } from "./api-gateway";
import { defaultPlatformBranding, parsePlatformBranding } from "./platform-branding";

export const getPlatformBranding = cache(async () => {
  try {
    const origin = internalApiBaseUrl();
    const response = await fetch(`${origin.replace(/\/$/u, "")}/public/platform-branding`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return defaultPlatformBranding;
    return parsePlatformBranding(await response.json());
  } catch {
    return defaultPlatformBranding;
  }
});
