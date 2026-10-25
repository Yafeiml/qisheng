import type { GeneratedEmployeeVariant } from "./generation-adapter";
import type { GenerationStyleSnapshot } from "./generation-style";
import type { FrozenImageAsset } from "./material-assets";
import type { MedicalPlan } from "./medical-plan";
import type { IndustryGenerationGuidanceSnapshot } from "./poster-planning";

export type GenerationLabAction = "COPY" | "IMAGE" | "FULL";
export type GenerationLabInput = {
  medicalPlan?: MedicalPlan;
  industryGuidance?: IndustryGenerationGuidanceSnapshot;
  brief: string;
  keywords: string;
  enterpriseName: string;
  generationStyle: GenerationStyleSnapshot;
  materialSummary: string;
  geoSummary: string;
  sensitiveRuleSummary: string;
  sensitiveRules: {
    term: string;
    severity: "BLOCK" | "WARNING" | "NOTICE";
    riskType: string;
    replacementSuggestion: string | null;
  }[];
  sourceContext: Record<string, unknown>;
  imageAssets: FrozenImageAsset[];
  retrieval: {
    query: string;
    hits: { materialId: string; materialTitle: string; snippet: string; score: number }[];
    images?: {
      artifactId: string;
      materialId: string;
      title: string;
      description: string;
      usage: "REFERENCE" | "LOGO";
    }[];
  };
  copy?: GeneratedEmployeeVariant;
  seed: string;
  route: unknown;
};

/** Unknown provider usage/prices are never displayed as a free call. */
export function labCost(
  pricing: {
    imageCost?: number;
    inputCostPerMillionUnits?: number;
    outputCostPerMillionUnits?: number;
  },
  kind: string,
  usage?: { inputUnits?: number; outputUnits?: number },
): number | null {
  if (kind === "IMAGE") return pricing.imageCost ?? null;
  if (
    pricing.inputCostPerMillionUnits === undefined ||
    pricing.outputCostPerMillionUnits === undefined ||
    usage?.inputUnits === undefined ||
    usage.outputUnits === undefined
  )
    return null;
  return (
    (usage.inputUnits * pricing.inputCostPerMillionUnits +
      usage.outputUnits * pricing.outputCostPerMillionUnits) /
    1_000_000
  );
}
