import { BadRequestException } from "@nestjs/common";

export const MAX_CAMPAIGN_FOCUS = 20;

type Focus = {
  id: string;
  name: string;
  aliases: string[];
};

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// Match names/aliases, not generic intents such as “科普认知”. Do not infer identity
// from an industry keyword or silently include every configured entity.
export function matchesPromotionFocus(prompt: string, entity: Pick<Focus, "name" | "aliases">) {
  const text = normalize(prompt);
  return [entity.name, ...entity.aliases].some((value) => {
    const term = normalize(value);
    if (term.length < 2) return false;
    if (/^[a-z0-9 ._-]+$/.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "u").test(text);
    }
    return text.includes(term);
  });
}

export function selectPromotionFocus<T extends Focus>(
  entities: readonly T[],
  prompt: string,
  selectedIds?: readonly string[],
): T[] {
  if (selectedIds === undefined) {
    return entities
      .filter((entity) => matchesPromotionFocus(prompt, entity))
      .slice(0, MAX_CAMPAIGN_FOCUS);
  }
  if (selectedIds.length > MAX_CAMPAIGN_FOCUS || new Set(selectedIds).size !== selectedIds.length) {
    throw new BadRequestException("宣传重点最多选择 20 项，且不能重复。");
  }
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return selectedIds.map((id) => {
    const entity = byId.get(id);
    if (!entity)
      throw new BadRequestException("所选宣传重点已停用、被更新或不属于当前企业，请重新选择。");
    return entity;
  });
}

export function effectivePromotionFocus<T extends { key: string; enterpriseId: string | null }>(
  rows: readonly T[],
  enterpriseId: string,
): T[] {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (row.enterpriseId === enterpriseId || result.get(row.key)?.enterpriseId !== enterpriseId) {
      result.set(row.key, row);
    }
  }
  return [...result.values()];
}

export type FocusRecommendation = {
  name: string;
  aliases: string[];
  type: "BRAND" | "DOCTOR" | "DEVICE" | "SERVICE";
  materialId: string;
  materialTitle: string;
  enterpriseId: string | null;
  evidence: string;
};

export function recommendPromotionFocus(
  sources: readonly {
    id: string;
    title: string;
    enterpriseId: string | null;
    analysis: unknown;
    medical?: boolean;
  }[],
  existing: readonly Pick<Focus, "name" | "aliases">[],
): FocusRecommendation[] {
  const known = new Set(existing.flatMap((item) => [item.name, ...item.aliases]).map(normalize));
  const result: FocusRecommendation[] = [];
  for (const material of sources) {
    const analysis = record(material.analysis);
    if (!Array.isArray(analysis.entities)) continue;
    for (const value of analysis.entities) {
      const entity = record(value);
      const name = typeof entity.name === "string" ? entity.name.trim() : "";
      const evidence = typeof entity.evidence === "string" ? entity.evidence.trim() : "";
      if (material.medical && ["PERSON", "PRODUCT"].includes(String(entity.kind))) continue;
      const kindTypes: Record<string, FocusRecommendation["type"]> = {
        PERSON: "DOCTOR",
        PRODUCT: "DEVICE",
        BRAND: "BRAND",
        PROJECT: "SERVICE",
      };
      const type =
        typeof entity.kind === "string" && Object.hasOwn(kindTypes, entity.kind)
          ? kindTypes[entity.kind]
          : undefined;
      if (
        !type ||
        name.length < 2 ||
        name.length > 120 ||
        !evidence ||
        !["CONTENT", "SUPPLEMENT", "IMAGE_TEXT"].includes(String(entity.source))
      )
        continue;
      const aliases = Array.isArray(entity.aliases)
        ? entity.aliases
            .filter(
              (alias): alias is string =>
                typeof alias === "string" && alias.trim().length > 1 && alias.length <= 120,
            )
            .slice(0, 20)
        : [];
      const names = [name, ...aliases].map(normalize);
      if (names.some((item) => known.has(item))) continue;
      for (const item of names) known.add(item);
      result.push({
        name,
        aliases,
        type,
        materialId: material.id,
        materialTitle: material.title,
        enterpriseId: material.enterpriseId,
        evidence: evidence.slice(0, 300),
      });
      if (result.length >= 100) return result;
    }
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
