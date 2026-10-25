import { normalizePublicHttpUrl, withPublicHttpResponse } from "@xhs-agentic/network-security";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export type NoteDetail = Readonly<{
  noteId: string;
  title: string;
  body: string;
  authorId: string | null;
  publishedAt: Date | null;
  imageCount: number;
  hashtags: readonly string[];
  likes: number | null;
  comments: number | null;
  favorites: number | null;
}>;

export type NoteDetailResult =
  | Readonly<{ status: "AVAILABLE"; note: NoteDetail }>
  | Readonly<{
      status: "RETRYABLE" | "AUTH_ERROR" | "INVALID_REQUEST" | "UNCONFIRMED" | "PARSER_CHANGED";
      code: string;
    }>;

/** Unknown provider states never reject an employee submission. */
export function parseNoteDetail(
  httpStatus: number,
  raw: string,
  expectedNoteId: string,
): NoteDetailResult {
  if (httpStatus === 401 || httpStatus === 403) return { status: "AUTH_ERROR", code: "HTTP_AUTH" };
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500)
    return { status: "RETRYABLE", code: "HTTP_TRANSIENT" };
  if (httpStatus !== 200) return { status: "UNCONFIRMED", code: "HTTP_UNEXPECTED" };
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(raw);
  } catch {
    return { status: "PARSER_CHANGED", code: "INVALID_JSON" };
  }
  if (record(wrapper) && "noteId" in wrapper) {
    if (
      typeof wrapper.noteId !== "string" ||
      wrapper.noteId.toLowerCase() !== expectedNoteId.toLowerCase()
    )
      return { status: "UNCONFIRMED", code: "NOTE_ID_MISMATCH" };
    if (typeof wrapper.title !== "string" || typeof wrapper.body !== "string")
      return { status: "PARSER_CHANGED", code: "INVALID_CONTENT" };
    const metadata = noteMetadata(wrapper.authorId, wrapper.imageCount);
    if (!metadata) return { status: "PARSER_CHANGED", code: "INVALID_NOTE_METADATA" };
    return {
      status: "AVAILABLE",
      note: {
        noteId: expectedNoteId,
        title: wrapper.title.slice(0, 500),
        body: wrapper.body.slice(0, 20_000),
        authorId: metadata.authorId,
        publishedAt:
          typeof wrapper.publishedAt === "string"
            ? isoTimestamp(wrapper.publishedAt)
            : timestamp(wrapper.publishedAt),
        imageCount: metadata.imageCount,
        hashtags: Array.isArray(wrapper.hashtags)
          ? wrapper.hashtags
              .filter((tag): tag is string => typeof tag === "string")
              .slice(0, 100)
              .map((tag) => tag.slice(0, 80))
          : [],
        likes: count(wrapper.likes),
        comments: count(wrapper.comments),
        favorites: count(wrapper.favorites),
      },
    };
  }
  if (!record(wrapper) || !Number.isInteger(wrapper.code))
    return { status: "PARSER_CHANGED", code: "INVALID_WRAPPER" };
  switch (wrapper.code) {
    case 100400:
    case 101005:
      return { status: "INVALID_REQUEST", code: "VENDOR_BAD_REQUEST" };
    case 100401:
      return { status: "AUTH_ERROR", code: "VENDOR_AUTH" };
    case 100500:
    case 100501:
    case 100504:
      return { status: "RETRYABLE", code: "VENDOR_TRANSIENT" };
    case 0:
      break;
    default:
      return { status: "UNCONFIRMED", code: "VENDOR_UNKNOWN" };
  }
  // Preserve compatibility with the original double-encoded provider response.
  if (typeof wrapper.data !== "string" || wrapper.data.length > MAX_RESPONSE_BYTES)
    return { status: "PARSER_CHANGED", code: "INVALID_DATA" };
  let inner: unknown;
  try {
    inner = JSON.parse(wrapper.data);
  } catch {
    return { status: "PARSER_CHANGED", code: "INVALID_DATA" };
  }
  if (!record(inner) || inner.code !== 0 || inner.success !== true || !Array.isArray(inner.data))
    return { status: "UNCONFIRMED", code: "INNER_NOT_SUCCESS" };
  const entries = inner.data.flatMap((group) =>
    record(group) && group.model_type === "note" && Array.isArray(group.note_list)
      ? group.note_list
      : [],
  );
  const matches = entries.filter(
    (entry) =>
      record(entry) &&
      typeof entry.id === "string" &&
      entry.id.toLowerCase() === expectedNoteId.toLowerCase(),
  );
  if (matches.length !== 1) return { status: "UNCONFIRMED", code: "NOTE_ID_NOT_UNIQUE" };
  const note = matches[0];
  if (!record(note)) return { status: "PARSER_CHANGED", code: "INVALID_NOTE" };
  if (typeof note.title !== "string" || typeof note.desc !== "string")
    return { status: "PARSER_CHANGED", code: "INVALID_CONTENT" };
  const author = record(note.user) ? note.user : null;
  const metadata = noteMetadata(
    author?.user_id ?? author?.userid,
    Array.isArray(note.images_list)
      ? note.images_list.length
      : note.images_list == null
        ? undefined
        : Number.NaN,
  );
  if (!metadata) return { status: "PARSER_CHANGED", code: "INVALID_NOTE_METADATA" };
  return {
    status: "AVAILABLE",
    note: {
      noteId: expectedNoteId,
      title: note.title.slice(0, 500),
      body: note.desc.slice(0, 20_000),
      authorId: metadata.authorId,
      publishedAt: timestamp(note.time),
      imageCount: metadata.imageCount,
      hashtags: Array.isArray(note.hash_tag)
        ? note.hash_tag
            .filter((tag): tag is Record<string, unknown> => record(tag))
            .map((tag) => tag.name)
            .filter((name): name is string => typeof name === "string")
            .slice(0, 100)
            .map((name) => name.slice(0, 80))
        : [],
      likes: count(note.liked_count),
      comments: count(note.comments_count),
      favorites: count(note.collected_count),
    },
  };
}

export function normalizeNoteDetailEndpoint(endpoint: string): string {
  if (
    typeof endpoint !== "string" ||
    !endpoint.trim() ||
    endpoint.length > 8192 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: URL parsing silently strips controls.
    /[\u0000-\u001f\u007f#]/u.test(endpoint) ||
    /^https:\/\/[^/?#]*@/iu.test(endpoint.trim())
  )
    throw new Error("PROVIDER_ENDPOINT_INVALID");
  try {
    const url = normalizePublicHttpUrl(endpoint.trim());
    for (const key of url.searchParams.keys()) {
      if (
        /^(?:token|(?:access|auth|refresh|id)[_-]?token|api[_-]?key|auth|authorization|(?:client|access|secret)[_-]?(?:key|secret)|secret|password|signature|credentials?|session(?:[_-]?id)?|key)$/iu.test(
          key,
        )
      )
        throw new Error("PROVIDER_ENDPOINT_INVALID");
    }
    return url.toString();
  } catch {
    throw new Error("PROVIDER_ENDPOINT_INVALID");
  }
}

export function normalizeNoteDetailAuthorization(input: string): string {
  const token = input.trim();
  if (!token || /[\r\n]/u.test(input) || token.length > 4096)
    throw new Error("PROVIDER_TOKEN_INVALID");
  const prefixed = /^(Bearer|Token) +([\x21-\x7e]+)$/iu.exec(token);
  if (!prefixed && !/^[\x21-\x7e]+$/u.test(token)) throw new Error("PROVIDER_TOKEN_INVALID");
  if (/^(?:Token|Bearer)$/iu.test(token)) throw new Error("PROVIDER_TOKEN_INVALID");
  return prefixed
    ? `${prefixed[1]?.toLowerCase() === "bearer" ? "Bearer" : "Token"} ${prefixed[2]}`
    : `Token ${token}`;
}

/** One billed request at most. Only an administrator-configured endpoint is accepted. */
export async function fetchNoteDetail(options: {
  endpoint: string;
  token: string;
  noteId: string;
  fetch?: typeof fetch;
}): Promise<NoteDetailResult> {
  if (!/^[a-zA-Z0-9_-]{6,128}$/u.test(options.noteId))
    return { status: "INVALID_REQUEST", code: "INVALID_NOTE_ID" };
  const authorization = normalizeNoteDetailAuthorization(options.token);
  const url = new URL(normalizeNoteDetailEndpoint(options.endpoint));
  url.searchParams.set("noteId", options.noteId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const request: RequestInit = {
      method: "GET",
      redirect: "error",
      headers: { Authorization: authorization },
      signal: controller.signal,
    };
    const consume = async (response: Response): Promise<NoteDetailResult> => {
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_RESPONSE_BYTES)
        return { status: "PARSER_CHANGED", code: "RESPONSE_TOO_LARGE" };
      const reader = response.body?.getReader();
      if (!reader) return { status: "RETRYABLE", code: "EMPTY_RESPONSE" };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return { status: "PARSER_CHANGED", code: "RESPONSE_TOO_LARGE" };
        }
        chunks.push(value);
      }
      return parseNoteDetail(
        response.status,
        new TextDecoder().decode(Buffer.concat(chunks)),
        options.noteId,
      );
    };
    if (options.fetch) return await consume(await options.fetch(url, request));
    return await withPublicHttpResponse(url.toString(), request, {}, consume);
  } catch {
    return { status: "RETRYABLE", code: "NETWORK_OR_TIMEOUT" };
  } finally {
    clearTimeout(timer);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function count(value: unknown): number | null {
  if (typeof value === "string" && /^\d{1,10}$/u.test(value)) value = Number(value);
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : null;
}

function noteMetadata(
  authorId: unknown,
  rawImageCount: unknown,
): { authorId: string | null; imageCount: number } | null {
  if (
    authorId != null &&
    (typeof authorId !== "string" || !/^[A-Za-z0-9_-]{6,100}$/u.test(authorId))
  )
    return null;
  const imageCount = rawImageCount === undefined ? 0 : count(rawImageCount);
  if (imageCount === null || imageCount > 40) return null;
  return { authorId: typeof authorId === "string" ? authorId : null, imageCount };
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999
    ? null
    : date;
}

function isoTimestamp(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999
    ? null
    : date;
}
