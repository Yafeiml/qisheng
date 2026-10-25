import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Scope,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";
import { catchError, from, map, mergeMap, of, throwError } from "rxjs";
import { type IdempotencyClaim, IdempotencyService } from "./idempotency.service";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_OPERATION } from "./idempotent.decorator";

type HttpRequest = Readonly<{
  body?: unknown;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  method: string;
  originalUrl?: string;
  params?: Readonly<Record<string, unknown>>;
  path?: string;
  query?: Readonly<Record<string, unknown>>;
  route?: Readonly<{ path?: string }>;
}>;

type HttpResponse = {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  statusCode: number;
};

@Injectable({ scope: Scope.REQUEST })
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_OPERATION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const claim = await this.idempotency.claim({
      body: request.body,
      key: singleHeader(request.headers[IDEMPOTENCY_KEY_HEADER]),
      method: request.method,
      params: request.params ?? {},
      path: request.route?.path ?? request.path ?? request.originalUrl ?? "",
      query: request.query ?? {},
    });

    if (claim.kind === "REPLAY") {
      response.status(claim.statusCode);
      response.setHeader("Idempotency-Replayed", "true");
      return of(claim.body);
    }

    response.setHeader("Idempotency-Replayed", "false");
    return next.handle().pipe(
      mergeMap((body) =>
        from(this.idempotency.complete(claim, response.statusCode, body)).pipe(map(() => body)),
      ),
      catchError((error: unknown) => releaseAndRethrow(this.idempotency, claim, error)),
    );
  }
}

function singleHeader(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function releaseAndRethrow(
  service: IdempotencyService,
  claim: Extract<IdempotencyClaim, { kind: "OWNED" }>,
  error: unknown,
): Observable<never> {
  return from(service.release(claim)).pipe(mergeMap(() => throwError(() => error)));
}
