import { afterEach, describe, expect, it, vi } from "vitest";
import { copyBrowserText, randomBrowserId } from "./browser-capabilities";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP browser capabilities", () => {
  it("uses secure random bytes when randomUUID is unavailable on an HTTP origin", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xab);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(randomBrowserId()).toBe("abababab-abab-4bab-abab-abababababab");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("keeps the platform UUID implementation when available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "platform-uuid" });
    expect(randomBrowserId()).toBe("platform-uuid");
  });

  it("uses the clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyBrowserText("文案");
    expect(writeText).toHaveBeenCalledWith("文案");
  });

  it.each([true, false])(
    "cleans up HTTP copy fallback and reports success=%s accurately",
    async (copied) => {
      const field = { value: "", readOnly: false, style: {}, select: vi.fn(), remove: vi.fn() };
      const focus = vi.fn();
      const execCommand = vi.fn(() => copied);
      vi.stubGlobal("navigator", {});
      vi.stubGlobal("document", {
        activeElement: { focus },
        createElement: () => field,
        body: { append: vi.fn() },
        execCommand,
      });
      const result = copyBrowserText("完整图文");
      if (copied) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("手动复制");
      expect(field.value).toBe("完整图文");
      expect(field.select).toHaveBeenCalledOnce();
      expect(field.remove).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(execCommand).toHaveBeenCalledWith("copy");
    },
  );
});
