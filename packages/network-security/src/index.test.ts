import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPrivateAddress,
  normalizePublicHttpUrl,
  PublicHttpPolicyError,
  resolvePublicHttpUrl,
  withPublicHttpResponse,
} from "./index";

describe("public HTTP network policy", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("rejects unsafe schemes, credentials and private literals", () => {
    expect(() => normalizePublicHttpUrl("http://example.com")).toThrow(PublicHttpPolicyError);
    expect(() => normalizePublicHttpUrl("https://user:secret@example.com")).toThrow(
      PublicHttpPolicyError,
    );
    expect(() => normalizePublicHttpUrl("https://127.0.0.1/path")).toThrow(PublicHttpPolicyError);
  });

  it("classifies private, reserved and documentation addresses", () => {
    for (const address of [
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "198.51.100.10",
      "203.0.113.10",
      "::1",
      "fd00::1",
      "2001:db8::1",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("classifies mapped IPv4 addresses after IPv6 URL normalization", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:100.64.0.1",
      "::ffff:169.254.169.254",
      "::ffff:172.31.255.255",
      "::ffff:192.168.1.1",
      "::ffff:203.0.113.10",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
      expect(() => normalizePublicHttpUrl(`https://[${address}]/`), address).toThrow(
        PublicHttpPolicyError,
      );
    }
    for (const address of ["::ffff:1.1.1.1", "::ffff:101:101", "0:0:0:0:0:ffff:808:808"]) {
      expect(isPrivateAddress(address), address).toBe(false);
      expect(() => normalizePublicHttpUrl(`https://[${address}]/`), address).not.toThrow();
    }
  });

  it("normalizes IPv6 private boundaries without rejecting adjacent public ranges", () => {
    for (const address of [
      "0:0:0:0:0:0:0:0",
      "0:0:0:0:0:0:0:1",
      "FE80:0:0:0:0:0:0:1",
      "febf::1",
      "fc00::1",
      "fdff::1",
      "ff00::1",
      "2001:0db8:0:0:0:0:0:1",
      "not:an:address",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["fe7f::1", "fec0::1", "2001:db7::1", "2001:db9::1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("rejects a mapped private DNS answer while accepting mapped public addresses", async () => {
    await expect(
      resolvePublicHttpUrl("https://provider.example/v1", {
        lookup: async () => [{ address: "::ffff:7f00:1", family: 6 }],
      }),
    ).rejects.toMatchObject({ code: "PUBLIC_HTTP_DNS_PRIVATE" });
    await expect(
      resolvePublicHttpUrl("https://provider.example/v1", {
        lookup: async () => [{ address: "::ffff:101:101", family: 6 }],
      }),
    ).resolves.toMatchObject({ address: "::ffff:101:101", family: 6 });
    expect(() =>
      normalizePublicHttpUrl("https://[::ffff:7f00:1]/", { allowPrivate: true }),
    ).not.toThrow();
  });

  it("rejects DNS answers when any address is private", async () => {
    await expect(
      resolvePublicHttpUrl("https://provider.example/v1", {
        lookup: async () => [
          { address: "1.1.1.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: "PUBLIC_HTTP_DNS_PRIVATE" });
  });

  it("retries a failed DNS lookup before using validated public addresses", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce({ code: "ENOTFOUND" })
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    await expect(
      resolvePublicHttpUrl("https://provider.example/v1", { lookup }),
    ).resolves.toMatchObject({ address: "1.1.1.1" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("does not bypass private-address rejection after a DNS retry", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce({ code: "EAI_AGAIN" })
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      resolvePublicHttpUrl("https://provider.example/v1", { lookup }),
    ).rejects.toMatchObject({ code: "PUBLIC_HTTP_DNS_PRIVATE" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("bounds DNS retries and does not retry other resolver errors", async () => {
    const lookup = vi.fn().mockRejectedValue({ code: "ENOTFOUND" });
    await expect(
      resolvePublicHttpUrl("https://provider.example/v1", { lookup }),
    ).rejects.toMatchObject({ code: "PUBLIC_HTTP_DNS_FAILED" });
    expect(lookup).toHaveBeenCalledTimes(3);
    lookup.mockReset().mockRejectedValue({ code: "INVALID_ARGUMENT" });
    await expect(
      resolvePublicHttpUrl("https://provider.example/v1", { lookup }),
    ).rejects.toMatchObject({ code: "PUBLIC_HTTP_DNS_FAILED" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("prefers IPv4 while retaining validated addresses for Undici fallback", async () => {
    const resolved = await resolvePublicHttpUrl("https://provider.example/v1", {
      allowPrivate: true,
      lookup: async () => [
        { address: "fd00::25", family: 6 },
        { address: "198.18.1.25", family: 4 },
        { address: "198.18.1.25", family: 4 },
      ],
    });

    expect(resolved).toMatchObject({ address: "198.18.1.25", family: 4 });
    expect(resolved.addresses).toEqual([
      { address: "198.18.1.25", family: 4 },
      { address: "fd00::25", family: 6 },
    ]);
  });

  it("supports Undici all-address lookup and reaches an IPv4 fallback", async () => {
    server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(
      withPublicHttpResponse(
        `http://provider.example:${port}/health`,
        { method: "GET" },
        {
          allowHttp: true,
          allowPrivate: true,
          lookup: async () => [
            { address: "::1", family: 6 },
            { address: "127.0.0.1", family: 4 },
          ],
        },
        async (response) => response.text(),
      ),
    ).resolves.toBe("ok");
  });

  it("pins a resolved address and rejects redirects by default", async () => {
    server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/ok" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await expect(
      withPublicHttpResponse(
        `http://127.0.0.1:${port}/redirect`,
        { method: "GET" },
        { allowHttp: true, allowPrivate: true },
        async (response) => response.text(),
      ),
    ).rejects.toMatchObject({ code: "PUBLIC_HTTP_REDIRECT_FORBIDDEN" });
  });

  it("revalidates an explicitly allowed GET redirect", async () => {
    server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/ok" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const result = await withPublicHttpResponse(
      `http://127.0.0.1:${port}/redirect`,
      { method: "GET" },
      { allowHttp: true, allowPrivate: true, maxRedirects: 1 },
      async (response, finalUrl, redirectCount) => ({
        body: await response.text(),
        finalUrl: finalUrl.toString(),
        redirectCount,
      }),
    );
    expect(result).toEqual({
      body: "ok",
      finalUrl: `http://127.0.0.1:${port}/ok`,
      redirectCount: 1,
    });
  });

  it("checks the caller URL policy before DNS and every redirect request", async () => {
    const seen: string[] = [];
    const lookup = vi.fn().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    server = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(302, { location: "http://outside.example/not-a-note" }).end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const validateUrl = vi.fn((url: URL) => {
      if (url.hostname !== "provider.example") throw new Error("TARGET_REJECTED");
    });
    const stopAtRedirect = vi.fn(() => true);
    const options = {
      allowHttp: true,
      allowPrivate: true,
      lookup,
      maxRedirects: 1,
      validateUrl,
      stopAtRedirect,
    };
    await expect(
      withPublicHttpResponse("http://outside.example/not-a-note", {}, options, async () => "ok"),
    ).rejects.toThrow("TARGET_REJECTED");
    expect(lookup).not.toHaveBeenCalled();
    await expect(
      withPublicHttpResponse(
        `http://provider.example:${port}/redirect`,
        {},
        options,
        async () => "ok",
      ),
    ).rejects.toThrow("TARGET_REJECTED");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(validateUrl).toHaveBeenCalledTimes(3);
    expect(stopAtRedirect).not.toHaveBeenCalled();
    expect(seen).toEqual(["/redirect"]);
  });

  it("can stop at a validated redirect target without requesting that target", async () => {
    const seen: string[] = [];
    const lookup = vi.fn().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    server = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(302, { location: "https://provider.example/note" }).end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const validateUrl = vi.fn((url: URL) => {
      if (url.hostname !== "provider.example") throw new Error("TARGET_REJECTED");
    });
    const result = await withPublicHttpResponse(
      `http://provider.example:${port}/redirect`,
      {},
      {
        allowHttp: true,
        allowPrivate: true,
        lookup,
        maxRedirects: 1,
        validateUrl,
        stopAtRedirect: () => true,
      },
      async (response, finalUrl, redirects) => ({
        status: response.status,
        finalUrl: finalUrl.toString(),
        redirects,
      }),
    );
    expect(result).toEqual({
      status: 302,
      finalUrl: "https://provider.example/note",
      redirects: 1,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(validateUrl).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["/redirect"]);
  });
});
