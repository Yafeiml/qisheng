import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as undiciFetch } from "undici";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type PublicHttpLookupAddress = Readonly<{ address: string; family: number }>;

export type PublicHttpPolicyOptions = Readonly<{
  allowHttp?: boolean;
  allowPrivate?: boolean;
  lookup?: (hostname: string) => Promise<readonly PublicHttpLookupAddress[]>;
  maxRedirects?: number;
  validateUrl?: (url: URL) => void;
  // If true, consume receives the cancelled redirect response and its validated
  // target URL; the target itself is not requested.
  stopAtRedirect?: (url: URL) => boolean;
}>;

export class PublicHttpPolicyError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function normalizePublicHttpUrl(
  input: string | URL,
  options: Pick<PublicHttpPolicyOptions, "allowHttp" | "allowPrivate"> = {},
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw policyError("PUBLIC_HTTP_URL_INVALID", "External URL must be absolute");
  }
  if (url.username || url.password || url.hash) {
    throw policyError(
      "PUBLIC_HTTP_URL_CREDENTIALS",
      "External URL cannot contain credentials or a fragment",
    );
  }
  if (url.protocol !== "https:" && !(options.allowHttp === true && url.protocol === "http:")) {
    throw policyError("PUBLIC_HTTP_SCHEME_UNSAFE", "External URL must use HTTPS");
  }
  if (options.allowPrivate !== true && isPrivateHostname(url.hostname)) {
    throw policyError("PUBLIC_HTTP_HOST_PRIVATE", "External URL targets a private network");
  }
  return url;
}

export async function resolvePublicHttpUrl(
  input: string | URL,
  options: Pick<PublicHttpPolicyOptions, "allowHttp" | "allowPrivate" | "lookup"> = {},
): Promise<
  Readonly<{
    address: string;
    addresses: readonly PublicHttpLookupAddress[];
    family: number;
    url: URL;
  }>
> {
  const url = normalizePublicHttpUrl(input, options);
  const hostname = normalizedHostname(url.hostname);
  const ipFamily = isIP(hostname);
  let addresses: readonly PublicHttpLookupAddress[];
  if (ipFamily) {
    addresses = [{ address: hostname, family: ipFamily }];
  } else {
    addresses = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        addresses = options.lookup
          ? await options.lookup(hostname)
          : await dnsLookup(hostname, { all: true, verbatim: true });
        break;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (attempt === 2 || (code !== "ENOTFOUND" && code !== "EAI_AGAIN")) {
          throw policyError("PUBLIC_HTTP_DNS_FAILED", "External hostname could not be resolved");
        }
        // Retry resolution before opening a connection; never replay a paid HTTP request here.
        await delay(100);
      }
    }
  }
  if (addresses.length === 0) {
    throw policyError("PUBLIC_HTTP_DNS_EMPTY", "External hostname has no address records");
  }
  if (
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) || isIP(normalizedHostname(address)) !== family,
    )
  ) {
    throw policyError("PUBLIC_HTTP_DNS_INVALID", "External hostname resolved incorrectly");
  }
  if (options.allowPrivate !== true && addresses.some(({ address }) => isPrivateAddress(address))) {
    throw policyError(
      "PUBLIC_HTTP_DNS_PRIVATE",
      "External hostname resolves to a private or reserved address",
    );
  }
  const orderedAddresses = uniqueAddresses(addresses).sort(
    (left, right) => Number(right.family === 4) - Number(left.family === 4),
  );
  const selected = orderedAddresses[0];
  if (!selected) {
    throw policyError("PUBLIC_HTTP_DNS_INVALID", "External hostname resolved incorrectly");
  }
  return {
    address: selected.address,
    addresses: orderedAddresses,
    family: selected.family,
    url,
  };
}

export async function withPublicHttpResponse<T>(
  input: string | URL,
  init: RequestInit,
  options: PublicHttpPolicyOptions,
  consume: (response: Response, finalUrl: URL, redirectCount: number) => Promise<T>,
): Promise<T> {
  const maxRedirects = redirectLimit(options.maxRedirects ?? 0);
  const method = (init.method ?? "GET").toUpperCase();
  let current = normalizePublicHttpUrl(input, options);
  let redirects = 0;
  while (true) {
    init.signal?.throwIfAborted();
    options.validateUrl?.(current);
    const resolved = await resolvePublicHttpUrl(current, options);
    init.signal?.throwIfAborted();
    const dispatcher = new Agent({
      connect: {
        lookup: ((_, lookupOptions, callback) => {
          if (typeof lookupOptions === "object" && lookupOptions.all === true) {
            callback(null, [...resolved.addresses]);
            return;
          }
          callback(null, resolved.address, resolved.family);
        }) as LookupFunction,
      },
    });
    try {
      const request = {
        ...init,
        dispatcher,
        redirect: "manual",
      } as Parameters<typeof undiciFetch>[1];
      const response = (await undiciFetch(resolved.url, request)) as unknown as Response;
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects >= maxRedirects || (method !== "GET" && method !== "HEAD")) {
          throw policyError(
            "PUBLIC_HTTP_REDIRECT_FORBIDDEN",
            "External service returned a forbidden redirect",
          );
        }
        current = normalizePublicHttpUrl(new URL(location, resolved.url), options);
        redirects += 1;
        options.validateUrl?.(current);
        if (options.stopAtRedirect?.(current)) {
          return await consume(response, current, redirects);
        }
        continue;
      }
      return await consume(response, resolved.url, redirects);
    } finally {
      await dispatcher.close();
    }
  }
}

function uniqueAddresses(addresses: readonly PublicHttpLookupAddress[]): PublicHttpLookupAddress[] {
  const seen = new Set<string>();
  return addresses.filter(({ address, family }) => {
    const key = `${family}:${normalizedHostname(address)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isPrivateAddress(address: string): boolean {
  let value = normalizedHostname(address);
  if (value.includes(":")) {
    try {
      value = normalizedHostname(new URL(`https://[${value}]/`).hostname);
    } catch {
      return true;
    }
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/u.exec(value);
    if (mapped) {
      const high = Number.parseInt(mapped[1] ?? "", 16);
      const low = Number.parseInt(mapped[2] ?? "", 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/u.test(value) ||
      value.startsWith("ff") ||
      value.startsWith("2001:db8")
    );
  }
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateHostname(hostname: string): boolean {
  const value = normalizedHostname(hostname);
  if (isIP(value)) return isPrivateAddress(value);
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value.endsWith(".home.arpa") ||
    value === "metadata.google.internal"
  );
}

function normalizedHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
}

function redirectLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5) {
    throw policyError(
      "PUBLIC_HTTP_REDIRECT_LIMIT_INVALID",
      "Redirect limit must be between 0 and 5",
    );
  }
  return value;
}

function policyError(code: string, message: string): PublicHttpPolicyError {
  return new PublicHttpPolicyError(message, code);
}
