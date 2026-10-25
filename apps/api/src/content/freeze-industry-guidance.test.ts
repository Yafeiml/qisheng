import { defaultGenerationStyles, type GenerationStyleSnapshot } from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";
import { describe, expect, it, vi } from "vitest";
import { freezeGenerationInput, freezeIndustryGenerationGuidance } from "./freeze-generation-input";

describe("frozen industry guidance", () => {
  it("captures the selected enterprise industry without a live reference to later edits", async () => {
    const row = {
      name: "医疗健康",
      generationGuidance: "原行业规则",
      updatedAt: new Date("2026-10-10T00:00:00Z"),
    };
    const findUnique = vi.fn().mockResolvedValue(row);
    const database = { industry: { findUnique } } as unknown as Pick<
      Prisma.TransactionClient,
      "industry"
    >;
    const frozen = await freezeIndustryGenerationGuidance(database, "医疗健康");
    row.generationGuidance = "之后修改的规则";
    expect(frozen).toEqual({
      name: "医疗健康",
      generationGuidance: "原行业规则",
      updatedAt: "2026-10-10T00:00:00.000Z",
    });
    expect((await freezeIndustryGenerationGuidance(database, "医疗健康"))?.generationGuidance).toBe(
      "之后修改的规则",
    );
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: "医疗健康" } }),
    );
    const defaults = defaultGenerationStyles();
    const style: GenerationStyleSnapshot = {
      schemaVersion: 1,
      configurationVersion: 1,
      copyBasePrompt: defaults.copyBasePrompt,
      imageBasePrompt: defaults.imageBasePrompt,
      contentDirection: { id: "", name: "小红书分享", prompt: "" },
      imageStyle: { id: "", name: "小红书配图", prompt: "" },
    };
    const input = freezeGenerationInput(
      { materials: [], geoEntities: [], sensitiveRules: [] },
      { hits: [], query: "主体身份", contextCharacters: 0, strategyVersion: "test" },
      style,
      frozen,
    );
    expect(JSON.parse(JSON.stringify(input))).toMatchObject({
      industryGuidance: frozen,
      sourceContext: { industryGuidance: frozen },
    });
  });
  it("does not guess a profile for missing or historical industry names", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const database = { industry: { findUnique } } as unknown as Pick<
      Prisma.TransactionClient,
      "industry"
    >;
    expect(await freezeIndustryGenerationGuidance(database, null)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(await freezeIndustryGenerationGuidance(database, "历史自定义行业")).toBeNull();
  });
});
