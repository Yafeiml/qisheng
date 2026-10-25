import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queues = vi.hoisted(
  () =>
    new Map<
      string,
      {
        add: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        getJobCounts: ReturnType<typeof vi.fn>;
        isPaused: ReturnType<typeof vi.fn>;
        getWorkersCount: ReturnType<typeof vi.fn>;
      }
    >(),
);
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(name: string) {
      const mock = {
        add: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
        getJobCounts: vi
          .fn()
          .mockResolvedValue({ active: 1, completed: 2, delayed: 3, failed: 4, waiting: 5 }),
        isPaused: vi.fn().mockResolvedValue(false),
        getWorkersCount: vi.fn().mockResolvedValue(1),
      };
      queues.set(name, mock);
      Object.assign(this, mock);
    }
  },
}));
vi.mock("@xhs-agentic/observability", () => ({ writeStructuredLog: vi.fn() }));

import { GenerationQueueService } from "./generation-queue.service";

beforeEach(() => {
  queues.clear();
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379/15");
  vi.stubEnv("REDIS_PREFIX", "offline-test");
});
afterEach(() => vi.unstubAllEnvs());
describe("medical generation queue routing", () => {
  it("keeps legacy jobs on their existing queue", async () => {
    const service = new GenerationQueueService();
    await service.enqueueRun({ generationRunId: "legacy", queueVersion: 1, tenantId: "tenant" });
    expect(queues.has("campaign-generation-v1")).toBe(true);
    expect(queues.has("campaign-generation-medical-v1")).toBe(false);
  });
  it("routes both initial generation and employee retries to the dedicated capable queue", async () => {
    const service = new GenerationQueueService();
    const data = { generationRunId: "medical", queueVersion: 3, tenantId: "tenant", medical: true };
    await service.enqueueRun(data);
    await service.enqueueWorkItem({ ...data, reservationVersion: 2, workItemId: "item" });
    expect(
      queues.get("campaign-generation-medical-v1")?.add.mock.calls.map(([name]) => name),
    ).toEqual(["orchestrate-run", "generate-employee"]);
    expect(queues.has("campaign-generation-v1")).toBe(false);
  });
  it("reports both queues and closes both connections", async () => {
    const service = new GenerationQueueService();
    expect(await service.getOperationalMetrics()).toEqual({
      active: 2,
      completed: 4,
      delayed: 6,
      failed: 8,
      waiting: 10,
      paused: false,
      workers: 1,
    });
    expect((await service.getOperationalMetrics(true)).waiting).toBe(5);
    await service.onModuleDestroy();
    for (const queue of queues.values()) expect(queue.close).toHaveBeenCalledOnce();
  });
  it.each(["campaign-generation-v1", "campaign-generation-medical-v1"])(
    "does not hide a missing consumer on %s behind the other generation queue",
    async (name) => {
      const service = new GenerationQueueService();
      await service.getOperationalMetrics();
      queues.get(name)?.getWorkersCount.mockResolvedValue(0);
      expect((await service.getOperationalMetrics()).workers).toBe(0);
      expect((await service.getOperationalMetrics(name.endsWith("medical-v1"))).workers).toBe(0);
      expect((await service.getOperationalMetrics(!name.endsWith("medical-v1"))).workers).toBe(1);
    },
  );
});
