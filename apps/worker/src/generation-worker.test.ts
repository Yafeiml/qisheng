import { describe, expect, it } from "vitest";
import { generationExecutionSlots } from "./generation-worker";

describe("compatibility queue execution slots", () => {
  it("shares one ceiling across both queues and releases slots after errors", async () => {
    const execute = generationExecutionSlots(2);
    let active = 0;
    let peak = 0;
    const waiting: (() => void)[] = [];
    const calls = Array.from({ length: 5 }, (_, index) =>
      execute(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => waiting.push(resolve));
        active -= 1;
        if (index === 0) throw new Error("test failure");
        return index;
      }).catch(() => -1),
    );
    expect(active).toBe(2);
    while (waiting.length || active) {
      waiting.shift()?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await Promise.all(calls)).toEqual([-1, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(await execute(async () => "after error")).toBe("after error");
  });
});
