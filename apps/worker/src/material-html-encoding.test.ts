import { type CheerioAPI, decodeStream, loadBuffer } from "cheerio";
import { describe, expect, it } from "vitest";

describe("HTML decoding with encoding-sniffer 1", () => {
  it("preserves Chinese text in UTF-8 and GB18030 HTML", () => {
    const utf8 = Buffer.from('<meta charset="utf-8"><p>中文</p>');
    const gb18030 = Buffer.concat([
      Buffer.from('<meta charset="gb18030"><p>'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from("</p>"),
    ]);
    for (const buffer of [utf8, gb18030]) expect(loadBuffer(buffer)("p").text()).toBe("中文");
  });

  it("decodes a multibyte character split across stream chunks", async () => {
    const html = Buffer.from('<meta charset="utf-8"><p>中文</p>');
    const offset = html.indexOf(Buffer.from("中")) + 1;
    const page = await new Promise<CheerioAPI>((resolve, reject) => {
      const stream = decodeStream({}, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
      stream.write(html.subarray(0, offset));
      stream.end(html.subarray(offset));
    });
    expect(page("p").text()).toBe("中文");
  });
});
