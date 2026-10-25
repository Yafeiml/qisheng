import { createInterface } from "node:readline";
import type { Collector } from "./collector";

const TOOLS = [
  {
    name: "collector_get_status",
    description: "Read safety status and remaining budget.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "collector_claim_job",
    description: "Claim one due server-issued verification job.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "collector_read_note",
    description: "Read only the already claimed job's note; returns a private evidence handle.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "collector_commit_evidence",
    description: "Upload collected evidence without accepting model-authored fields.",
    inputSchema: {
      type: "object",
      properties: { evidenceHandle: { type: "string" } },
      required: ["evidenceHandle"],
      additionalProperties: false,
    },
  },
  {
    name: "collector_pause",
    description: "Pause this collector until a human investigates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

export function startMcp(collector: Collector): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Set<Promise<void>>();
  const activeCalls = new Map<string, string>();
  input.on("line", (line) => {
    if (line.length > 16_384) return;
    const request = handleMcpLine(line, collector, activeCalls).finally(() =>
      pending.delete(request),
    );
    pending.add(request);
  });
  input.on("close", () => {
    void (async () => {
      if (collector.isReading() || [...activeCalls.values()].includes("collector_read_note")) {
        await collector.cancelRead();
      }
      await Promise.allSettled(pending);
      await collector.close();
      process.exit(0);
    })().catch(() => process.exit(1));
  });
}

export async function handleMcpLine(
  line: string,
  collector: Collector,
  activeCalls: Map<string, string>,
): Promise<void> {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    request = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const id = request.id;
  if (request.method === "notifications/cancelled") {
    const params = request.params as { requestId?: unknown } | undefined;
    const cancelledId = params?.requestId;
    if (typeof cancelledId === "string" || typeof cancelledId === "number") {
      if (activeCalls.get(`${typeof cancelledId}:${cancelledId}`) === "collector_read_note") {
        await collector.cancelRead().catch(() => undefined);
      }
    }
    return;
  }
  if (id === undefined || (typeof id !== "number" && typeof id !== "string")) return;
  const key = `${typeof id}:${id}`;
  const params = request.params as { name?: string } | undefined;
  if (request.method === "tools/call" && params?.name) activeCalls.set(key, params.name);
  try {
    let result: unknown;
    switch (request.method) {
      case "initialize": {
        const params = request.params as Record<string, unknown> | undefined;
        const protocolVersion = params?.protocolVersion;
        result = {
          protocolVersion: protocolVersion === "2024-11-05" ? protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "xhs-browser-collector", version: "0.1.0" },
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const params = request.params as
          | { name?: string; arguments?: Record<string, unknown> }
          | undefined;
        const args = params?.arguments ?? {};
        let output: object;
        switch (params?.name) {
          case "collector_get_status":
            output = await collector.status();
            break;
          case "collector_claim_job":
            output = await collector.claim();
            break;
          case "collector_read_note":
            if (typeof args.jobId !== "string") throw new Error("JOB_ID_REQUIRED");
            output = await collector.read(args.jobId);
            break;
          case "collector_commit_evidence":
            if (typeof args.evidenceHandle !== "string")
              throw new Error("EVIDENCE_HANDLE_REQUIRED");
            output = await collector.commit(args.evidenceHandle);
            break;
          case "collector_pause":
            output = await collector.pause();
            break;
          default:
            throw new Error("TOOL_UNKNOWN");
        }
        result = { content: [{ type: "text", text: JSON.stringify(output) }] };
        break;
      }
      default:
        respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "METHOD_UNKNOWN" } });
        return;
    }
    respond({ jsonrpc: "2.0", id, result });
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)
        ? error.message
        : "COLLECTOR_UNAVAILABLE";
    respond({ jsonrpc: "2.0", id, error: { code: -32000, message: code } });
  } finally {
    if (request.method === "tools/call") activeCalls.delete(key);
  }
}

function respond(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
