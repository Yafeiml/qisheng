import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGuard } from "./store";
import type { Job } from "./types";

const created: string[] = [];
afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

const job = (id: number): Job => ({
  id: `server-${id}`,
  kind: "VERIFY",
  accessUrl: "https://www.xiaohongshu.com/explore/mock0001",
  leaseToken: `opaque-secret-${id}`,
  leaseExpiresAt: "2026-09-24T00:00:00.000Z",
  dueAt: "2026-09-23T00:00:00.000Z",
  submittedAt: "2026-09-23T00:00:00.000Z",
  windowHours: null,
});

describe("durable local access budget", () => {
  it("persists the stable job attempt across a restart and rejects a fresh lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xhs-guard-test-"));
    created.push(directory);
    const guard = new LocalGuard(directory);
    await guard.start();
    const now = new Date("2026-09-23T01:00:00.000Z");
    await guard.reserve(job(1), now);
    await guard.reserve(job(1), now, 1);
    await expect(guard.reserve(job(1), now, 1)).rejects.toThrow("JOB_ALREADY_NAVIGATED");
    const second = new LocalGuard(directory);
    await expect(second.start()).rejects.toThrow();
    expect((await guard.status(now)).hourRemaining).toBe(3);
    await guard.stop();

    await second.start();
    const newLease = { ...job(1), leaseToken: "a-new-server-issued-lease" };
    expect(await second.hasVisited(newLease)).toBe(true);
    await expect(second.reserve(newLease, new Date(now.getTime() + 120_000))).rejects.toThrow(
      "JOB_ALREADY_ATTEMPTED",
    );
    expect((await second.status()).reason).toBe("JOB_ALREADY_ATTEMPTED");
    await second.stop();
  });

  it("enforces rolling one-hour and 24-hour windows across UTC boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xhs-rolling-test-"));
    created.push(directory);
    const guard = new LocalGuard(directory);
    await guard.start();
    const start = Date.parse("2026-09-23T16:00:00.000Z");
    let latest = start;
    for (let hour = 0; hour < 8; hour += 1) {
      for (let index = 0; index < 5; index += 1) {
        latest = start + hour * 61 * 60_000 + index * 60_000;
        await guard.reserve(job(hour * 5 + index + 1), new Date(latest));
      }
    }
    expect((await guard.status(new Date(latest + 60_000))).dayRemaining).toBe(0);
    expect((await guard.status(new Date("2026-09-24T00:10:00.000Z"))).dayRemaining).toBe(0);
    await expect(guard.reserve(job(41), new Date("2026-09-24T00:10:00.000Z"))).rejects.toThrow(
      "NAVIGATION_BUDGET_EXHAUSTED",
    );
    expect((await guard.status(new Date(start + 32 * 60 * 60_000))).dayRemaining).toBe(40);
    await guard.stop();
  });

  it("requires 60 seconds between independent jobs, without delaying redirects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xhs-gap-test-"));
    created.push(directory);
    const guard = new LocalGuard(directory);
    await guard.start();
    const start = new Date("2026-09-23T00:59:50.000Z");
    await guard.reserve(job(1), start);
    await guard.reserve(job(1), start, 1);
    await expect(guard.reserve(job(2), new Date(start.getTime() + 10_000))).rejects.toThrow(
      "NAVIGATION_COOLDOWN",
    );
    expect((await guard.status(new Date(start.getTime() + 10_000))).cooldownRemainingMs).toBe(
      50_000,
    );
    await guard.reserve(job(2), new Date(start.getTime() + 60_000));
    expect((await guard.status(new Date(start.getTime() + 70_000))).hourRemaining).toBe(2);
    await guard.stop();
  });

  it("retains the local risk pause after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xhs-pause-test-"));
    created.push(directory);
    const guard = new LocalGuard(directory);
    await guard.start();
    await guard.pause("CHALLENGE_REQUIRED");
    await guard.stop();
    const restarted = new LocalGuard(directory);
    await restarted.start();
    expect((await restarted.status()).reason).toBe("CHALLENGE_REQUIRED");
    await expect(restarted.reserve(job(1))).rejects.toThrow("COLLECTOR_PAUSED");
    await restarted.stop();
  });
});
