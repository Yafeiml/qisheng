import { describe, expect, it } from "vitest";
import { differenceHash, hashSimilarity } from "./image-similarity";

const gradient = (reverse: boolean) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="${reverse ? "100%" : "0%"}" x2="${reverse ? "0%" : "100%"}"><stop stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  );

describe("image perceptual similarity", () => {
  it("returns full similarity for the same visual after resize", async () => {
    const original = await differenceHash(gradient(false));
    const duplicate = await differenceHash(gradient(false));
    expect(hashSimilarity(original, duplicate)).toBe(1);
  });

  it("distinguishes an opposite gradient", async () => {
    const original = await differenceHash(gradient(false));
    const opposite = await differenceHash(gradient(true));
    expect(hashSimilarity(original, opposite)).toBeLessThan(0.25);
  });
});
