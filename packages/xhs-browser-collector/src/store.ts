import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "./types";

type State = {
  paused: { reason: string; at: string } | null;
  navigations: Array<{ key: string; at: string }>;
  attemptedJobs: Array<{ key: string; at: string }>;
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const FIRST_JOB_GAP_MS = 60_000;

function jobKey(job: Job): string {
  return createHash("sha256").update(job.id).digest("hex");
}

export class LocalGuard {
  private readonly file: string;
  private readonly lockFile: string;
  private lock: FileHandle | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {
    this.file = join(directory, "guard.json");
    this.lockFile = join(directory, "collector.lock");
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Deliberately fail closed after a crash. An operator must confirm no old process is running
    // before removing a stale lock. Two MCP processes must never share a browser profile.
    this.lock = await open(this.lockFile, "wx", 0o600);
    try {
      await this.lock.writeFile(String(process.pid));
      try {
        await this.read();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.save({ paused: null, navigations: [], attemptedJobs: [] });
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.lock) return;
    await this.lock.close();
    this.lock = null;
    await unlink(this.lockFile);
  }

  async status(now = new Date()): Promise<{
    paused: boolean;
    reason: string | null;
    hourRemaining: number;
    dayRemaining: number;
    cooldownRemainingMs: number;
  }> {
    const state = await this.read();
    const current = now.getTime();
    const hourUsed = state.navigations.filter(
      ({ at }) => current - Date.parse(at) < HOUR_MS && current >= Date.parse(at),
    ).length;
    const dayUsed = state.navigations.filter(
      ({ at }) => current - Date.parse(at) < DAY_MS && current >= Date.parse(at),
    ).length;
    const recent = Math.max(0, ...state.navigations.map(({ at }) => Date.parse(at)));
    return {
      paused: state.paused !== null,
      reason: state.paused?.reason ?? null,
      hourRemaining: Math.max(0, 5 - hourUsed),
      dayRemaining: Math.max(0, 40 - dayUsed),
      cooldownRemainingMs: Math.max(0, FIRST_JOB_GAP_MS - (current - recent)),
    };
  }

  async hasVisited(job: Job): Promise<boolean> {
    return (await this.read()).attemptedJobs.some((entry) => entry.key === jobKey(job));
  }

  /** Persist each top-level navigation, including redirects, BEFORE it starts. */
  async reserve(job: Job, now = new Date(), sequence = 0): Promise<void> {
    return this.exclusiveWrite(async () => {
      this.requireLock();
      if (!Number.isInteger(sequence) || sequence < 0 || sequence > 3) {
        throw new Error("NAVIGATION_SEQUENCE_FORBIDDEN");
      }
      const state = await this.read();
      if (state.paused) throw new Error("COLLECTOR_PAUSED");
      const at = now.toISOString();
      const stableKey = jobKey(job);
      if (sequence === 0 && state.attemptedJobs.some((entry) => entry.key === stableKey)) {
        state.paused = { reason: "JOB_ALREADY_ATTEMPTED", at };
        await this.save(state);
        throw new Error("JOB_ALREADY_ATTEMPTED");
      }
      if (sequence > 0 && !state.attemptedJobs.some((entry) => entry.key === stableKey)) {
        throw new Error("FIRST_NAVIGATION_MISSING");
      }
      const key = createHash("sha256")
        .update(`${job.id}\u0000${job.leaseToken}${sequence ? `\u0000${sequence}` : ""}`)
        .digest("hex");
      if (state.navigations.some((navigation) => navigation.key === key)) {
        throw new Error("JOB_ALREADY_NAVIGATED");
      }
      const { hourRemaining, dayRemaining, cooldownRemainingMs } = await this.status(now);
      if (hourRemaining === 0 || dayRemaining === 0) throw new Error("NAVIGATION_BUDGET_EXHAUSTED");
      if (sequence === 0 && cooldownRemainingMs > 0) throw new Error("NAVIGATION_COOLDOWN");
      const cutoff = now.getTime() - 14 * 86_400_000;
      state.navigations = state.navigations.filter(({ at: past }) => Date.parse(past) > cutoff);
      state.navigations.push({ key, at });
      if (sequence === 0) state.attemptedJobs.push({ key: stableKey, at });
      await this.save(state);
    });
  }

  async pause(reason: string): Promise<void> {
    return this.exclusiveWrite(async () => {
      this.requireLock();
      const state = await this.read();
      if (!state.paused) {
        state.paused = { reason: reason.slice(0, 100), at: new Date().toISOString() };
        await this.save(state);
      }
    });
  }

  private async exclusiveWrite<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.writing.then(fn);
    this.writing = current.catch(() => undefined);
    return current;
  }

  private requireLock(): void {
    if (!this.lock) throw new Error("COLLECTOR_NOT_STARTED");
  }

  private async read(): Promise<State> {
    const state: unknown = JSON.parse(await readFile(this.file, "utf8"));
    if (
      typeof state !== "object" ||
      state === null ||
      !("paused" in state) ||
      !("navigations" in state) ||
      !Array.isArray(state.navigations) ||
      !("attemptedJobs" in state) ||
      !Array.isArray(state.attemptedJobs) ||
      state.navigations.some(
        (item: unknown) =>
          typeof item !== "object" ||
          item === null ||
          !("key" in item) ||
          typeof item.key !== "string" ||
          !("at" in item) ||
          !Number.isFinite(Date.parse(String(item.at))),
      ) ||
      state.attemptedJobs.some(
        (item: unknown) =>
          typeof item !== "object" ||
          item === null ||
          !("key" in item) ||
          typeof item.key !== "string" ||
          !("at" in item) ||
          !Number.isFinite(Date.parse(String(item.at))),
      ) ||
      (state.paused !== null &&
        (typeof state.paused !== "object" ||
          !("reason" in state.paused) ||
          typeof state.paused.reason !== "string"))
    ) {
      throw new Error("COLLECTOR_GUARD_CORRUPT");
    }
    return state as State;
  }

  private async save(state: State): Promise<void> {
    this.requireLock();
    const tmp = join(this.directory, `guard-${randomUUID()}.tmp`);
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.file);
  }
}
