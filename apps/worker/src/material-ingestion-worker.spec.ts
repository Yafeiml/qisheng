import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertPublicHttpUrl, chunkText, fetchPublicSnapshot } from "./material-ingestion-worker";

describe("material ingestion security and chunking", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPrivateFlag = process.env.MATERIAL_FETCH_ALLOW_PRIVATE_TEST_URLS;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    process.env.NODE_ENV = previousNodeEnv;
    if (previousPrivateFlag === undefined) {
      delete process.env.MATERIAL_FETCH_ALLOW_PRIVATE_TEST_URLS;
    } else {
      process.env.MATERIAL_FETCH_ALLOW_PRIVATE_TEST_URLS = previousPrivateFlag;
    }
  });

  it("creates stable overlapping chunks without dropping the tail", () => {
    const text = `${"设备与规范评估。".repeat(80)}\n\n${"术后体验存在个体差异。".repeat(60)}`;
    const first = chunkText(text, 240, 40);
    const second = chunkText(text, 240, 40);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(3);
    expect(first[0]?.ordinal).toBe(0);
    expect(first.at(-1)?.end).toBe([...text].length);
    expect(first.every(({ text }) => text.length > 0 && text.length <= 240)).toBe(true);
    expect(
      first.slice(1).every((chunk, index) => {
        const previous = first[index];
        return Boolean(previous && chunk.start < previous.end);
      }),
    ).toBe(true);
  });

  it("blocks loopback, private and metadata endpoints by default", async () => {
    process.env.NODE_ENV = "production";
    await expect(assertPublicHttpUrl(new URL("https://127.0.0.1:8080/a"))).rejects.toMatchObject({
      code: "LINK_URL_PRIVATE",
    });
    await expect(assertPublicHttpUrl(new URL("https://10.0.0.2/a"))).rejects.toMatchObject({
      code: "LINK_URL_PRIVATE",
    });
    await expect(
      assertPublicHttpUrl(new URL("https://169.254.169.254/latest/meta-data")),
    ).rejects.toMatchObject({ code: "LINK_URL_PRIVATE" });
    await expect(
      assertPublicHttpUrl(new URL("https://metadata.google.internal/a")),
    ).rejects.toMatchObject({ code: "LINK_URL_PRIVATE" });
  });

  it("requires HTTPS for public production links", async () => {
    process.env.NODE_ENV = "production";
    await expect(assertPublicHttpUrl(new URL("http://example.com/article"))).rejects.toMatchObject({
      code: "LINK_URL_UNSAFE",
    });
  });

  it("allows private HTTP fixtures only behind the explicit test-only switch", async () => {
    process.env.NODE_ENV = "test";
    process.env.MATERIAL_FETCH_ALLOW_PRIVATE_TEST_URLS = "true";
    await expect(
      assertPublicHttpUrl(new URL("http://127.0.0.1:8080/fixture")),
    ).resolves.toMatchObject({
      address: "127.0.0.1",
    });
    process.env.NODE_ENV = "development";
    await expect(
      assertPublicHttpUrl(new URL("http://127.0.0.1:8080/fixture")),
    ).rejects.toMatchObject({
      code: "LINK_URL_PRIVATE",
    });
  });

  it("revalidates redirects and reports the final public-link snapshot", async () => {
    process.env.NODE_ENV = "test";
    process.env.MATERIAL_FETCH_ALLOW_PRIVATE_TEST_URLS = "true";
    server = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/article" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("verified article");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const snapshot = await fetchPublicSnapshot(`http://127.0.0.1:${port}/start`);

    expect(new TextDecoder().decode(snapshot.bytes)).toBe("verified article");
    expect(snapshot.finalUrl).toBe(`http://127.0.0.1:${port}/article`);
    expect(snapshot.redirects).toBe(1);
  });

  it("stops reading a chunked response as soon as the byte limit is exceeded", async () => {
    process.env.NODE_ENV = "test";
    process.env.MATERIAL_FETCH_ALLOW_PRIVATE_TEST_URLS = "true";
    server = createServer((_, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "transfer-encoding": "chunked",
      });
      response.write("12345678");
      response.end("9");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    await expect(fetchPublicSnapshot(`http://127.0.0.1:${port}/article`, 8)).rejects.toMatchObject({
      code: "LINK_RESPONSE_TOO_LARGE",
    });
  });
});
