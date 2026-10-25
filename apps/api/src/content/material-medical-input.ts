import { isDeepStrictEqual } from "node:util";
import { ConflictException } from "@nestjs/common";
import {
  type MedicalMaterial,
  parseMedicalMaterial,
  readMedicalMaterial,
} from "@xhs-agentic/ai-gateway";

export function medicalMaterialFacts(
  input: {
    medicalMaterial?: unknown;
    structuredFacts?: Record<string, unknown>;
    authorizationConfirmed: boolean;
  },
  type: string,
  previousFacts?: unknown,
): Record<string, unknown> | undefined {
  const previous = record(previousFacts);
  const facts = { ...previous, ...input.structuredFacts };
  const supplied = input.structuredFacts?.medicalMaterial;
  let classification: MedicalMaterial | null | undefined;
  try {
    const nested = supplied === undefined ? undefined : parseMedicalMaterial(supplied);
    const top =
      input.medicalMaterial === undefined ? undefined : parseMedicalMaterial(input.medicalMaterial);
    if (nested && top && !isDeepStrictEqual(nested, top))
      throw new Error("Medical material classifications conflict");
    classification = top ?? nested ?? readMedicalMaterial(previous.medicalMaterial);
  } catch {
    throw new ConflictException("医疗素材用途无效或与结构化资料不一致，请重新选择");
  }
  if (classification) {
    if (input.authorizationConfirmed !== true)
      throw new ConflictException("请确认素材归属与使用授权");
    if (classification.purpose === "REAL_SCENE") {
      if (
        type !== "IMAGE_REFERENCE" ||
        !classification.sceneType ||
        !classification.privacyConfirmed
      )
        throw new ConflictException("实拍素材需上传图片、选择场景，并确认已处理肖像与隐私");
    } else if (
      classification.purpose === "ANSWER_EVIDENCE" &&
      !["TEXT", "DOCUMENT", "LINK"].includes(type)
    ) {
      throw new ConflictException("问题依据需使用文本、文档或来源链接，图片只能作为可选配图");
    }
    facts.medicalMaterial = classification;
  }
  return Object.keys(facts).length ? facts : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
