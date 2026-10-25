import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { ApiExceptionFilter } from "./http/api-exception.filter";
import { requestIdMiddleware } from "./http/request-id";
import { securityHeadersMiddleware } from "./http/security-headers";

type ExpressLikeAdapter = Readonly<{
  getInstance(): { disable(name: string): void; set(name: string, value: number): void };
  useBodyParser(type: "json" | "urlencoded", rawBody: boolean, options: object): void;
}>;

export function configureApplication(app: INestApplication): void {
  const adapter = app.getHttpAdapter() as unknown as ExpressLikeAdapter;
  const bodyLimit = `${positiveInteger(process.env.API_BODY_LIMIT_BYTES ?? "102400")}b`;
  const trustProxyHops = nonNegativeInteger(process.env.TRUST_PROXY_HOPS ?? "0");
  adapter.getInstance().disable("x-powered-by");
  if (trustProxyHops > 0) adapter.getInstance().set("trust proxy", trustProxyHops);
  app.use(requestIdMiddleware);
  app.use(securityHeadersMiddleware);
  adapter.useBodyParser("json", true, {
    limit: bodyLimit,
    type: ordinaryBodyType("application/json"),
  });
  adapter.useBodyParser("urlencoded", false, {
    extended: false,
    limit: bodyLimit,
    type: ordinaryBodyType("application/x-www-form-urlencoded"),
  });
  app.enableCors({
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
    credentials: true,
    methods: ["DELETE", "GET", "PATCH", "POST", "PUT"],
    origin: allowedOrigins(),
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
}

function ordinaryBodyType(mimeType: string) {
  return (request: {
    method: string;
    url: string;
    headers: { "content-type"?: string };
  }): boolean => {
    // Local uploads validate their signature before reading a size-bounded byte stream.
    if (request.method === "PUT" && /^\/storage\/objects(?:\/|$)/u.test(request.url)) return false;
    return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === mimeType;
  };
}

export function allowedOrigins(): string[] {
  const origins = (process.env.ADMIN_WEB_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new Error("ADMIN_WEB_ORIGIN must contain at least one origin");
  if (origins.includes("*")) throw new Error("ADMIN_WEB_ORIGIN cannot use wildcard credentials");
  if (process.env.NODE_ENV === "production") return origins;

  const developmentOrigins = new Set(origins);
  for (const origin of origins) {
    const alias = loopbackAlias(origin);
    if (alias) developmentOrigins.add(alias);
  }
  return [...developmentOrigins];
}

function loopbackAlias(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.hostname === "127.0.0.1") url.hostname = "localhost";
    else if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Expected a positive integer");
  return parsed;
}

function nonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Expected a non-negative integer");
  }
  return parsed;
}
