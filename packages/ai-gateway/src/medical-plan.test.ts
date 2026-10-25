import { describe, expect, it } from "vitest";
import {
  assertMedicalPublisher,
  type MedicalPlan,
  medicalOrdinalForMember,
  medicalPlanForOrdinal,
  medicalPublisherFor,
  medicalPublishingSafetyContext,
  readMedicalPlan,
} from "./medical-plan";

const ordinary = {
  schemaVersion: "medical-publisher-v1" as const,
  category: "ORDINARY" as const,
  allowBrandAttribution: false,
  allowPlatformConsultation: false,
};
const plan: MedicalPlan = {
  schemaVersion: "medical-selection-v1",
  executionVersion: "medical-plan-v1",
  objective: "GEO_AND_TRANSACTION",
  priority: "BALANCED",
  topicIds: ["q1"],
  readerSituation: "FIRST_UNDERSTANDING",
  noteForm: "QUESTION_LIST",
  imageMode: "QUESTION_CARD",
  conversionPath: "NONE",
  topics: [
    {
      id: "q1",
      seriesId: "s1",
      version: 1,
      question: "初次了解要确认哪些事？",
      intent: "准备",
      entityId: "",
      entityName: "",
    },
  ],
  publishers: [{ membershipId: "member", publisherContext: ordinary }],
  frozenAt: "2026-10-13T08:00:00Z",
};

describe("frozen medical generation plans", () => {
  it("preserves legacy input but never downgrades a malformed or future medical plan", () => {
    expect(readMedicalPlan(undefined)).toBeUndefined();
    expect(readMedicalPlan(plan)).toEqual(plan);
    expect(() => readMedicalPlan({ ...plan, executionVersion: "medical-plan-v2" })).toThrow(
      "version",
    );
    expect(() => readMedicalPlan({ ...plan, executionVersion: undefined })).toThrow("version");
    expect(() => readMedicalPlan({ ...plan, topicIds: ["not-frozen"] })).toThrow("Incomplete");
    expect(() => medicalPublisherFor(plan, "other-member")).toThrow("not frozen");
  });

  it("lets ordinary employees answer a question without creating a brand or consultation permission", () => {
    expect(medicalPublisherFor(plan, "member")).toEqual(ordinary);
    expect(() =>
      assertMedicalPublisher({ ...plan, conversionPath: "PLATFORM_CONSULTATION" }, ordinary),
    ).toThrow("not verified");
    expect(() =>
      assertMedicalPublisher({ ...plan, noteForm: "PERSONAL_RECORD" }, ordinary),
    ).toThrow("confirmed personal facts");
    expect(() =>
      assertMedicalPublisher(
        { ...plan, noteForm: "PERSONAL_RECORD" },
        {
          ...ordinary,
          experienceFacts: ["一段没有成员归属的文字"],
          evidence: "任职资料不是本人治疗记录",
        },
      ),
    ).toThrow("bound to the member");
  });

  it("keeps the member question stable when a regeneration run contains only that member", () => {
    const first = plan.topics[0];
    if (!first) throw new Error("Missing fixture topic");
    const expanded = {
      ...plan,
      topicIds: ["q1", "q2"],
      topics: [...plan.topics, { ...first, id: "q2", question: "另一个实际问题" }],
      publishers: [...plan.publishers, { membershipId: "member-2", publisherContext: ordinary }],
    };
    const ordinal = medicalOrdinalForMember(expanded, "member-2");
    expect(ordinal).toBe(2);
    expect(medicalPlanForOrdinal(expanded, ordinal).topics[0]?.id).toBe("q2");
    expect(medicalPlanForOrdinal(expanded, ordinal).topicIds).toEqual(["q2"]);
  });

  it("requires current verified evidence for work and institution information and rechecks expiry", () => {
    const kos = {
      ...ordinary,
      category: "MEDICAL_KOS" as const,
      authorId: "author",
      evidence: "verified official record",
      verifiedAt: "2026-10-13T08:00:00Z",
      verifiedBy: "operator",
      validUntil: "2026-10-14T08:00:00Z",
      role: "实际任职助理",
      allowBrandAttribution: true,
    };
    const now = new Date("2026-10-13T09:00:00Z");
    expect(() =>
      assertMedicalPublisher({ ...plan, noteForm: "WORK_RECORD" }, kos, now),
    ).not.toThrow();
    expect(() =>
      assertMedicalPublisher(
        { ...plan, noteForm: "WORK_RECORD" },
        { ...kos, verifiedAt: "2026-10-14T08:00:00Z" },
        now,
      ),
    ).toThrow("not verified");
    expect(() => assertMedicalPublisher({ ...plan, noteForm: "SERVICE_INFO" }, kos, now)).toThrow(
      "institution",
    );
    expect(() =>
      assertMedicalPublisher(
        { ...plan, noteForm: "WORK_RECORD" },
        kos,
        new Date("2026-10-15T08:00:00Z"),
      ),
    ).toThrow("expired");
    expect(
      medicalPublishingSafetyContext(plan, kos, new Date("2026-10-15T08:00:00Z")),
    ).toMatchObject({ verified: false });
  });
});
