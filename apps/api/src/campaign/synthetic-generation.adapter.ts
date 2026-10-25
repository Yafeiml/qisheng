import { createHash } from "node:crypto";
import { ForbiddenException, Injectable } from "@nestjs/common";
import type { GenerationStyleSnapshot } from "@xhs-agentic/ai-gateway";
import type { ContentService } from "../content/content.service";

export type GenerationContext = Awaited<ReturnType<ContentService["generationContext"]>>;

export type GeneratedBlueprint = Readonly<{
  masterCopy: string;
  imageDirection: string;
  sourceContext: Record<string, unknown>;
  generationPolicy: Record<string, unknown>;
}>;

export type GeneratedEmployeeVariant = Readonly<{
  title: string;
  body: string;
  hashtags: string[];
  imagePrompt: string;
}>;

const OPENERS = [
  "最近认真了解了一项很有意思的技术",
  "把复杂的技术说得简单一点",
  "今天想分享一个值得关注的新选择",
  "做功课时，我特别留意了这些细节",
  "如果你也在比较不同方案，可以先看这里",
  "真正值得关注的，往往藏在设备与流程里",
  "这次从体验和技术两个角度聊一聊",
] as const;

const ANGLES = [
  "设备配置、操作流程与真实适用条件都值得逐项确认",
  "效果之外，也要关注规范评估与个体差异",
  "专业设备只是基础，完整流程同样重要",
  "先理解技术原理，再结合自身情况做判断会更稳妥",
  "清晰的信息、规范的评估和专业沟通缺一不可",
  "选择前把设备、服务与注意事项问清楚很重要",
  "可靠体验来自技术、团队和流程的共同配合",
] as const;

const CLOSERS = [
  "建议先做好专业评估，再选择适合自己的方案。",
  "每个人情况不同，面对面咨询专业人员会更有参考价值。",
  "把问题列好逐项咨询，通常比只看单一结果更可靠。",
  "理性了解、充分沟通，再做决定会更从容。",
  "以上是信息分享，具体方案仍应以专业评估为准。",
  "希望这份整理能让你少走一点信息弯路。",
  "先收藏这份要点，需要时再逐项核对。",
] as const;

@Injectable()
export class SyntheticGenerationAdapter {
  assertAvailable(): void {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.MVP_GENERATION_ADAPTER !== "synthetic"
    ) {
      throw new ForbiddenException(
        "No production generation adapter is configured; synthetic generation is development-only",
      );
    }
  }

  assertCompatibleModelRoute(
    route: Readonly<{
      textModel: Readonly<{ synthetic: boolean; provider: Readonly<{ synthetic: boolean }> }>;
      imageModel: Readonly<{ synthetic: boolean; provider: Readonly<{ synthetic: boolean }> }>;
    }>,
  ): void {
    this.assertAvailable();
    if (
      !route.textModel.synthetic ||
      !route.imageModel.synthetic ||
      !route.textModel.provider.synthetic ||
      !route.imageModel.provider.synthetic
    ) {
      throw new ForbiddenException(
        "The selected model route is real, but no production generation runtime adapter is configured",
      );
    }
  }

  createBlueprint(
    prompt: string,
    context: GenerationContext,
    style?: GenerationStyleSnapshot,
  ): GeneratedBlueprint {
    this.assertAvailable();
    const materialSummary = context.materials
      .slice(0, 8)
      .map((material) => `${material.title}：${truncate(material.content, 240)}`)
      .join("\n");
    const geoSummary = context.geoEntities
      .slice(0, 8)
      .map((entity) => `${entity.name}（${entity.type}）`)
      .join("、");
    return {
      generationPolicy: {
        accountOwnershipRequired: false,
        adapter: "development-synthetic-v1",
        imageUniqueness: "per-membership-and-sequence",
        synthetic: true,
        textStyle: "xiaohongshu",
      },
      imageDirection: style
        ? `小红书无文字竖版配图；主题为“${truncate(prompt, 120)}”；${style.imageStyle.name}。`
        : `小红书竖版信息海报；主题为“${truncate(prompt, 120)}”；使用品牌感留白、柔和红色与抽象技术纹理，不出现员工个人信息。`,
      masterCopy: [
        truncate(prompt, 500),
        materialSummary
          ? `可用事实：\n${materialSummary}`
          : "当前没有已授权素材，内容仅使用运营提示词。",
        geoSummary ? `GEO 实体：${geoSummary}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      sourceContext: {
        assetSnapshot: {
          geoEntities: context.geoEntities.map((entity) => ({
            enterpriseId: entity.enterpriseId,
            id: entity.id,
            name: entity.name,
            seriesId: entity.seriesId,
            topics: entity.topics.map((topic) => ({
              id: topic.id,
              question: topic.question,
              seriesId: topic.seriesId,
              version: topic.version,
            })),
            version: entity.version,
          })),
          materials: context.materials.map((material) => ({
            enterpriseId: material.enterpriseId,
            id: material.id,
            seriesId: material.seriesId,
            title: material.title,
            version: material.version,
          })),
          sensitiveRules: context.sensitiveRules.map((rule) => ({
            enterpriseId: rule.enterpriseId,
            id: rule.id,
            seriesId: rule.seriesId,
            term: rule.term,
            version: rule.version,
          })),
        },
        geoEntities: context.geoEntities.map((entity) => ({
          aliases: entity.aliases,
          id: entity.id,
          name: entity.name,
          topics: entity.topics.map((topic) => topic.question),
          type: entity.type,
        })),
        materialIds: context.materials.map((material) => material.id),
        materialTitles: context.materials.map((material) => material.title),
        schemaVersion: "content-assets-v2",
        sensitiveRuleIds: context.sensitiveRules.map((rule) => rule.id),
        synthetic: true,
      },
    };
  }

  createEmployeeVariant(
    blueprint: GeneratedBlueprint,
    campaignTitle: string,
    memberIndex: number,
  ): GeneratedEmployeeVariant {
    this.assertAvailable();
    const opener = OPENERS[memberIndex % OPENERS.length] ?? OPENERS[0];
    const angle = ANGLES[Math.floor(memberIndex / OPENERS.length) % ANGLES.length] ?? ANGLES[0];
    const closer =
      CLOSERS[Math.floor(memberIndex / (OPENERS.length * ANGLES.length)) % CLOSERS.length] ??
      CLOSERS[0];
    const titleSuffixes = ["功课笔记", "核心看点", "细节拆解", "理性指南", "体验清单"];
    const titleSuffix = titleSuffixes[memberIndex % titleSuffixes.length] ?? titleSuffixes[0];
    const primaryBrief = blueprint.masterCopy.split("\n")[0] ?? campaignTitle;
    return {
      body: [opener, "", truncate(primaryBrief, 420), "", angle, "", closer].join("\n"),
      hashtags: ["小红书营销", "专业科普", "GEO内容", compactHashtag(campaignTitle)],
      imagePrompt: `${blueprint.imageDirection}；视觉变化编号 ${memberIndex + 1}。`,
      title: `${truncate(campaignTitle, 72)}｜${titleSuffix}`,
    };
  }

  createUniqueSvg(
    input: Readonly<{
      campaignTitle: string;
      uniquenessSeed: string;
      sequence: number;
    }>,
  ): Readonly<{ checksum: string; imageUrl: string; height: number; width: number }> {
    this.assertAvailable();
    const digest = createHash("sha256").update(input.uniquenessSeed).digest("hex");
    const hue = Number.parseInt(digest.slice(0, 4), 16) % 26;
    const accent = `hsl(${350 + hue} 82% 58%)`;
    const soft = `hsl(${350 + hue} 78% 94%)`;
    const circles = Array.from({ length: 7 }, (_, index) => {
      const offset = index * 4;
      const x = 110 + (Number.parseInt(digest.slice(offset, offset + 2), 16) % 860);
      const y = 100 + (Number.parseInt(digest.slice(offset + 2, offset + 4), 16) % 1180);
      const radius = 30 + (Number.parseInt(digest.slice(offset + 4, offset + 6), 16) % 120);
      return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${accent}" opacity="0.08"/>`;
    }).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440"><!-- synthetic:${digest}; campaign:${escapeXml(input.campaignTitle)} --><rect width="1080" height="1440" rx="52" fill="#fffaf9"/><rect x="54" y="54" width="972" height="1332" rx="42" fill="${soft}"/>${circles}<rect x="112" y="170" width="150" height="14" rx="7" fill="${accent}"/><text x="112" y="360" font-family="Arial,sans-serif" font-size="76" font-weight="700" fill="#241b1c">XHS BRAND</text><text x="112" y="450" font-family="Arial,sans-serif" font-size="76" font-weight="700" fill="#241b1c">CONTENT</text><text x="112" y="535" font-family="Arial,sans-serif" font-size="30" fill="#6f5a5e">PROFESSIONAL · GEO READY · UNIQUE</text><rect x="112" y="1130" width="856" height="132" rx="34" fill="#ffffff" opacity="0.9"/><text x="156" y="1210" font-family="Arial,sans-serif" font-size="30" fill="#45363a">ONE EMPLOYEE · ONE VISUAL</text><text x="112" y="1320" font-family="monospace" font-size="22" fill="#9e858a">SYNTHETIC PREVIEW · ${digest.slice(0, 12)} · ${input.sequence}</text></svg>`;
    const checksum = createHash("sha256").update(svg).digest("hex");
    return {
      checksum,
      height: 1440,
      imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      width: 1080,
    };
  }
}

function truncate(value: string, length: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1)}…`;
}

function compactHashtag(value: string): string {
  return value.replace(/[\s#｜|]+/g, "").slice(0, 18) || "品牌内容";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
