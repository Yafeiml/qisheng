import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collector } from "./collector";
import { runOneCycle } from "./once";
import { LocalGuard } from "./store";
import type { Job, JobSource, NoteEvidence, NoteReader } from "./types";

const created: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

function job(): Job {
  return {
    id: "server-0001",
    kind: "VERIFY",
    accessUrl: "https://www.xiaohongshu.com/explore/mock0001?xsec_token=opaque",
    leaseToken: "opaque-server-lease-token-abcdefghijklmnopqrstuvwxyz",
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    dueAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    windowHours: null,
  };
}

function dependencies(status: NoteEvidence["status"] = "PARTIAL") {
  const claimed = job();
  const read = vi.fn(
    async (): Promise<NoteEvidence> => ({
      status,
      observedAt: new Date().toISOString(),
      canonicalUrl: "https://www.xiaohongshu.com/explore/mock0001",
      title: "mocked title",
      body: "mocked body",
      visibilityContext: "COLLECTOR_ACCOUNT",
      metrics: {
        likes: { value: 2, raw: "2", precision: "EXACT" },
        favorites: { value: null, raw: null, precision: "UNAVAILABLE" },
        comments: { value: 12000, raw: "1.2万", precision: "APPROXIMATE" },
      },
    }),
  );
  const evidence = vi.fn(async () => undefined);
  const pause = vi.fn(async () => undefined);
  const source: JobSource = {
    status: vi.fn(async () => ({ paused: false, reason: null })),
    claim: vi.fn(async () => ({ job: claimed, paused: false })),
    heartbeat: vi.fn(async () => ({ paused: false, leaseExpiresAt: claimed.leaseExpiresAt })),
    evidence,
    pause,
  };
  const reader: NoteReader = { read, close: vi.fn(async () => undefined) };
  return { claimed, source, reader, read, evidence, pause };
}

async function setup(status: NoteEvidence["status"] = "PARTIAL") {
  const deps = dependencies(status);
  const directory = await mkdtemp(join(tmpdir(), "xhs-collector-test-"));
  created.push(directory);
  const guard = new LocalGuard(directory);
  await guard.start();
  return { ...deps, directory, guard, collector: new Collector(deps.source, guard, deps.reader) };
}

describe("MCP collector operation", () => {
  it("exposes only opaque handles to agent and uploads saved evidence unchanged", async () => {
    const { claimed, collector, guard, evidence, read } = await setup();
    const visible = await collector.claim();
    expect(visible).toEqual({ status: "CLAIMED", jobId: claimed.id, kind: "VERIFY" });
    expect(JSON.stringify(visible)).not.toContain("xsec_token");
    expect(JSON.stringify(visible)).not.toContain("leaseToken");
    const result = await collector.read(claimed.id);
    expect(JSON.stringify(result)).not.toContain("mocked body");
    expect(JSON.stringify(result)).not.toContain("12000");
    expect(await collector.read(claimed.id)).toEqual(result);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await guard.status()).hourRemaining).toBe(4);
    await expect(collector.commit("model-authored-data")).rejects.toThrow(
      "EVIDENCE_HANDLE_INVALID",
    );
    await collector.commit((result as { evidenceHandle: string }).evidenceHandle);
    expect(evidence).toHaveBeenCalledWith(
      claimed,
      expect.objectContaining({ body: "mocked body", metrics: expect.any(Object) }),
    );
    await collector.close();
  });

  it("stops at risk signals and never auto-resumes", async () => {
    const { claimed, collector, guard, pause } = await setup("CHALLENGE_REQUIRED");
    await collector.claim();
    const result = await collector.read(claimed.id);
    expect(result).toMatchObject({ status: "CHALLENGE_REQUIRED" });
    expect((await guard.status()).paused).toBe(true);
    expect(pause).toHaveBeenCalledWith("CHALLENGE_REQUIRED");
    await collector.commit((result as { evidenceHandle: string }).evidenceHandle);
    expect(await collector.claim()).toEqual({ status: "PAUSED" });
    await collector.close();
  });

  it("fails closed before visiting on server pause", async () => {
    const { claimed, collector, source, read } = await setup();
    await collector.claim();
    source.status = vi.fn(async () => ({ paused: true, reason: "review" }));
    await expect(collector.read(claimed.id)).rejects.toThrow("SERVER_PAUSED");
    expect(read).not.toHaveBeenCalled();
    await collector.close();
  });

  it("provides a bounded --once path without handing evidence or URLs to a model", async () => {
    const { collector, source, claimed, evidence } = await setup();
    const result = await runOneCycle(collector);
    expect(result).toEqual({
      status: "COMMITTED",
      jobId: claimed.id,
      observationStatus: "PARTIAL",
    });
    expect(JSON.stringify(result)).not.toContain("xsec_token");
    expect(source.claim).toHaveBeenCalledTimes(1);
    expect(evidence).toHaveBeenCalledTimes(1);
    await collector.close();
  });

  it("releases an expired untouched lease then claims again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { collector, source, claimed } = await setup();
    expect(await collector.claim()).toMatchObject({ jobId: claimed.id });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const next = { ...job(), id: "server-0002" };
    source.claim = vi.fn(async () => ({ job: next, paused: false }));
    expect(await collector.claim()).toEqual({ status: "CLAIMED", jobId: next.id, kind: "VERIFY" });
    expect(source.claim).toHaveBeenCalledTimes(1);
    await collector.close();
  });

  it("pauses when a visited job's lease expires with uncommitted evidence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { collector, source, claimed, guard, pause } = await setup();
    await collector.claim();
    await collector.read(claimed.id);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(await collector.claim()).toEqual({ status: "PAUSED" });
    expect((await guard.status()).reason).toBe("STALE_NAVIGATION_LEASE");
    expect(source.claim).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledWith("STALE_NAVIGATION_LEASE");
    await collector.close();
  });

  it("refuses a previously reserved job on the new process even with a fresh lease", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { claimed, collector, directory } = await setup();
    await collector.claim();
    await collector.read(claimed.id);
    await collector.close();
    vi.setSystemTime(Date.now() + 120_000);
    const secondGuard = new LocalGuard(directory);
    await secondGuard.start();
    const secondDeps = dependencies();
    secondDeps.source.claim = vi.fn(async () => ({
      paused: false,
      job: { ...claimed, leaseToken: "00000000-0000-4000-8000-000000000002" },
    }));
    const second = new Collector(secondDeps.source, secondGuard, secondDeps.reader);
    expect(await second.claim()).toEqual({ status: "PAUSED" });
    expect((await secondGuard.status()).reason).toBe("JOB_ALREADY_ATTEMPTED");
    expect(secondDeps.read).not.toHaveBeenCalled();
    await second.close();
  });

  it("pauses on an unknown browser or evaluation failure without a network retry", async () => {
    const { claimed, collector, guard, source, reader } = await setup();
    reader.read = vi.fn(async () => {
      throw new Error("evaluate failed unexpectedly");
    });
    await collector.claim();
    await expect(collector.read(claimed.id)).rejects.toThrow("BROWSER_STATE_UNCERTAIN");
    expect((await guard.status()).reason).toBe("BROWSER_STATE_UNCERTAIN");
    expect(source.pause).toHaveBeenCalledWith("BROWSER_STATE_UNCERTAIN");
    expect(source.evidence).not.toHaveBeenCalled();
    await collector.close();
  });
});
