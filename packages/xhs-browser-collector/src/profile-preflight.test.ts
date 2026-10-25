import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserNoteReader } from "./browser";
import { ensureProfileSafe } from "./profile-preflight";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function profile(preferences?: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xhs-profile-preflight-"));
  directories.push(dir);
  if (preferences) {
    await mkdir(join(dir, "Default"));
    await writeFile(join(dir, "Default", "Preferences"), JSON.stringify(preferences));
  }
  return dir;
}

describe("pre-launch Edge/Chrome profile gate", () => {
  it("accepts an empty profile and a clean normal close", async () => {
    await expect(ensureProfileSafe(await profile())).resolves.toBeUndefined();
    await expect(
      ensureProfileSafe(
        await profile({ profile: { exit_type: "Normal" }, session: { restore_on_startup: 5 } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("stops after a crash, restored tabs or an unrecognized populated profile", async () => {
    await expect(
      ensureProfileSafe(await profile({ profile: { exit_type: "Crashed" } })),
    ).rejects.toThrow("PROFILE_PREVIOUS_EXIT_UNCLEAN");
    await expect(
      ensureProfileSafe(
        await profile({ profile: { exit_type: "Normal" }, session: { restore_on_startup: 1 } }),
      ),
    ).rejects.toThrow("PROFILE_RESTORE_ENABLED");
    const unknown = await profile();
    await writeFile(join(unknown, "unrecognized"), "stale state");
    await expect(ensureProfileSafe(unknown)).rejects.toThrow("PROFILE_NOT_CLEANLY_INITIALIZED");
  });

  it("fails closed in the reader before any navigation when the profile was not closed normally", async () => {
    const dir = await profile({ profile: { exit_type: "Crashed" } });
    const reader = new BrowserNoteReader(dir, async () => {
      throw new Error("BROWSER_SHOULD_NOT_NAVIGATE");
    });
    await expect(
      reader.read({
        id: "offline-job-0001",
        kind: "VERIFY",
        accessUrl: "https://www.xiaohongshu.com/explore/mock0001",
        leaseToken: "00000000-0000-4000-8000-000000000001",
        leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        submittedAt: new Date().toISOString(),
        dueAt: new Date().toISOString(),
        windowHours: null,
      }),
    ).rejects.toThrow("BROWSER_STATE_UNCERTAIN");
  });
});
