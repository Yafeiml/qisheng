import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runWithLogContext } from "@xhs-agentic/observability";

export const REQUEST_ID_HEADER = "x-request-id";

export type RequestWithId = IncomingMessage &
  Readonly<{
    originalUrl?: string;
    requestId?: string;
  }>;

export function requestIdMiddleware(
  request: RequestWithId,
  response: ServerResponse,
  next: () => void,
): void {
  const supplied = request.headers[REQUEST_ID_HEADER];
  const requestId =
    typeof supplied === "string" && /^[A-Za-z0-9._:-]{8,100}$/u.test(supplied)
      ? supplied
      : randomUUID();
  Object.assign(request, { requestId });
  response.setHeader(REQUEST_ID_HEADER, requestId);
  runWithLogContext({ requestId }, next);
}
