import { describe, expect, it } from "vitest";
import {
  isMedicalAnswerEvidence,
  parseMedicalMaterial,
  readMedicalMaterial,
} from "./medical-material";

describe("medical material usage", () => {
  it("keeps historical and invalid records out of new medical evidence", () => {
    for (const value of [
      undefined,
      {},
      { schemaVersion: "medical-material-v1", purpose: "OTHER" },
    ]) {
      expect(readMedicalMaterial(value)).toBeNull();
      expect(
        isMedicalAnswerEvidence({ type: "TEXT", structuredFacts: { medicalMaterial: value } }),
      ).toBe(false);
    }
  });

  it("requires specific scene usage and explicit privacy confirmation", () => {
    const scene = {
      schemaVersion: "medical-material-v1",
      purpose: "REAL_SCENE",
      sceneType: "ENVIRONMENT",
    };
    expect(() => parseMedicalMaterial(scene)).toThrow();
    expect(parseMedicalMaterial({ ...scene, privacyConfirmed: true }).sceneType).toBe(
      "ENVIRONMENT",
    );
    expect(readMedicalMaterial({ ...scene, privacyConfirmed: "true" })).toBeNull();
  });

  it("photos and archive material cannot substitute for answer evidence", () => {
    const policy = {
      schemaVersion: "medical-material-v1",
      purpose: "ANSWER_EVIDENCE",
      question: "  准备什么？  ",
    };
    expect(parseMedicalMaterial(policy).question).toBe("准备什么？");
    for (const type of ["TEXT", "DOCUMENT", "LINK"])
      expect(isMedicalAnswerEvidence({ type, structuredFacts: { medicalMaterial: policy } })).toBe(
        true,
      );
    expect(
      isMedicalAnswerEvidence({
        type: "IMAGE_REFERENCE",
        structuredFacts: { medicalMaterial: policy },
      }),
    ).toBe(false);
    expect(
      isMedicalAnswerEvidence({
        type: "TEXT",
        structuredFacts: { medicalMaterial: { ...policy, purpose: "ARCHIVE" } },
      }),
    ).toBe(false);
  });
});
