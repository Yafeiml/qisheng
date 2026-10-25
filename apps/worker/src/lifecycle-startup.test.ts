import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generation: vi.fn(),
  material: vi.fn(),
  lab: vi.fn(),
  generationClose: vi.fn(),
  materialClose: vi.fn(),
  labClose: vi.fn(),
  notificationsRun: vi.fn(),
  notificationsClose: vi.fn(),
  databaseEnd: vi.fn(),
  log: vi.fn(),
}));
vi.mock("./generation-worker", () => ({ startGenerationWorker: mocks.generation }));
vi.mock("./generation-lab-worker", () => ({ startGenerationLabWorker: mocks.lab }));
vi.mock("./material-ingestion-worker", () => ({ startMaterialIngestionWorker: mocks.material }));
vi.mock("./employee-notification-worker", () => ({
  EmployeeNotificationProcessor: class {
    run = mocks.notificationsRun;
    close = mocks.notificationsClose;
  },
}));
vi.mock("@xhs-agentic/observability", () => ({
  postgresConnectionStringWithUtcSession: (value: string) => value,
  writeStructuredLog: mocks.log,
}));
vi.mock("pg", () => ({
  Pool: class {
    end = mocks.databaseEnd;
    async connect() {
      return {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined,
      };
    }
  },
}));

describe("co-located Worker lifecycle", () => {
  const previousExitCode = process.exitCode;
  const previousArgv = [...process.argv];
  let previousSignals: Set<(signal: NodeJS.Signals) => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    previousSignals = new Set(process.listeners("SIGTERM"));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/dev_startup");
    vi.stubEnv("GENERATION_EXECUTION_MODE", "queue");
    vi.stubEnv("MATERIAL_INGESTION_EXECUTION_MODE", "queue");
    vi.stubEnv("LIFECYCLE_INTERVAL_MS", "30000");
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => undefined);
    process.exitCode = undefined;
    mocks.generation.mockResolvedValue({ close: mocks.generationClose });
    mocks.material.mockResolvedValue({ close: mocks.materialClose });
    mocks.lab.mockResolvedValue({ close: mocks.labClose });
    mocks.generationClose.mockResolvedValue(undefined);
    mocks.materialClose.mockResolvedValue(undefined);
    mocks.labClose.mockResolvedValue(undefined);
    mocks.notificationsRun.mockResolvedValue({});
    mocks.notificationsClose.mockResolvedValue(undefined);
    mocks.databaseEnd.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    const stop = signal();
    if (stop) {
      stop("SIGTERM");
      await vi.waitFor(() => expect(mocks.databaseEnd).toHaveBeenCalledOnce());
    }
    process.exitCode = previousExitCode;
    process.argv.splice(0, process.argv.length, ...previousArgv);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function signal() {
    return process.listeners("SIGTERM").find((listener) => !previousSignals.has(listener));
  }

  async function boot() {
    await import("./lifecycle.js");
    await vi.waitFor(() => expect(mocks.notificationsRun).toHaveBeenCalledOnce());
    expect(process.exitCode).toBeUndefined();
  }

  it("keeps material and Lab available while generation startup is blocked by its safety gate", async () => {
    mocks.generation.mockRejectedValue(
      new Error("Production generation requires verified model or HTTP content safety"),
    );
    await boot();
    expect(mocks.material).toHaveBeenCalledOnce();
    expect(mocks.lab).toHaveBeenCalledOnce();
    expect(mocks.generationClose).not.toHaveBeenCalled();
    expect(mocks.materialClose).not.toHaveBeenCalled();
    expect(mocks.labClose).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "worker.component.start.error",
        fields: expect.objectContaining({ component: "generation" }),
      }),
    );
  });

  it("keeps the generator and Lab available when material storage is not configured", async () => {
    mocks.material.mockRejectedValue(new Error("MATERIAL_STORAGE_NOT_READY"));
    await boot();
    expect(mocks.generation).toHaveBeenCalledOnce();
    expect(mocks.lab).toHaveBeenCalledOnce();
    expect(mocks.generationClose).not.toHaveBeenCalled();
    expect(mocks.labClose).not.toHaveBeenCalled();
  });

  it("retries only missing components and starts them after their configuration is completed", async () => {
    mocks.generation.mockRejectedValueOnce(new Error("SAFETY_NOT_READY"));
    mocks.material.mockRejectedValueOnce(new Error("STORAGE_NOT_READY"));
    await boot();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.generation).toHaveBeenCalledTimes(2);
    expect(mocks.material).toHaveBeenCalledTimes(2);
    expect(mocks.lab).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.generation).toHaveBeenCalledTimes(2);
    expect(mocks.material).toHaveBeenCalledTimes(2);
    expect(mocks.lab).toHaveBeenCalledOnce();
    expect(mocks.notificationsRun).toHaveBeenCalledTimes(3);
  });

  it("retries Lab failures without closing healthy consumers", async () => {
    mocks.lab.mockRejectedValue(new Error("LAB_DATABASE_NOT_READY"));
    await boot();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.lab).toHaveBeenCalledTimes(2);
    expect(mocks.generation).toHaveBeenCalledOnce();
    expect(mocks.material).toHaveBeenCalledOnce();
    expect(mocks.generationClose).not.toHaveBeenCalled();
    expect(mocks.materialClose).not.toHaveBeenCalled();
  });

  it("does not overlap retry ticks while a component is still starting", async () => {
    let release: (handle: { close: typeof mocks.generationClose }) => void = () => {};
    const pending = new Promise<{ close: typeof mocks.generationClose }>((resolve) => {
      release = resolve;
    });
    mocks.generation
      .mockRejectedValueOnce(new Error("SAFETY_NOT_READY"))
      .mockImplementationOnce(() => pending);
    await boot();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.generation).toHaveBeenCalledTimes(2);
    expect(mocks.notificationsRun).toHaveBeenCalledOnce();
    release({ close: mocks.generationClose });
    await vi.waitFor(() => expect(mocks.notificationsRun).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.generation).toHaveBeenCalledTimes(2);
  });

  it("SIGTERM during startup closes a late handle and cannot create a retry timer", async () => {
    let release: (handle: { close: typeof mocks.generationClose }) => void = () => {};
    mocks.generation.mockReturnValue(
      new Promise<{ close: typeof mocks.generationClose }>((resolve) => {
        release = resolve;
      }),
    );
    await import("./lifecycle.js");
    await vi.waitFor(() => expect(mocks.lab).toHaveBeenCalledOnce());
    const stop = signal();
    expect(stop).toBeTypeOf("function");
    stop?.("SIGTERM");
    expect(mocks.databaseEnd).not.toHaveBeenCalled();
    release({ close: mocks.generationClose });
    await vi.waitFor(() => expect(mocks.databaseEnd).toHaveBeenCalledOnce());
    expect(mocks.generationClose).toHaveBeenCalledOnce();
    expect(mocks.materialClose).toHaveBeenCalledOnce();
    expect(mocks.labClose).toHaveBeenCalledOnce();
    expect(mocks.notificationsRun).not.toHaveBeenCalled();
    expect(signal()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.generation).toHaveBeenCalledOnce();
    expect(mocks.material).toHaveBeenCalledOnce();
    expect(mocks.lab).toHaveBeenCalledOnce();
  });

  it("closes every component once even when another close fails or shutdown is requested twice", async () => {
    await boot();
    mocks.generationClose.mockRejectedValue(new Error("GENERATOR_CLOSE_FAILED"));
    const stop = signal();
    stop?.("SIGTERM");
    stop?.("SIGTERM");
    await vi.waitFor(() => expect(mocks.databaseEnd).toHaveBeenCalledOnce());
    expect(mocks.generationClose).toHaveBeenCalledOnce();
    expect(mocks.materialClose).toHaveBeenCalledOnce();
    expect(mocks.labClose).toHaveBeenCalledOnce();
    expect(mocks.notificationsClose).toHaveBeenCalledOnce();
  });

  it("still rejects unsafe global production configuration before starting any component", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GENERATION_DELIVERY_MODE", "DEVELOPMENT");
    await expect(import("./lifecycle.js")).rejects.toThrow(
      "Unsafe production worker configuration",
    );
    expect(mocks.generation).not.toHaveBeenCalled();
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.lab).not.toHaveBeenCalled();
  });

  it("also closes the one-shot lifecycle when notification processing fails", async () => {
    process.argv.push("--once");
    mocks.notificationsRun.mockRejectedValue(new Error("NOTIFICATION_DATABASE_FAILED"));
    await import("./lifecycle.js");
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(mocks.databaseEnd).toHaveBeenCalledOnce();
    expect(mocks.notificationsClose).toHaveBeenCalledOnce();
    expect(mocks.generation).not.toHaveBeenCalled();
    expect(mocks.lab).not.toHaveBeenCalled();
  });
});
