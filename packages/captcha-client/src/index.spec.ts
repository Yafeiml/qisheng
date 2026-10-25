import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { retrySeconds, solveSmsChallenge } from "./index";

describe("portable Cap client", () => {
  it("runs the bundled native miniapp solver without DOM, TextEncoder, WebCrypto or Node globals", async () => {
    const module = { exports: {} as { solveSmsChallenge: typeof solveSmsChallenge } };
    runInNewContext(readFileSync("apps/employee-miniapp/utils/generated/captcha.js", "utf8"), {
      module,
      exports: module.exports,
      setTimeout,
    });
    const proof = await module.exports.solveSmsChallenge({
      required: true,
      token: "fixture-token",
      challenge: { c: 1, s: 16, d: 1 },
      expires: Date.now() + 60000,
    });
    expect(
      createHash("sha256")
        .update(`3942719099790f28${proof?.solutions[0]}`)
        .digest("hex")
        .startsWith("5"),
    ).toBe(true);
  });
  it("solves the Cap format-1 protocol using independently derived known challenge salts", async () => {
    // Token fixture: FNV-1a/xorshift values match the deployed capjs-core protocol.
    const result = await solveSmsChallenge({
      required: true,
      token: "fixture-token",
      challenge: { c: 2, s: 16, d: 1 },
      expires: Date.now() + 60000,
    });
    if (!result) throw new Error("Expected a proof");
    expect(result.solutions).toHaveLength(2);
    expect(result).toMatchObject({ token: "fixture-token" });
    const vectors = [
      ["3942719099790f28", "5"],
      ["89cfa5add23d5910", "b"],
    ] as const;
    vectors.forEach(([salt, target], index) => {
      expect(
        createHash("sha256")
          .update(salt + result.solutions[index])
          .digest("hex")
          .startsWith(target),
      ).toBe(true);
    });
  });
  it("rejects unsupported or excessive work and cancels without returning a proof", async () => {
    await expect(
      solveSmsChallenge({
        required: true,
        token: "bad",
        challenge: { c: 500, s: 32, d: 8 },
        expires: Date.now() + 60000,
      }),
    ).rejects.toThrow("不兼容");
    await expect(
      solveSmsChallenge({
        required: true,
        token: "expired",
        challenge: { c: 1, s: 16, d: 1 },
        expires: 1,
      }),
    ).rejects.toThrow("超时");
    await expect(solveSmsChallenge({ required: false })).resolves.toBeUndefined();
  });
  it("recovers server-provided retry time and ignores malformed values", () => {
    expect(retrySeconds({ body: { details: { retryAfterSeconds: 59 } } })).toBe(59);
    expect(retrySeconds({ body: { details: { retryAfterSeconds: "60" } } })).toBe(0);
  });
});
