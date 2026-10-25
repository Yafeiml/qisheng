import { fetchNoteDetail } from "./note-detail";
import { PanelState } from "./panel-state";

/** Restrict a paid pilot call to one explicitly entered note, never a short link or arbitrary URL. */
export function noteIdFromInput(input: string): string {
  if (/^[a-zA-Z0-9_-]{6,128}$/u.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("NOTE_LINK_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    !["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("NOTE_LINK_UNSUPPORTED");
  const id = /^\/(?:explore|discovery\/item)\/([a-zA-Z0-9_-]{6,128})\/?$/u.exec(url.pathname)?.[1];
  if (!id) throw new Error("NOTE_ID_REQUIRED");
  return id;
}

async function hiddenInput(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new Error("INTERACTIVE_TTY_REQUIRED");
  process.stdout.write("粘贴一条有权核查的笔记链接或 ID（输入隐藏）：");
  return new Promise((resolve, reject) => {
    let input = "";
    const previousRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.off("data", handler);
      process.stdin.setRawMode(Boolean(previousRaw));
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const handler = (data: Buffer) => {
      for (const char of data.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(input.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("CANCELLED"));
          return;
        }
        if (char === "\b" || char === "\u007f") input = input.slice(0, -1);
        else if (char >= " " && input.length < 2048) input += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handler);
  });
}

async function main() {
  const state = process.env.READBACK_STATE_DIR
    ? new PanelState(process.env.READBACK_STATE_DIR)
    : null;
  const token = process.env.PUBLICATION_READBACK_PROVIDER_TOKEN ?? state?.token();
  const endpoint = process.env.PUBLICATION_READBACK_PROVIDER_ENDPOINT ?? state?.endpoint;
  if (!endpoint) throw new Error("PROVIDER_ENDPOINT_MISSING");
  if (!token) throw new Error("PROVIDER_TOKEN_MISSING");
  if (process.argv.length > 2) throw new Error("LINK_ARGUMENT_FORBIDDEN");
  const noteId = noteIdFromInput(await hiddenInput());
  const result = await fetchNoteDetail({ endpoint, noteId, token });
  console.log(
    JSON.stringify(
      result.status === "AVAILABLE"
        ? {
            status: result.status,
            titlePresent: result.note.title.length > 0,
            bodyPresent: result.note.body.length > 0,
            authorPresent: Boolean(result.note.authorId),
            imageCount: result.note.imageCount,
            metrics: {
              likesExact: result.note.likes !== null,
              commentsExact: result.note.comments !== null,
              favoritesExact: result.note.favorites !== null,
            },
          }
        : { status: result.status, code: result.code },
    ),
  );
}

if (require.main === module) {
  main().catch((error) => {
    const allowed = new Set([
      "PROVIDER_ENDPOINT_MISSING",
      "PROVIDER_TOKEN_MISSING",
      "LINK_ARGUMENT_FORBIDDEN",
      "INTERACTIVE_TTY_REQUIRED",
      "NOTE_LINK_INVALID",
      "NOTE_LINK_UNSUPPORTED",
      "NOTE_ID_REQUIRED",
      "CANCELLED",
      "PROVIDER_TOKEN_INVALID",
      "PROVIDER_ENDPOINT_INVALID",
    ]);
    console.error(
      JSON.stringify({
        status: "STOP",
        code: error instanceof Error && allowed.has(error.message) ? error.message : "UNKNOWN",
      }),
    );
    process.exitCode = 1;
  });
}
