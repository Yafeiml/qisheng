import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  apiBaseUrl: "https://one.example.test/api",
  smsLoginEnabled: false,
}));
vi.mock("../../apps/employee-miniapp/config", () => ({ miniappConfig: config }));
const storage = new Map<string, unknown>();
beforeEach(() => {
  vi.resetModules();
  storage.clear();
  config.apiBaseUrl = "https://one.example.test/api";
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("getApp", () => ({ globalData: { session: null } }));
});
describe("miniapp deployment session isolation", () => {
  it("accepts account sessions without a phone and never persists a password", async () => {
    const session = await import("../../apps/employee-miniapp/utils/session");
    session.saveSession({
      accessToken: "employee-token",
      memberships: [],
      phone: "",
      username: "employee",
    });
    expect(session.loadSession()?.username).toBe("employee");
    expect(
      [...storage.values()].some(
        (value) => typeof value === "object" && value && "password" in value,
      ),
    ).toBe(false);
  });
  it("does not read another installation's session, enterprise filter or notices", async () => {
    const first = await import("../../apps/employee-miniapp/utils/session");
    first.saveSession({ accessToken: "first-token", memberships: [], phone: "" });
    first.saveEnterpriseFilter("first-enterprise");
    first.saveFlashNotice("first notice");
    first.markFirstGuideSeen();
    config.apiBaseUrl = "https://two.example.test/api";
    vi.resetModules();
    const second = await import("../../apps/employee-miniapp/utils/session");
    expect(second.loadSession()).toBeNull();
    expect(second.loadEnterpriseFilter()).toBe("ALL");
    expect(second.consumeFlashNotice()).toBe("");
    expect(second.hasSeenFirstGuide()).toBe(false);
    second.clearSession();
    expect(first.loadSession()?.accessToken).toBe("first-token");
  });
});
