import { proxyApiRequest } from "../../lib/api-gateway";

export const runtime = "nodejs";

export const GET = proxyApiRequest;
export const HEAD = proxyApiRequest;
export const POST = proxyApiRequest;
export const PUT = proxyApiRequest;
export const PATCH = proxyApiRequest;
export const DELETE = proxyApiRequest;

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { Allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" },
  });
}
