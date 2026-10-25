import { describe, expect, it } from "vitest";
import { labCost } from "./generation-lab";

describe("lab cost visibility", () => {
  it("does not call an unknown price or unknown token usage free", () => {
    expect(labCost({}, "TEXT", { inputUnits: 100, outputUnits: 20 })).toBeNull();
    expect(
      labCost({ inputCostPerMillionUnits: 2, outputCostPerMillionUnits: 5 }, "TEXT", {}),
    ).toBeNull();
    expect(labCost({}, "IMAGE")).toBeNull();
  });
  it("estimates only from known billing inputs, including explicitly configured zero", () => {
    expect(
      labCost({ inputCostPerMillionUnits: 2, outputCostPerMillionUnits: 5 }, "TEXT", {
        inputUnits: 1000,
        outputUnits: 200,
      }),
    ).toBeCloseTo(0.003);
    expect(labCost({ imageCost: 0.08 }, "IMAGE")).toBe(0.08);
    expect(labCost({ imageCost: 0 }, "IMAGE")).toBe(0);
  });
});
