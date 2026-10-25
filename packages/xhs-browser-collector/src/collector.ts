import { randomUUID } from "node:crypto";
import { validateJobUrl } from "./security";
import type { LocalGuard } from "./store";
import type { Job, JobSource, NoteEvidence, NoteReader, Status } from "./types";

const HALT_STATUSES: Status[] = [
  "LOGIN_REQUIRED",
  "CHALLENGE_REQUIRED",
  "RISK_BLOCKED",
  "RATE_LIMITED",
  "PARSER_CHANGED",
];

/** Agent-facing service never returns accessUrl, leaseToken, body, images or raw metrics. */
export class Collector {
  private current: Job | null = null;
  private evidence: { handle: string; result: NoteEvidence } | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private reading = false;

  constructor(
    private readonly source: JobSource,
    private readonly guard: LocalGuard,
    private readonly reader: NoteReader,
  ) {}

  async status(): Promise<object> {
    return this.exclusive(async () => {
      const local = await this.guard.status();
      let remote: { paused: boolean; reason: string | null };
      try {
        remote = await this.source.status();
      } catch {
        return { ...local, serverOnline: false, jobHeld: Boolean(this.current) };
      }
      return {
        ...local,
        serverOnline: true,
        serverPaused: remote.paused,
        // Never include server-provided reason in model output: it might echo note content.
        jobHeld: Boolean(this.current),
      };
    });
  }

  async claim(): Promise<object> {
    return this.exclusive(async () => {
      if (this.current) {
        if (Date.parse(this.current.leaseExpiresAt) > Date.now()) {
          return this.visibleJob(this.current);
        }
        if (this.evidence || this.reading || (await this.guard.hasVisited(this.current))) {
          await this.guard.pause("STALE_NAVIGATION_LEASE");
          await this.reader.close().catch(() => undefined);
          await this.source.pause("STALE_NAVIGATION_LEASE").catch(() => undefined);
          return { status: "PAUSED" };
        }
        // Nothing was opened under this expired lease; the API may safely issue a fresh job.
        await this.reader.close();
        this.current = null;
      }
      const local = await this.guard.status();
      if (local.paused || local.hourRemaining === 0 || local.dayRemaining === 0) {
        return { status: local.paused ? "PAUSED" : "BUDGET_EXHAUSTED" };
      }
      if (local.cooldownRemainingMs > 0) return { status: "COOLDOWN" };
      const server = await this.source.status();
      if (server.paused) return { status: "SERVER_PAUSED" };
      const claimed = await this.source.claim();
      if (claimed.paused) return { status: "SERVER_PAUSED" };
      if (!claimed.job) return { status: "NO_JOB" };
      validateJobUrl(claimed.job.accessUrl);
      assertLease(claimed.job.leaseExpiresAt);
      if (await this.guard.hasVisited(claimed.job)) {
        await this.guard.pause("JOB_ALREADY_ATTEMPTED");
        await this.source.pause("JOB_ALREADY_ATTEMPTED").catch(() => undefined);
        return { status: "PAUSED" };
      }
      this.current = claimed.job;
      return this.visibleJob(claimed.job);
    });
  }

  async read(jobId: string): Promise<object> {
    return this.exclusive(async () => {
      const job = this.requireJob(jobId);
      if (this.evidence)
        return { status: this.evidence.result.status, evidenceHandle: this.evidence.handle };
      if ((await this.guard.status()).paused) throw new Error("COLLECTOR_PAUSED");
      const remote = await this.source.status();
      if (remote.paused) throw new Error("SERVER_PAUSED");
      const heartbeat = await this.source.heartbeat(job);
      if (heartbeat.paused) throw new Error("SERVER_PAUSED");
      assertLease(heartbeat.leaseExpiresAt);
      this.current = { ...job, leaseExpiresAt: heartbeat.leaseExpiresAt };
      try {
        await this.guard.reserve(job);
      } catch (error) {
        if (error instanceof Error && error.message === "JOB_ALREADY_ATTEMPTED") {
          await this.source.pause("JOB_ALREADY_ATTEMPTED").catch(() => undefined);
        }
        throw error;
      }
      let result: NoteEvidence;
      this.reading = true;
      try {
        result = await this.reader.read(job);
      } catch {
        // Access may already have happened. Stop until an operator confirms the browser is closed.
        await this.guard.pause("BROWSER_STATE_UNCERTAIN");
        await this.reader.close().catch(() => undefined);
        await this.source.pause("BROWSER_STATE_UNCERTAIN").catch(() => undefined);
        throw new Error("BROWSER_STATE_UNCERTAIN");
      } finally {
        this.reading = false;
      }
      this.evidence = { handle: randomUUID(), result };
      if (HALT_STATUSES.includes(result.status)) {
        await this.guard.pause(result.status);
        // Local pause is durable even when API is unavailable.
        await this.source.pause(result.status).catch(() => undefined);
      }
      return { status: result.status, evidenceHandle: this.evidence.handle };
    });
  }

  async commit(handle: string): Promise<object> {
    return this.exclusive(async () => {
      const job = this.current;
      const evidence = this.evidence;
      if (!job || !evidence || handle !== evidence.handle) {
        throw new Error("EVIDENCE_HANDLE_INVALID");
      }
      if (Date.parse(job.leaseExpiresAt) <= Date.now()) throw new Error("LEASE_EXPIRED");
      await this.source.evidence(job, evidence.result);
      this.evidence = null;
      this.current = null;
      return { status: "COMMITTED", jobId: job.id };
    });
  }

  async pause(): Promise<object> {
    return this.exclusive(async () => {
      await this.guard.pause("OPERATOR_REVIEW_REQUESTED");
      await this.reader.close().catch(() => undefined);
      await this.source.pause("OPERATOR_REVIEW_REQUESTED").catch(() => undefined);
      return { status: "PAUSED" };
    });
  }

  /** A cancelled request never clears the local pause or its reserved navigation budget. */
  async cancelRead(): Promise<void> {
    await this.guard.pause("MCP_REQUEST_CANCELLED");
    await this.reader.close().catch(() => undefined);
    await this.source.pause("MCP_REQUEST_CANCELLED").catch(() => undefined);
  }

  isReading(): boolean {
    return this.reading;
  }

  async close(): Promise<void> {
    await this.reader.close();
    await this.guard.stop();
  }

  private visibleJob(job: Job): object {
    return { status: "CLAIMED", jobId: job.id, kind: job.kind };
  }

  private requireJob(id: string): Job {
    if (!this.current || this.current.id !== id) throw new Error("JOB_NOT_CLAIMED");
    return this.current;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const running = this.busy.then(fn);
    this.busy = running.catch(() => undefined);
    return running;
  }
}

function assertLease(iso: string): void {
  // Enough time for a bounded page load and upload; uncertainty fails closed.
  if (!Number.isFinite(Date.parse(iso)) || Date.parse(iso) - Date.now() < 95_000) {
    throw new Error("LEASE_TOO_SHORT");
  }
}
