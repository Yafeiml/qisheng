import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
  Scope,
} from "@nestjs/common";
import { writeStructuredLog } from "@xhs-agentic/observability";
import type { Observable } from "rxjs";
import { tap } from "rxjs";
import { RequestAccessContext } from "../access/request-access-context";
import type { RequestWithId } from "./request-id";

type LoggedHttpRequest = RequestWithId &
  Readonly<{
    method?: string;
    params?: Readonly<Record<string, string | undefined>>;
    route?: Readonly<{ path?: string }>;
  }>;

type LoggedHttpResponse = Readonly<{
  getHeader(name: string): number | string | string[] | undefined;
  statusCode: number;
}>;

@Injectable({ scope: Scope.REQUEST })
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(@Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<LoggedHttpRequest>();
    const response = http.getResponse<LoggedHttpResponse>();
    const startedAt = performance.now();

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          this.writeCompleted(request, response, startedAt, httpStatus(error));
        },
        next: () => {
          this.writeCompleted(request, response, startedAt, response.statusCode);
        },
      }),
    );
  }

  private writeCompleted(
    request: LoggedHttpRequest,
    response: LoggedHttpResponse,
    startedAt: number,
    statusCode: number,
  ): void {
    const principal = this.accessContext.currentPrincipal();
    const scope = principal?.audience === "SAAS_ADMIN" ? principal.scope : undefined;
    const params = request.params ?? {};
    writeStructuredLog({
      event: "http.request.completed",
      fields: {
        actorAudience: principal?.audience,
        actorUserId: principal?.userId,
        durationMs: Math.round(performance.now() - startedAt),
        enterpriseId: scope?.type === "ENTERPRISE" ? scope.enterpriseId : params.enterpriseId,
        method: request.method ?? "UNKNOWN",
        path: safePath(request.originalUrl ?? request.url ?? ""),
        responseBytes: response.getHeader("content-length"),
        route: request.route?.path,
        statusCode,
        tenantId:
          scope?.type === "PLATFORM" ? params.tenantId : (scope?.tenantId ?? params.tenantId),
      },
      level: statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
      service: "api",
    });
  }
}

function httpStatus(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 500;
}

function safePath(value: string): string {
  return value.split("?", 1)[0]?.slice(0, 500) ?? "";
}
