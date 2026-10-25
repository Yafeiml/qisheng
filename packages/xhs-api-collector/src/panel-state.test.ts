import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PanelState } from "./panel-state";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")(
  "collector panel private state (POSIX permissions)",
  () => {
    it("requires a first password, encrypts supplier credentials at rest and invalidates old sessions", () => {
      const folder = mkdtempSync(join(tmpdir(), "readback-panel-"));
      folders.push(folder);
      const panel = new PanelState(folder);
      expect(panel.setupRequired).toBe(true);
      expect(() => panel.setup("short")).toThrow("PASSWORD_LENGTH_INVALID");
      panel.setup("a-long-private-password");
      expect(() => panel.setup("another-long-password")).toThrow("ALREADY_INITIALIZED");
      const session = panel.createSession();
      expect(panel.session(session.cookie)?.csrf).toBe(session.csrf);
      panel.configureToken("token-never-saved-in-plaintext-12345");
      expect(readFileSync(join(folder, "panel.json"), "utf8")).not.toContain("token-never-saved");
      const rebooted = new PanelState(folder);
      expect(rebooted.token()).toBe("token-never-saved-in-plaintext-12345");
      expect(rebooted.session(session.cookie)).toBeNull();
      rebooted.changePassword("a-long-private-password", "another-long-password");
      expect(rebooted.verifyPassword("a-long-private-password")).toBe(false);
      expect(rebooted.verifyPassword("another-long-password")).toBe(true);
    });

    it("limits billable samples and stops collection when the Token changes", () => {
      const folder = mkdtempSync(join(tmpdir(), "readback-panel-"));
      folders.push(folder);
      const panel = new PanelState(folder);
      panel.setup("a-long-private-password");
      panel.configureProvider("https://api.example.org/note", "sample-token-12345678901234567890");
      expect(() => panel.enable(true)).toThrow("SUCCESSFUL_SAMPLE_REQUIRED");
      const today = new Date("2026-09-24T10:00:00Z");
      for (let index = 0; index < 3; index++) panel.reserveProbe(today);
      expect(() => panel.reserveProbe(today)).toThrow("PROBE_DAILY_LIMIT");
      panel.recordProbe("AVAILABLE", today);
      panel.enable(true);
      expect(panel.workerEnabled).toBe(true);
      panel.configureToken("replacement-token-123456789012345");
      expect(panel.workerEnabled).toBe(false);
      expect(() => panel.enable(true)).toThrow("SUCCESSFUL_SAMPLE_REQUIRED");
      expect(panel.probe.used).toBe(3);
    });

    it("requires an explicit endpoint and revalidates changed suppliers without replacing a retained Token", () => {
      const folder = mkdtempSync(join(tmpdir(), "readback-panel-"));
      folders.push(folder);
      const panel = new PanelState(folder);
      expect(panel.endpoint).toBeNull();
      expect(() => panel.reserveProbe(new Date())).toThrow("PROVIDER_ENDPOINT_MISSING");
      expect(() => panel.configureProvider("https://api.example.org/note")).toThrow(
        "TOKEN_MISSING",
      );
      panel.configureProvider(
        "https://api.example.org/note?version=2",
        "Bearer sample-token-1234567890",
      );
      panel.recordProbe("AVAILABLE", new Date());
      panel.enable(true);
      const original = readFileSync(join(folder, "panel.json"), "utf8");
      expect(() =>
        panel.configureProvider("http://127.0.0.1/note", "replacement-token-1234567890"),
      ).toThrow("PROVIDER_ENDPOINT_INVALID");
      expect(() =>
        panel.configureProvider("https://other.example.org/note", "Bearer invalid token"),
      ).toThrow("TOKEN_FORMAT_INVALID");
      expect(() =>
        panel.configureProvider("https://other.example.org/note", "sample-token-1234567890\r\n"),
      ).toThrow("TOKEN_FORMAT_INVALID");
      expect(readFileSync(join(folder, "panel.json"), "utf8")).toBe(original);
      panel.configureProvider("https://api.example.org/note?version=2");
      expect(panel.workerEnabled).toBe(true);
      panel.configureProvider("https://other.example.org/note");
      expect(panel.token()).toBe("Bearer sample-token-1234567890");
      expect(panel.workerEnabled).toBe(false);
      expect(panel.probe.verifiedAt).toBeNull();
      const rebooted = new PanelState(folder);
      expect(rebooted.endpoint).toBe("https://other.example.org/note");
      expect(rebooted.token()).toBe("Bearer sample-token-1234567890");
    });

    it("preserves legacy encrypted credentials but stops an enabled legacy node until an endpoint is supplied", () => {
      const folder = mkdtempSync(join(tmpdir(), "readback-panel-"));
      folders.push(folder);
      const panel = new PanelState(folder);
      panel.configureProvider("https://api.example.org/note", "sample-token-12345678901234567890");
      panel.recordProbe("AVAILABLE", new Date());
      panel.enable(true);
      const saved = JSON.parse(readFileSync(join(folder, "panel.json"), "utf8"));
      delete saved.endpoint;
      writeFileSync(join(folder, "panel.json"), JSON.stringify(saved), { mode: 0o600 });
      const migrated = new PanelState(folder);
      expect(migrated.endpoint).toBeNull();
      expect(migrated.token()).toBe("sample-token-12345678901234567890");
      expect(migrated.workerEnabled).toBe(false);
      expect(migrated.probe.verifiedAt).toBeNull();
      expect(() => migrated.enable(true)).toThrow("SUCCESSFUL_SAMPLE_REQUIRED");
    });
  },
);
