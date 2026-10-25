import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignedReadbackApi } from "./job-api";
import { readManagedNodeKey, runManagedOnce } from "./runner";

const key = "d".repeat(64);
const provider = { endpoint: "https://provider.example.org/note", token: "supplier-only-token" };
const job = () => ({
  id: "testjob123",
  noteId: "abc123xyz",
  leaseToken: "754db0e9-29d2-4ccc-9f95-756b13098de5",
  dueAt: new Date(Date.now() - 1000).toISOString(),
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
});

afterEach(() => vi.unstubAllEnvs());

describe("managed colocated readback", () => {
  it("uses signed task credentials once and retries only the result acknowledgement", async () => {
    const sent: { path: string; body: string; nonce: string | null }[] = [];
    let resultAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, input) => {
      const path = new URL(String(url)).pathname;
      const headers = new Headers(input?.headers);
      const body = typeof input?.body === "string" ? input.body : "";
      expect(headers.get("x-collector-id")).toBe("selfhost-readback");
      expect(headers.get("x-collector-signature")).toBe(
        createHmac("sha256", key)
          .update(
            [
              input?.method,
              path,
              headers.get("x-collector-timestamp"),
              headers.get("x-collector-request-id"),
              createHash("sha256").update(body).digest("hex"),
            ].join("\n"),
          )
          .digest("hex"),
      );
      sent.push({ path, body, nonce: headers.get("x-collector-request-id") });
      if (path.endsWith("/claim-managed"))
        return new Response(JSON.stringify({ paused: false, reason: null, job: job(), provider }));
      if (++resultAttempts === 1) throw new TypeError("lost result acknowledgement");
      return new Response(JSON.stringify({ status: "COMPLETED" }));
    });
    const api = new SignedReadbackApi("http://api:3100", "selfhost-readback", key, fetcher);
    const vendor = vi.fn(async () => ({ status: "RETRYABLE" as const, code: "VENDOR_TRANSIENT" }));
    expect(await runManagedOnce(api, vendor)).toBe("COMMITTED");
    expect(vendor).toHaveBeenCalledExactlyOnceWith({ ...provider, noteId: "abc123xyz" });
    expect(resultAttempts).toBe(2);
    expect(new Set(sent.map(({ nonce }) => nonce)).size).toBe(3);
    expect(JSON.stringify(sent)).not.toContain(provider.token);
  });

  it.each([
    { paused: true, reason: "READBACK_DISABLED", expected: "PAUSED" },
    { paused: false, reason: null, expected: "IDLE" },
  ])("does not call the supplier for $expected", async ({ paused, reason, expected }) => {
    const api = new SignedReadbackApi(
      "http://api:3100",
      "selfhost-readback",
      key,
      async () => new Response(JSON.stringify({ paused, reason, job: null, provider: null })),
    );
    const vendor = vi.fn();
    expect(await runManagedOnce(api, vendor)).toBe(expected);
    expect(vendor).not.toHaveBeenCalled();
  });

  it.each([
    { paused: true, reason: "READBACK_DISABLED", job: job(), provider },
    { paused: false, reason: null, job: null, provider },
    { paused: false, reason: null, job: job(), provider: null },
    { paused: false, reason: null, job: job(), provider: { ...provider, token: "" } },
    {
      paused: false,
      reason: null,
      job: job(),
      provider: { ...provider, endpoint: "https://127.0.0.1/note" },
    },
    {
      paused: false,
      reason: null,
      job: job(),
      provider: { ...provider, token: "secret\r\nInjected: value" },
    },
  ])("rejects malformed or unsafe managed claims before a paid call", async (response) => {
    const api = new SignedReadbackApi(
      "http://api:3100",
      "selfhost-readback",
      key,
      async () => new Response(JSON.stringify(response)),
    );
    const vendor = vi.fn();
    await expect(runManagedOnce(api, vendor)).rejects.toThrow();
    expect(vendor).not.toHaveBeenCalled();
  });

  it("never requests central supplier credentials under an external node identity", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = new SignedReadbackApi("http://api:3100", "external-node", key, fetcher);
    await expect(api.managedClaim()).rejects.toThrow("MANAGED_NODE_ID_INVALID");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads only an explicit regular key file and refuses malformed keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "qisheng-readback-managed-"));
    try {
      const file = join(directory, "node-key");
      writeFileSync(file, key, { mode: 0o600 });
      vi.stubEnv("PUBLICATION_READBACK_NODE_KEY_FILE", file);
      expect(readManagedNodeKey()).toBe(key);
      writeFileSync(file, "short");
      expect(() => readManagedNodeKey()).toThrow("MANAGED_NODE_KEY_INVALID");
      expect(() => readManagedNodeKey(directory)).toThrow("MANAGED_NODE_KEY_FILE_INVALID");
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(directory).toContain("qisheng-readback-managed-");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
