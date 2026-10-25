import { describe, expect, it, vi } from "vitest";
import { fetchNoteDetail, normalizeNoteDetailEndpoint, parseNoteDetail } from "./note-detail";

const noteId = "6a91032d0000000004009c00";
const endpoint = "https://provider.example.org/custom/note?region=cn&noteId=old";
function payload(id = noteId, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    code: 0,
    msg: "成功",
    data: JSON.stringify({
      code: 0,
      success: true,
      data: [
        {
          model_type: "note",
          note_list: [
            {
              id,
              title: "测试标题",
              desc: "测试正文",
              user: { user_id: "account-42" },
              time: 1_750_000_000,
              liked_count: 0,
              collected_count: "18",
              comments_count: 3,
              images_list: [{ url: "https://example.invalid/secret.jpg" }],
              ...overrides,
            },
          ],
        },
      ],
    }),
  });
}

describe("configurable note detail contract", () => {
  it("supports a custom HTTPS endpoint with the double-envelope response and token authorization", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(payload(), { status: 200 }));
    const result = await fetchNoteDetail({
      endpoint: "https://api.example.com/notes/detail",
      token: "offline-provider-token",
      noteId,
      fetch: fetcher,
    });
    expect(result.status).toBe("AVAILABLE");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://api.example.com/notes/detail?noteId=${noteId}`);
    expect(request?.method).toBe("GET");
    expect(new Headers(request?.headers).get("Authorization")).toBe("Token offline-provider-token");
  });

  it("decodes the documented double envelope and preserves exact zeros", () => {
    expect(parseNoteDetail(200, payload(), noteId)).toEqual({
      status: "AVAILABLE",
      note: {
        noteId,
        title: "测试标题",
        body: "测试正文",
        authorId: "account-42",
        publishedAt: new Date(1_750_000_000_000),
        imageCount: 1,
        hashtags: [],
        likes: 0,
        comments: 3,
        favorites: 18,
      },
    });
  });

  it("never accepts the wrong note and never treats missing totals as zero", () => {
    expect(parseNoteDetail(200, payload("unrelated"), noteId)).toEqual({
      status: "UNCONFIRMED",
      code: "NOTE_ID_NOT_UNIQUE",
    });
    const result = parseNoteDetail(
      200,
      payload(noteId, { liked_count: "1万", comments_count: null, collected_count: -1 }),
      noteId,
    );
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect([result.note.likes, result.note.comments, result.note.favorites]).toEqual([
        null,
        null,
        null,
      ]);
    }
  });

  it.each([
    [200, JSON.stringify({ code: 100501 }), "RETRYABLE"],
    [200, JSON.stringify({ code: 100401 }), "AUTH_ERROR"],
    [200, JSON.stringify({ code: 100400 }), "INVALID_REQUEST"],
    [200, JSON.stringify({ code: 101222 }), "UNCONFIRMED"],
    [429, "", "RETRYABLE"],
    [200, "{", "PARSER_CHANGED"],
    [200, JSON.stringify({ code: 0, data: "garbage" }), "PARSER_CHANGED"],
  ])("classifies vendor errors without judging a submission (%i)", (http, body, status) => {
    expect(parseNoteDetail(http, body, noteId).status).toBe(status);
  });

  it("uses the entered endpoint, preserves its query, and sends one authenticated request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(payload(), { status: 200 }));
    const result = await fetchNoteDetail({
      endpoint,
      token: "Token sample-secret",
      noteId,
      fetch: fetcher,
    });
    expect(result.status).toBe("AVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://provider.example.org/custom/note?region=cn&noteId=${noteId}`);
    expect(new Headers(request?.headers).get("Authorization")).toBe("Token sample-secret");
    expect(request?.redirect).toBe("error");
    expect(
      await fetchNoteDetail({
        endpoint,
        token: "sample-secret",
        noteId: "bad!",
        fetch: fetcher,
      }),
    ).toEqual({ status: "INVALID_REQUEST", code: "INVALID_NOTE_ID" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts the neutral JSON contract and preserves unknown metrics", () => {
    expect(
      parseNoteDetail(
        200,
        JSON.stringify({
          noteId,
          title: "实拍分享",
          body: "今天的记录",
          authorId: "account-7",
          publishedAt: "2026-10-15T06:00:00Z",
          imageCount: 3,
          hashtags: ["日常", "实拍"],
          likes: 0,
        }),
        noteId,
      ),
    ).toEqual({
      status: "AVAILABLE",
      note: {
        noteId,
        title: "实拍分享",
        body: "今天的记录",
        authorId: "account-7",
        publishedAt: new Date("2026-10-15T06:00:00Z"),
        imageCount: 3,
        hashtags: ["日常", "实拍"],
        likes: 0,
        comments: null,
        favorites: null,
      },
    });
    expect(
      parseNoteDetail(200, JSON.stringify({ noteId: "wrong-note", title: "", body: "" }), noteId),
    ).toEqual({ status: "UNCONFIRMED", code: "NOTE_ID_MISMATCH" });
    expect(parseNoteDetail(200, JSON.stringify({ noteId, title: "" }), noteId)).toEqual({
      status: "PARSER_CHANGED",
      code: "INVALID_CONTENT",
    });
  });

  it.each([
    { authorId: "abc" },
    { authorId: "bad author" },
    { authorId: "a".repeat(101) },
    { authorId: 42 },
    { imageCount: 41 },
    { imageCount: -1 },
    { imageCount: 1.5 },
    { imageCount: null },
    { imageCount: "unknown" },
  ])("rejects metadata that cannot be committed to the main API (%j)", (metadata) => {
    expect(
      parseNoteDetail(
        200,
        JSON.stringify({ noteId, title: "标题", body: "正文", ...metadata }),
        noteId,
      ),
    ).toEqual({ status: "PARSER_CHANGED", code: "INVALID_NOTE_METADATA" });
  });

  it.each([
    { user: { user_id: "abc" } },
    { user: { user_id: "bad author" } },
    { user: { user_id: "a".repeat(101) } },
    { user: { user_id: 42 } },
    { images_list: Array.from({ length: 41 }, () => ({})) },
    { images_list: "unknown" },
  ])("also rejects invalid legacy metadata (%j)", (metadata) => {
    expect(parseNoteDetail(200, payload(noteId, metadata), noteId)).toEqual({
      status: "PARSER_CHANGED",
      code: "INVALID_NOTE_METADATA",
    });
  });

  it("accepts metadata limits without clamping and omits extended-year dates", () => {
    const result = parseNoteDetail(
      200,
      JSON.stringify({
        noteId,
        title: "标题",
        body: "正文",
        authorId: "a".repeat(100),
        imageCount: 40,
        publishedAt: Date.UTC(10000, 0, 1),
      }),
      noteId,
    );
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.note.authorId).toBe("a".repeat(100));
      expect(result.note.imageCount).toBe(40);
      expect(result.note.publishedAt).toBeNull();
    }
    const legacy = parseNoteDetail(200, payload(noteId, { time: Date.UTC(10000, 0, 1) }), noteId);
    expect(legacy.status).toBe("AVAILABLE");
    if (legacy.status === "AVAILABLE") expect(legacy.note.publishedAt).toBeNull();
  });

  it.each([
    ["sample-secret", "Token sample-secret"],
    ["Token sample-secret", "Token sample-secret"],
    ["bearer sample-secret", "Bearer sample-secret"],
  ])("supports explicit and legacy authorization (%s)", async (token, expected) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(payload(), { status: 200 }));
    await fetchNoteDetail({ endpoint, token, noteId, fetch: fetcher });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(expected);
  });

  it.each(["", "Token", "Bearer", "Bearer bad secret", "secret\r\nX-Injected: value"])(
    "rejects invalid credentials without sending a request",
    async (token) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(fetchNoteDetail({ endpoint, token, noteId, fetch: fetcher })).rejects.toThrow(
        "PROVIDER_TOKEN_INVALID",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "http://provider.example.org/note",
    "https://user:password@provider.example.org/note",
    "https://@provider.example.org/note",
    "https://provider.example.org/note#fragment",
    "https://provider.example.org/note#",
    "https://local\nhost/note",
    "https://localhost/note",
    "https://service.internal/note",
    "https://127.0.0.1/note",
    "https://10.0.0.2/note",
    "https://[::1]/note",
    "https://[::ffff:127.0.0.1]/note",
    "https://2130706433/note",
  ])("rejects unsafe endpoints (%s)", async (unsafeEndpoint) => {
    expect(() => normalizeNoteDetailEndpoint(unsafeEndpoint)).toThrow("PROVIDER_ENDPOINT_INVALID");
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      fetchNoteDetail({ endpoint: unsafeEndpoint, token: "sample-secret", noteId, fetch: fetcher }),
    ).rejects.toThrow("PROVIDER_ENDPOINT_INVALID");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "token",
    "access_token",
    "Access-Token",
    "auth_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "API-KEY",
    "auth",
    "authorization",
    "client_secret",
    "access_key",
    "secret_key",
    "secret",
    "password",
    "signature",
    "credential",
    "credentials",
    "session_id",
    "key",
    "%74oken",
  ])("rejects a credential-bearing query key %s before sending a request", async (key) => {
    const endpoint = `https://provider.example.org/note?region=cn&${key}=fixture-query-credential`;
    const fetcher = vi.fn<typeof fetch>();
    expect(() => normalizeNoteDetailEndpoint(endpoint)).toThrow("PROVIDER_ENDPOINT_INVALID");
    await expect(
      fetchNoteDetail({ endpoint, token: "sample-secret", noteId, fetch: fetcher }),
    ).rejects.toThrow("PROVIDER_ENDPOINT_INVALID");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves non-sensitive region and noteId query parameters", () => {
    expect(normalizeNoteDetailEndpoint(endpoint)).toBe(endpoint);
  });

  it("limits both announced and streamed response sizes", async () => {
    const announce = vi.fn<typeof fetch>(
      async () =>
        new Response(payload(), { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    );
    const stream = vi.fn<typeof fetch>(async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)));
    for (const fetcher of [announce, stream]) {
      expect(
        await fetchNoteDetail({ endpoint, token: "sample-secret", noteId, fetch: fetcher }),
      ).toEqual({
        status: "PARSER_CHANGED",
        code: "RESPONSE_TOO_LARGE",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
});
