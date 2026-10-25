import { assetRecord } from "./material-assets";

export const MEDICAL_MATERIAL_PURPOSES = ["ANSWER_EVIDENCE", "REAL_SCENE", "ARCHIVE"] as const;
export const MEDICAL_SCENE_TYPES = [
  "ENVIRONMENT",
  "ROUTE",
  "OBJECT",
  "WORKSPACE",
  "OTHER",
] as const;
export type MedicalMaterial = Readonly<{
  schemaVersion: "medical-material-v1";
  purpose: (typeof MEDICAL_MATERIAL_PURPOSES)[number];
  sceneType?: (typeof MEDICAL_SCENE_TYPES)[number];
  question?: string;
  sourceNote?: string;
  privacyConfirmed?: boolean;
}>;

/** Unclassified historical records stay available for management, not medical generation. */
export function readMedicalMaterial(value: unknown): MedicalMaterial | null {
  const input = assetRecord(value);
  if (
    input.schemaVersion !== "medical-material-v1" ||
    !MEDICAL_MATERIAL_PURPOSES.includes(input.purpose as MedicalMaterial["purpose"]) ||
    (input.question !== undefined &&
      (typeof input.question !== "string" || input.question.length > 500)) ||
    (input.sourceNote !== undefined &&
      (typeof input.sourceNote !== "string" || input.sourceNote.length > 1000)) ||
    (input.privacyConfirmed !== undefined && typeof input.privacyConfirmed !== "boolean") ||
    (input.sceneType !== undefined &&
      !MEDICAL_SCENE_TYPES.includes(
        input.sceneType as NonNullable<MedicalMaterial["sceneType"]>,
      )) ||
    (input.purpose === "REAL_SCENE" && (!input.sceneType || input.privacyConfirmed !== true))
  )
    return null;
  return {
    schemaVersion: "medical-material-v1",
    purpose: input.purpose as MedicalMaterial["purpose"],
    ...(input.purpose === "REAL_SCENE"
      ? { sceneType: input.sceneType as MedicalMaterial["sceneType"], privacyConfirmed: true }
      : {}),
    ...(typeof input.question === "string" && input.question.trim()
      ? { question: input.question.trim() }
      : {}),
    ...(typeof input.sourceNote === "string" && input.sourceNote.trim()
      ? { sourceNote: input.sourceNote.trim() }
      : {}),
  };
}

export function parseMedicalMaterial(value: unknown): MedicalMaterial {
  const policy = readMedicalMaterial(value);
  if (!policy) throw new Error("Invalid medical material purpose or privacy confirmation");
  return policy;
}

export function isMedicalAnswerEvidence(material: { type: string; structuredFacts?: unknown }) {
  return (
    ["TEXT", "DOCUMENT", "LINK"].includes(material.type) &&
    readMedicalMaterial(assetRecord(material.structuredFacts).medicalMaterial)?.purpose ===
      "ANSWER_EVIDENCE"
  );
}
