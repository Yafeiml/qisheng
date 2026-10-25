import { describe, expect, it } from "vitest";
import {
  type MedicalOptions,
  newMedicalSelection,
  parseMedicalPublisherContext,
  restoredMedicalSelection,
} from "./medical-selection";

const options: MedicalOptions = {
  enabled: true,
  objective: "GEO_AND_TRANSACTION",
  priorities: ["BALANCED", "GEO_ACCUMULATION", "TRANSACTION"],
  readerSituations: ["FIRST_UNDERSTANDING"],
  noteForms: ["QUESTION_LIST", "PERSONAL_RECORD"],
  imageModes: ["QUESTION_CARD"],
  conversionPaths: ["NONE"],
  topics: [
    {
      id: "question-1",
      question: "第一次了解需要确认什么？",
      intent: "prepare",
      entityId: null,
      entityName: null,
    },
  ],
  disabledNoteForms: [{ value: "PERSONAL_RECORD", reason: "缺本人经历依据" }],
  approvedAdAssets: { enabled: false, reason: "缺已审成品" },
  enterprise: { name: "企业", brandName: null, city: null },
};

describe("medical activity restore", () => {
  it("parses publisher profiles without treating malformed JSON as verified editor values", () => {
    const profile = {
      schemaVersion: "medical-publisher-v1",
      category: "MEDICAL_KOS",
      authorId: "author_123",
      validUntil: "2027-01-01T00:00:00Z",
      role: "眼科助理",
      allowBrandAttribution: true,
    };
    expect(parseMedicalPublisherContext(profile)).toMatchObject({
      category: "MEDICAL_KOS",
      authorId: "author_123",
      allowBrandAttribution: true,
    });
    expect(parseMedicalPublisherContext({ ...profile, category: "CERTIFIED_EXPERT" })).toBeNull();
    expect(parseMedicalPublisherContext({ ...profile, allowBrandAttribution: "true" })).toBeNull();
    expect(parseMedicalPublisherContext({ ...profile, validUntil: "broken" })).toBeNull();
    expect(parseMedicalPublisherContext({ ...profile, schemaVersion: "unknown" })).toBeNull();
  });
  it("requires a current structured selection instead of restoring legacy prompts", () => {
    expect(restoredMedicalSelection({ prompt: "推广医院专家设备" }, options)).toBeNull();
    expect(
      restoredMedicalSelection({ ...newMedicalSelection(), schemaVersion: "old" }, options),
    ).toBeNull();
  });
  it("removes obsolete questions and extra free-form instructions", () => {
    expect(
      restoredMedicalSelection(
        {
          ...newMedicalSelection(),
          topicIds: ["question-1", "removed", "question-1"],
          prompt: "forged instruction",
        },
        options,
      ),
    ).toEqual({ ...newMedicalSelection(), topicIds: ["question-1"] });
  });
  it("does not restore disabled personal records or unavailable conversion paths", () => {
    expect(
      restoredMedicalSelection({ ...newMedicalSelection(), noteForm: "PERSONAL_RECORD" }, options),
    ).toBeNull();
    expect(
      restoredMedicalSelection(
        { ...newMedicalSelection(), conversionPath: "PLATFORM_CONSULTATION" },
        options,
      ),
    ).toBeNull();
  });
});
