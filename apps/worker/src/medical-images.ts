import type { MedicalPlan } from "@xhs-agentic/ai-gateway";
import { medicalImageTask } from "@xhs-agentic/ai-gateway";
import sharp from "sharp";
import { PermanentGenerationError } from "./generation-execution";

/** Original photographs are reused honestly; no noise, invented scene, logo or provider call. */
export async function renderMedicalOriginal(
  assets: readonly {
    bytes: Uint8Array;
    privacyConfirmed?: boolean;
    authorizationConfirmed?: boolean;
  }[],
  sequence: number,
  width = 1080,
  height = 1440,
): Promise<Uint8Array> {
  if (
    !assets.length ||
    assets.some((asset) => !asset.privacyConfirmed || !asset.authorizationConfirmed)
  ) {
    throw new PermanentGenerationError(
      "医疗原图需要已授权素材与明确隐私确认",
      "MEDICAL_ORIGINAL_NOT_CONFIRMED",
    );
  }
  const asset = assets[(sequence - 1) % assets.length];
  if (!asset) throw new PermanentGenerationError("医疗原图缺失", "MEDICAL_ORIGINAL_MISSING");
  if (sequence === 1 && assets.length > 1) {
    const selected = assets.slice(0, 4);
    const columns = 2;
    const rows = Math.ceil(selected.length / columns);
    const gap = Math.max(4, Math.round(width * 0.012));
    const cellWidth = Math.floor((width - gap * (columns + 1)) / columns);
    const cellHeight = Math.floor((height - gap * (rows + 1)) / rows);
    const parts = await Promise.all(
      selected.map(async (source, index) => ({
        input: await sharp(source.bytes)
          .rotate()
          .resize(cellWidth, cellHeight, { fit: "contain", background: "#ffffff" })
          .png()
          .toBuffer(),
        left: gap + (index % columns) * (cellWidth + gap),
        top: gap + Math.floor(index / columns) * (cellHeight + gap),
      })),
    );
    return new Uint8Array(
      await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
        .composite(parts)
        .png()
        .toBuffer(),
    );
  }
  // Contain preserves evidence and avoids silently cropping consent/privacy-sensitive details.
  return new Uint8Array(
    await sharp(asset.bytes)
      .rotate()
      .resize(width, height, { fit: "contain", background: "#ffffff" })
      .png()
      .toBuffer(),
  );
}

export async function renderMedicalQuestionCard(
  plan: MedicalPlan,
  copy: { title: string; body: string },
  sequence: number,
  width = 1080,
  height = 1440,
): Promise<Uint8Array> {
  const topic = plan.topics[(sequence - 1) % plan.topics.length];
  const heading =
    sequence === 1
      ? (topic?.question ?? copy.title)
      : (medicalImageTask(plan, sequence).split("；")[0] ?? copy.title);
  const paragraphs = cardParagraphs(copy.body);
  const start = sequence === 1 ? 0 : 1 + (sequence - 2) * 2;
  const details = paragraphs.slice(start, start + (sequence === 1 ? 1 : 2));
  const shortHeading = heading.length > 52 ? `${heading.slice(0, 49)}…` : heading;
  const titleLines = wrap(shortHeading, 14).slice(0, 4);
  const bodyLines: string[] = [];
  for (const detail of details) {
    const lines = wrap(detail, 22);
    if (bodyLines.length + lines.length <= 12) bodyLines.push(...lines);
  }
  const titleMarkup = titleLines
    .map(
      (line, index) =>
        `<text x="88" y="${245 + index * 84}" font-size="65" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join("");
  const bodyY = 310 + titleLines.length * 84;
  const bodyMarkup = bodyLines
    .map(
      (line, index) =>
        `<text x="90" y="${bodyY + index * 54}" font-size="40">${escapeXml(line)}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="#f5f8fa"/><rect x="42" y="42" width="996" height="1356" rx="28" fill="#ffffff"/><g font-family="sans-serif" fill="#172d3d"><text x="88" y="125" font-size="30" fill="#52758b">${sequence === 1 ? "一个需要确认的问题" : "问题准备清单"}</text>${titleMarkup}${bodyMarkup}<text x="88" y="1330" font-size="28" fill="#52758b">信息需按实际情况向专业人员核实 · ${sequence}</text></g></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).resize(width, height).png().toBuffer());
}

export function medicalQuestionCardPageCount(copy: { body: string }): number {
  return Math.max(1, 1 + Math.ceil(Math.max(0, cardParagraphs(copy.body).length - 1) / 2));
}

function cardParagraphs(body: string): string[] {
  return body
    .split(/\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= 110);
}

function wrap(text: string, length: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  for (let index = 0; index < chars.length; ) {
    let end = Math.min(chars.length, index + length);
    if (end < chars.length && /^[，。！？：；、）】》]/u.test(chars[end] ?? "")) {
      end = Math.max(index + 1, end - (chars.length - end <= 2 ? 2 : 1));
    }
    lines.push(chars.slice(index, end).join(""));
    index = end;
  }
  return lines;
}

function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ??
      character,
  );
}
