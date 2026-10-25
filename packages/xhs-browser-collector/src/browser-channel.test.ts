import { describe, expect, it } from "vitest";
import { browserChannel } from "./browser-channel";

describe("installed browser selection", () => {
  it("chooses Microsoft Edge by default on Windows and allows an explicit Chrome selection", () => {
    expect(browserChannel("", "win32")).toBe("msedge");
    expect(browserChannel("edge", "win32")).toBe("msedge");
    expect(browserChannel("msedge", "win32")).toBe("msedge");
    expect(browserChannel("chrome", "win32")).toBe("chrome");
  });

  it("preserves the local Linux development browser and rejects executable paths", () => {
    expect(browserChannel("", "linux")).toBe("chrome");
    expect(() => browserChannel("C:\\Program Files\\Microsoft\\Edge\\msedge.exe", "win32")).toThrow(
      "COLLECTOR_BROWSER_CHANNEL_UNSUPPORTED",
    );
  });
});
