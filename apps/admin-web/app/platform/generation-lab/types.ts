import type { MedicalSelection } from "../../lib/medical-selection";

export type Preset = {
  id: string;
  name: string;
  prompt: string;
  description: string;
  enabled: boolean;
  isDefault: boolean;
};
export type Options = {
  enterprises: { id: string; name: string; tenant: { name: string } }[];
  styles: {
    version: number;
    copyBasePrompt: string;
    imageBasePrompt: string;
    contentDirections: Preset[];
    imageStyles: Preset[];
  };
};
export type Copy = { title: string; body: string; hashtags: string[]; imagePrompt: string };
export type Call = {
  id: string;
  kind: string;
  modelId: string;
  providerId: string;
  status: string;
  latencyMs: number | null;
  request: Record<string, unknown>;
  usage: {
    estimatedCost?: number | null;
    inputUnits?: number;
    outputUnits?: number;
    note?: string;
    text?: string;
  } | null;
  error?: string;
};
export type Run = {
  id: string;
  title: string;
  status: string;
  action: string;
  enterpriseId: string;
  parentId: string | null;
  createdAt: string;
  reviewStatus: string;
  error: string | null;
  input: {
    selectionSnapshot?: MedicalSelection;
    medicalPlan?: MedicalSelection & { publishers: { membershipId: string }[] };
    brief: string;
    keywords: string;
    enterpriseName: string;
    copy?: Copy;
    generationStyle: {
      configurationVersion: number;
      copyBasePrompt: string;
      imageBasePrompt: string;
      contentDirection: { id: string; name: string; prompt: string };
      imageStyle: { id: string; name: string; prompt: string };
    };
    imageAssets: { artifactId: string; usage: string; description: string }[];
    retrieval: {
      query: string;
      hits: { materialId: string; materialTitle: string; snippet: string; score: number }[];
      images?: { artifactId: string; title: string; description: string; usage: string }[];
    };
    route: {
      text: { primary: { externalModelId: string } };
      image: { primary: { externalModelId: string } };
    };
  };
  result: {
    copy?: Copy;
    logo?: { composition: string };
    localAssessment?: { warnings: string[]; replacedBlocks: string[] };
  } | null;
  review: {
    decision?: string;
    message?: string;
    categories?: { code: string; message: string }[];
  } | null;
  assets: { id: string; kind: string; description: string; checksum: string }[];
  calls: Call[];
};
export const emptyCopy: Copy = { title: "", body: "", hashtags: [], imagePrompt: "" };
export const statusLabel: Record<string, string> = {
  CHECKING: "检查素材中",
  DRAFT: "待测试",
  QUEUED: "排队中",
  RUNNING: "处理中",
  SUCCEEDED: "已完成",
  FAILED: "未完成",
  INTERRUPTED: "已中断",
  NONE: "未审核",
  DONE: "已审核",
  PASS: "通过",
  REVIEW: "需人工确认",
  BLOCK: "不通过",
};
export const actionLabel: Record<string, string> = {
  COPY: "文案",
  IMAGE: "海报",
  FULL: "完整测试",
  RETRIEVAL: "素材检索",
  TEXT: "文案调用",
  REVIEW: "整体审核",
};
