import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as noteDetail from "./note-detail";
import { startPanel } from "./panel";
import { PanelState } from "./panel-state";

const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("TEST_PORT_UNAVAILABLE");
  return new Promise((resolve) => socket.close(() => resolve(address.port)));
}

describe.skipIf(process.platform === "win32")(
  "private collector dashboard HTTP boundary (POSIX permissions)",
  () => {
    it("restricts first setup, requires a session and CSRF for Token updates, and never returns the Token", async () => {
      const folder = mkdtempSync(join(tmpdir(), "readback-http-"));
      folders.push(folder);
      const port = await freePort();
      const names = [
        "NODE_ENV",
        "READBACK_PANEL_HOST",
        "READBACK_PANEL_PORT",
        "READBACK_PANEL_PUBLIC_URL",
        "READBACK_PANEL_SETUP_IPS",
        "PUBLICATION_READBACK_API_BASE_URL",
        "PUBLICATION_READBACK_NODE_ID",
        "PUBLICATION_READBACK_NODE_KEY",
      ];
      const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      const restore = () => {
        for (const name of names) {
          const value = previous[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      };
      Object.assign(process.env, {
        NODE_ENV: "test",
        READBACK_PANEL_HOST: "127.0.0.1",
        READBACK_PANEL_PORT: String(port),
        READBACK_PANEL_SETUP_IPS: "127.0.0.2",
        PUBLICATION_READBACK_API_BASE_URL: "https://example.org/api/",
        PUBLICATION_READBACK_NODE_ID: "test-node",
        PUBLICATION_READBACK_NODE_KEY: "a".repeat(64),
      });
      const panel = new PanelState(folder);
      delete process.env.READBACK_PANEL_PUBLIC_URL;
      const server = await startPanel(panel);
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: object, headers: Record<string, string> = {}) =>
        fetch(`${base}/api/${path}`, {
          method: "POST",
          headers: {
            origin: base,
            "content-type": "application/json",
            connection: "close",
            ...headers,
          },
          body: JSON.stringify(body),
        });
      try {
        expect((await post("setup", { password: "a-private-password" })).status).toBe(403);
        process.env.READBACK_PANEL_SETUP_IPS = "127.0.0.1";
        // The listener's allowlist is fixed at startup; changing env cannot open setup access.
        expect((await post("setup", { password: "a-private-password" })).status).toBe(403);
      } finally {
        await server.close();
        restore();
      }

      process.env.READBACK_PANEL_SETUP_IPS = "127.0.0.1";
      Object.assign(process.env, {
        NODE_ENV: "test",
        READBACK_PANEL_HOST: "127.0.0.1",
        READBACK_PANEL_PORT: String(port),
        PUBLICATION_READBACK_API_BASE_URL: "https://example.org/api/",
        PUBLICATION_READBACK_NODE_ID: "test-node",
        PUBLICATION_READBACK_NODE_KEY: "a".repeat(64),
      });
      const permitted = await startPanel(panel);
      try {
        expect(
          (await post("setup", { password: "a-private-password" }, { origin: "http://evil.test" }))
            .status,
        ).toBe(403);
        const setup = await post("setup", { password: "a-private-password" });
        expect(setup.status).toBe(200);
        const cookie = setup.headers.get("set-cookie")?.split(";")[0];
        const csrf = ((await setup.json()) as { csrf: string }).csrf;
        expect(cookie).toContain("readback_session=");
        const provider = {
          endpoint: "https://api.example.org/note",
          token: "sample-token-only-for-tests-123",
        };
        expect((await post("provider", provider)).status).toBe(401);
        expect((await post("provider", provider, { cookie: cookie ?? "" })).status).toBe(403);
        const configured = await post("provider", provider, {
          cookie: cookie ?? "",
          "x-panel-csrf": csrf,
        });
        expect(configured.status).toBe(200);
        const snapshot = await fetch(`${base}/api/state`, { headers: { cookie: cookie ?? "" } });
        expect(snapshot.status).toBe(200);
        const text = await snapshot.text();
        expect(text).toContain('"tokenConfigured":true');
        expect(text).toContain('"endpoint":"https://api.example.org/note"');
        expect(text).toContain('"endpointConfigured":true');
        expect(text).not.toContain("sample-token-only-for-tests");
        const anonymous = await fetch(`${base}/api/state`);
        expect(await anonymous.text()).not.toContain(provider.endpoint);
        const headers = { cookie: cookie ?? "", "x-panel-csrf": csrf };
        const rejected = await post("provider", { endpoint: "https://127.0.0.1/note" }, headers);
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({ error: "PROVIDER_ENDPOINT_INVALID" });
        expect(panel.endpoint).toBe(provider.endpoint);
        expect(panel.token()).toBe(provider.token);
        const changed = await post(
          "provider",
          { endpoint: "https://api.example.org/other" },
          headers,
        );
        expect(changed.status).toBe(200);
        expect(panel.token()).toBe(provider.token);

        let finishProbe: ((result: noteDetail.NoteDetailResult) => void) | undefined;
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        vi.spyOn(noteDetail, "fetchNoteDetail").mockImplementation(() => {
          markStarted?.();
          return new Promise((resolve) => {
            finishProbe = resolve;
          });
        });
        const probing = post("probe", { link: "abc123xyz", confirmed: true }, headers);
        await started;
        await post("provider", { endpoint: provider.endpoint }, headers);
        await post("provider", { endpoint: "https://api.example.org/other" }, headers);
        finishProbe?.({
          status: "AVAILABLE",
          note: {
            noteId: "abc123xyz",
            title: "样本",
            body: "正文",
            authorId: null,
            publishedAt: null,
            imageCount: 1,
            hashtags: [],
            likes: 0,
            comments: 0,
            favorites: 0,
          },
        });
        const stale = await probing;
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: "PROVIDER_CONFIGURATION_CHANGED" });
        expect(panel.probe.verifiedAt).toBeNull();
        expect(panel.workerEnabled).toBe(false);
      } finally {
        await permitted.close();
        restore();
      }
    });

    it.each(["127.0.0.1", "0.0.0.0", "::1"])(
      "accepts production binding %s and a separate HTTPS reverse proxy origin",
      async (host) => {
        const folder = mkdtempSync(join(tmpdir(), "readback-network-"));
        folders.push(folder);
        const port = await freePort();
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("READBACK_PANEL_HOST", host);
        vi.stubEnv("READBACK_PANEL_PORT", String(port));
        vi.stubEnv("READBACK_PANEL_PUBLIC_URL", "https://panel.example.org:8443/");
        vi.stubEnv("READBACK_PANEL_SETUP_IPS", "127.0.0.1,::1,192.168.1.20,fd00::123");
        vi.stubEnv("PUBLICATION_READBACK_API_BASE_URL", "http://api:3100/internal/api");
        vi.stubEnv("PUBLICATION_READBACK_NODE_ID", "test-node");
        vi.stubEnv("PUBLICATION_READBACK_NODE_KEY", "a".repeat(64));
        const panel = new PanelState(folder);
        const server = await startPanel(panel);
        const base = `http://${host === "::1" ? "[::1]" : "127.0.0.1"}:${port}`;
        try {
          expect((await fetch(`${base}/health`)).status).toBe(200);
          const snapshot = (await fetch(`${base}/api/state`).then((response) =>
            response.json(),
          )) as { setupAllowed: boolean };
          expect(snapshot.setupAllowed).toBe(true);
          const post = (origin: string) =>
            fetch(`${base}/api/setup`, {
              method: "POST",
              headers: { origin, "content-type": "application/json" },
              body: JSON.stringify({ password: "network-independent-password" }),
            });
          expect((await post("https://wrong.example.org")).status).toBe(403);
          const initialized = await post("https://panel.example.org:8443");
          expect(initialized.status).toBe(200);
          expect(initialized.headers.get("set-cookie")).toContain("; Secure");
          expect(panel.setupRequired).toBe(false);
        } finally {
          await server.close();
          vi.unstubAllEnvs();
        }
      },
    );

    it.each(["127.0.0.1", "::ffff:7f00:1"])(
      "accepts an empty optional public URL and mapped setup IPs (%s)",
      async (host) => {
        const folder = mkdtempSync(join(tmpdir(), "readback-network-"));
        folders.push(folder);
        const port = await freePort();
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("READBACK_PANEL_HOST", host);
        vi.stubEnv("READBACK_PANEL_PORT", String(port));
        vi.stubEnv("READBACK_PANEL_PUBLIC_URL", "");
        vi.stubEnv("READBACK_PANEL_SETUP_IPS", "::ffff:7f00:1");
        vi.stubEnv("PUBLICATION_READBACK_API_BASE_URL", "http://api:3100");
        vi.stubEnv("PUBLICATION_READBACK_NODE_ID", "test-node");
        vi.stubEnv("PUBLICATION_READBACK_NODE_KEY", "a".repeat(64));
        const server = await startPanel(new PanelState(folder));
        try {
          const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
          const response = await fetch(`${base}/api/setup`, {
            method: "POST",
            headers: { origin: new URL(base).origin, "content-type": "application/json" },
            body: JSON.stringify({ password: "network-independent-password" }),
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("set-cookie")).not.toContain("; Secure");
        } finally {
          await server.close();
          vi.unstubAllEnvs();
        }
      },
    );

    it("requires an explicit browser URL for wildcard bindings and validates only IP syntax for setup devices", async () => {
      const folder = mkdtempSync(join(tmpdir(), "readback-network-"));
      folders.push(folder);
      vi.stubEnv("READBACK_PANEL_HOST", "0.0.0.0");
      vi.stubEnv("READBACK_PANEL_PUBLIC_URL", "");
      vi.stubEnv("READBACK_PANEL_SETUP_IPS", "192.168.1.10,fd00::123");
      await expect(startPanel(new PanelState(folder))).rejects.toThrow("PANEL_PUBLIC_URL_REQUIRED");
      vi.stubEnv("READBACK_PANEL_SETUP_IPS", "not-an-ip");
      await expect(startPanel(new PanelState(folder))).rejects.toThrow("PANEL_SETUP_IPS_INVALID");
      vi.unstubAllEnvs();
    });
  },
);
