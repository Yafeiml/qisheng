import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { writeStructuredLog } from "@xhs-agentic/observability";
import type { RequestWithId } from "./request-id";

type JsonResponse = Readonly<{
  setHeader(name: string, value: string): void;
  status(statusCode: number): JsonResponse;
  json(body: unknown): void;
}>;

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithId>();
    const response = context.getResponse<JsonResponse>();
    const statusCode = httpStatusCode(exception);
    const payload = exceptionPayload(exception, statusCode);
    if (statusCode === 429 && payload.details && typeof payload.details === "object") {
      const seconds = (payload.details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      if (typeof seconds === "number" && Number.isFinite(seconds)) {
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil(seconds))));
      }
    }

    if (statusCode >= 500) {
      writeStructuredLog({
        event: "http.request.exception",
        fields: {
          error: exception,
          path: (request.originalUrl ?? request.url ?? "").split("?", 1)[0],
          statusCode,
        },
        level: "error",
        service: "api",
      });
    }

    response.status(statusCode).json({
      code: payload.code,
      details: payload.details,
      message: payload.message,
      path: request.originalUrl ?? request.url ?? "",
      requestId: request.requestId ?? "unknown",
      statusCode,
      timestamp: new Date().toISOString(),
    });
  }
}

function exceptionPayload(
  exception: unknown,
  statusCode: number,
): Readonly<{ code: string; details?: unknown; message: string }> {
  if (!(exception instanceof HttpException)) {
    if (statusCode === HttpStatus.PAYLOAD_TOO_LARGE) {
      return { code: "PAYLOAD_TOO_LARGE", message: "Request payload is too large" };
    }
    if (statusCode === HttpStatus.BAD_REQUEST) {
      return { code: "BAD_REQUEST", message: "Malformed request body" };
    }
    return {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    };
  }
  const response = exception.getResponse();
  if (typeof response === "string") {
    return { code: statusCodeToCode(statusCode), message: response };
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { code: statusCodeToCode(statusCode), message: exception.message };
  }
  const record = response as Record<string, unknown>;
  const sourceMessage = record.message;
  if (Array.isArray(sourceMessage)) {
    return {
      code: "VALIDATION_FAILED",
      details: sourceMessage,
      message: "Request validation failed",
    };
  }
  return {
    code: typeof record.code === "string" ? record.code : statusCodeToCode(statusCode),
    details: record.details,
    message: typeof sourceMessage === "string" ? sourceMessage : exception.message,
  };
}

function httpStatusCode(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  if (exception && typeof exception === "object") {
    const candidate = exception as { status?: unknown; statusCode?: unknown };
    const value = candidate.statusCode ?? candidate.status;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function statusCodeToCode(statusCode: number): string {
  const known: Readonly<Record<number, string>> = {
    [HttpStatus.BAD_REQUEST]: "BAD_REQUEST",
    [HttpStatus.CONFLICT]: "CONFLICT",
    [HttpStatus.FORBIDDEN]: "FORBIDDEN",
    [HttpStatus.NOT_FOUND]: "NOT_FOUND",
    [HttpStatus.PAYLOAD_TOO_LARGE]: "PAYLOAD_TOO_LARGE",
    [HttpStatus.TOO_MANY_REQUESTS]: "RATE_LIMITED",
    [HttpStatus.UNAUTHORIZED]: "UNAUTHORIZED",
  };
  return known[statusCode] ?? `HTTP_${statusCode}`;
}
