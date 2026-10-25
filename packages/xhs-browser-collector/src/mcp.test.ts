import { describe, expect, it, vi } from "vitest";
import type { Collector } from "./collector";
import { handleMcpLine } from "./mcp";

describe("MCP cancellation targets", () => {
  it("does not pause navigation for a cancelled status request", async () => {
    const paused = vi.fn(async () => undefined);
    let completeStatus: ((value: object) => void) | undefined;
    const collector = {
      status: () =>
        new Promise<object>((resolve) => {
          completeStatus = resolve;
        }),
      cancelRead: paused,
    } as unknown as Collector;
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const active = new Map<string, string>();
      const request = handleMcpLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "collector_get_status", arguments: {} },
        }),
        collector,
        active,
      );
      await handleMcpLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 4 },
        }),
        collector,
        active,
      );
      expect(paused).not.toHaveBeenCalled();
      completeStatus?.({ serverOnline: false });
      await request;
    } finally {
      writes.mockRestore();
    }
  });

  it("halts a cancelled read request before another navigation", async () => {
    const cancelled = vi.fn(async () => undefined);
    let completeRead: ((value: object) => void) | undefined;
    const collector = {
      read: () =>
        new Promise<object>((resolve) => {
          completeRead = resolve;
        }),
      cancelRead: cancelled,
    } as unknown as Collector;
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const active = new Map<string, string>();
      const request = handleMcpLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "collector_read_note", arguments: { jobId: "test-job" } },
        }),
        collector,
        active,
      );
      await handleMcpLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 5 },
        }),
        collector,
        active,
      );
      expect(cancelled).toHaveBeenCalledTimes(1);
      completeRead?.({ status: "CANCELLED" });
      await request;
    } finally {
      writes.mockRestore();
    }
  });
});
