import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "error" | "info" | "warn";

export type LogContext = Readonly<{
  enterpriseId?: string;
  generationRunId?: string;
  jobId?: string;
  requestId?: string;
  tenantId?: string;
  workItemId?: string;
}>;

export type StructuredLogInput = Readonly<{
  event: string;
  fields?: Readonly<Record<string, unknown>>;
  level: LogLevel;
  service: string;
}>;

const logContext = new AsyncLocalStorage<LogContext>();
const sensitiveKey =
  /(?:authorization|cookie|credential|password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|probe[_-]?token|otp|verification[_-]?code)/iu;

export function postgresConnectionStringWithUtcSession(connectionString: string): string {
  const url = new URL(connectionString);
  const options = url.searchParams.get("options")?.trim() ?? "";
  if (!/(?:^|\s)-c\s*timezone=UTC(?:\s|$)/iu.test(options)) {
    url.searchParams.set("options", `${options} -c timezone=UTC`.trim());
  }
  return url.toString();
}

export function runWithLogContext<T>(context: LogContext, operation: () => T): T {
  return logContext.run(Object.freeze({ ...currentLogContext(), ...context }), operation);
}

export function currentLogContext(): LogContext {
  return logContext.getStore() ?? {};
}

export function writeStructuredLog(input: StructuredLogInput): void {
  if (!shouldWrite(input.level)) return;
  const sanitizedFields = sanitizeLogValue({ ...currentLogContext(), ...input.fields });
  const record = {
    ...(isRecord(sanitizedFields) ? sanitizedFields : {}),
    event: input.event,
    level: input.level,
    service: input.service,
    timestamp: new Date().toISOString(),
  };
  const output = `${JSON.stringify(record)}\n`;
  if (input.level === "error" || input.level === "warn") {
    process.stderr.write(output);
  } else {
    process.stdout.write(output);
  }
}

function shouldWrite(level: LogLevel): boolean {
  const configured = process.env.LOG_LEVEL ?? "info";
  if (configured === "silent") return false;
  const priorities: Readonly<Record<LogLevel, number>> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  const threshold = priorities[configured as LogLevel];
  if (threshold === undefined) return true;
  return priorities[level] >= threshold;
}

export function sanitizeLogValue(value: unknown, key?: string): unknown {
  return sanitize(value, key, new WeakSet<object>());
}

function sanitize(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      message: sanitizeString(value.message).slice(0, 1_000),
      name: value.name,
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.slice(0, 100).map((entry) => sanitize(entry, undefined, seen));
  }
  if (isRecord(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey, seen)]),
    );
  }
  return value;
}

function sanitizeString(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:postgres(?:ql)?|rediss?|https?):\/\/[^\s:/@]+:)[^\s@/]+@/giu, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/gu, "$1****$2");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
