import { withPublicHttpResponse } from "@xhs-agentic/network-security";
import {
  extractPublicationAccessUrl,
  type NormalizedPublicationUrl,
  normalizePublicationUrl,
} from "./publication-url";

export class PublicationShortUrlError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function resolvePublicationShortUrl(input: string): Promise<NormalizedPublicationUrl> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const accessUrl = extractPublicationAccessUrl(input);
    if (normalizePublicationUrl(accessUrl).classification !== "XHS_SHORT") {
      throw new PublicationShortUrlError("SHORT_URL_TARGET_INVALID");
    }
    return await Promise.race([
      withPublicHttpResponse(
        accessUrl,
        { method: "GET", signal: controller.signal },
        {
          maxRedirects: 4,
          validateUrl: (url) => {
            try {
              extractPublicationAccessUrl(url.toString());
            } catch {
              throw new PublicationShortUrlError("SHORT_URL_TARGET_INVALID");
            }
          },
          stopAtRedirect: (url) =>
            normalizePublicationUrl(url.toString()).classification === "XHS_NOTE",
        },
        async (response, finalUrl) => {
          await response.body?.cancel();
          if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) {
            throw new PublicationShortUrlError("SHORT_URL_UNAVAILABLE");
          }
          const target = normalizePublicationUrl(finalUrl.toString());
          if (target.classification !== "XHS_NOTE") {
            throw new PublicationShortUrlError("SHORT_URL_NOTE_REQUIRED");
          }
          return target;
        },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PublicationShortUrlError("SHORT_URL_TIMEOUT"));
        }, 5_000);
      }),
    ]);
  } catch (error) {
    if (error instanceof PublicationShortUrlError) throw error;
    throw new PublicationShortUrlError("SHORT_URL_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}
