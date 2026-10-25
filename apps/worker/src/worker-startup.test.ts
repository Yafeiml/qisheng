import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  settings: vi.fn(),
  ensureBucket: vi.fn(),
  queues: [] as { close: ReturnType<typeof vi.fn> }[],
  workers: [] as { close: ReturnType<typeof vi.fn> }[],
  handles: new Set<object>(),
  queueFailure: 0,
  workerFailure: 0,
  readyFailure: false,
  closeFailure: false,
}));
vi.mock("@xhs-agentic/database", async (original) => ({
  ...(await original<object>()),
  PrismaClient: class {
    $connect = mocks.connect;
    $disconnect = mocks.disconnect;
  },
}));
vi.mock("@xhs-agentic/object-storage", async (original) => ({
  ...(await original<object>()),
  createObjectStorage: () => ({ ensureBucket: mocks.ensureBucket }),
}));
vi.mock("./platform-settings", () => ({ loadWorkerPlatformSettings: mocks.settings }));
vi.mock("bullmq", async (original) => ({
  ...(await original<object>()),
  Queue: class {
    name: string;
    constructor(name: string) {
      if (mocks.queueFailure === mocks.queues.length + 1) throw new Error("QUEUE_CONSTRUCTOR");
      this.name = name;
      mocks.queues.push(this);
      mocks.handles.add(this);
    }
    async waitUntilReady() {
      if (mocks.readyFailure) throw new Error("REDIS_NOT_READY");
    }
    close = vi.fn(async () => {
      mocks.handles.delete(this);
      if (mocks.closeFailure) throw new Error("QUEUE_CLOSE_FAILED");
    });
  },
  Worker: class {
    constructor() {
      if (mocks.workerFailure === mocks.workers.length + 1) throw new Error("WORKER_CONSTRUCTOR");
      mocks.workers.push(this);
      mocks.handles.add(this);
    }
    on = vi.fn();
    async waitUntilReady() {}
    close = vi.fn(async () => {
      mocks.handles.delete(this);
    });
  },
}));

import { startGenerationLabWorker } from "./generation-lab-worker";
import { startGenerationWorker } from "./generation-worker";
import { startMaterialIngestionWorker } from "./material-ingestion-worker";

describe("worker startup resource ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.ensureBucket.mockResolvedValue(undefined);
    mocks.settings.mockResolvedValue({
      generation: { concurrency: 1, heartbeatIntervalMs: 1000, leaseDurationMs: 10000 },
      material: { concurrency: 1 },
      storage: {},
      contentSafety: { mode: "DISABLED", verified: false },
    });
    mocks.queues.length = 0;
    mocks.workers.length = 0;
    mocks.handles.clear();
    mocks.queueFailure = 0;
    mocks.workerFailure = 0;
    mocks.readyFailure = false;
    mocks.closeFailure = false;
    vi.stubEnv("GENERATION_DELIVERY_MODE", "DEVELOPMENT");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("REDIS_PREFIX", "startup-test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([startGenerationWorker, startMaterialIngestionWorker, startGenerationLabWorker])(
    "disconnects a Prisma client whose connection failed: %s",
    async (start) => {
      mocks.connect.mockRejectedValue(new Error("DATABASE_NOT_READY"));
      await expect(start()).rejects.toThrow("DATABASE_NOT_READY");
      expect(mocks.disconnect).toHaveBeenCalledOnce();
      expect(mocks.handles.size).toBe(0);
    },
  );

  it.each([
    { mode: "DISABLED", verified: false },
    { mode: "DISABLED", verified: true },
    { mode: "HTTP", verified: false },
  ])("keeps the production safety gate before storage and consumers: %j", async (contentSafety) => {
    vi.stubEnv("GENERATION_DELIVERY_MODE", "PRODUCTION");
    const settings = await mocks.settings();
    mocks.settings.mockResolvedValue({ ...settings, contentSafety });
    await expect(startGenerationWorker()).rejects.toThrow(
      "Production generation requires verified model or HTTP content safety",
    );
    expect(mocks.ensureBucket).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.queues).toHaveLength(0);
    expect(mocks.workers).toHaveLength(0);
    expect(mocks.handles.size).toBe(0);
  });

  it("does not load unused content-safety configuration for the material consumer", async () => {
    mocks.ensureBucket.mockRejectedValue(new Error("STORAGE_NOT_READY"));
    await expect(startMaterialIngestionWorker()).rejects.toThrow("STORAGE_NOT_READY");
    expect(mocks.settings).toHaveBeenCalledWith(expect.anything(), { contentSafety: false });
    expect(mocks.handles.size).toBe(0);
  });

  it.each([startGenerationWorker, startMaterialIngestionWorker])(
    "disconnects Prisma after platform settings or storage fail: %s",
    async (start) => {
      mocks.settings.mockRejectedValueOnce(new Error("SETTINGS_UNAVAILABLE"));
      await expect(start()).rejects.toThrow("SETTINGS_UNAVAILABLE");
      mocks.ensureBucket.mockRejectedValueOnce(new Error("STORAGE_UNAVAILABLE"));
      await expect(start()).rejects.toThrow("STORAGE_UNAVAILABLE");
      expect(mocks.disconnect).toHaveBeenCalledTimes(2);
      expect(mocks.handles.size).toBe(0);
    },
  );

  it("closes an earlier queue when the second queue constructor fails", async () => {
    mocks.queueFailure = 2;
    await expect(startGenerationWorker()).rejects.toThrow("QUEUE_CONSTRUCTOR");
    expect(mocks.queues).toHaveLength(1);
    expect(mocks.queues[0]?.close).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.handles.size).toBe(0);
  });

  it.each([startGenerationWorker, startMaterialIngestionWorker])(
    "closes queues when worker construction fails: %s",
    async (start) => {
      mocks.workerFailure = 1;
      await expect(start()).rejects.toThrow("WORKER_CONSTRUCTOR");
      expect(mocks.queues.length).toBeGreaterThan(0);
      expect(mocks.handles.size).toBe(0);
      expect(mocks.disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each([startGenerationWorker, startMaterialIngestionWorker])(
    "closes every partial consumer after readiness rejects, even if one close fails: %s",
    async (start) => {
      mocks.readyFailure = true;
      mocks.closeFailure = true;
      await expect(start()).rejects.toThrow("REDIS_NOT_READY");
      expect(mocks.handles.size).toBe(0);
      for (const worker of mocks.workers) expect(worker.close).toHaveBeenCalledWith(true);
      expect(mocks.disconnect).toHaveBeenCalledOnce();
    },
  );
});
