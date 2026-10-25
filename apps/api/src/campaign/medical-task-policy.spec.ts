import "reflect-metadata";
import type { MedicalPlan, MedicalPublisherContext } from "@xhs-agentic/ai-gateway";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { EmployeeFactsDto } from "./employee-facts.dto";
import {
  assertTaskFactsConfirmed,
  assertTaskPublishingCurrent,
  type MedicalTask,
  medicalPublicationIssue,
  taskFactsConfirmed,
  taskMedicalPlan,
} from "./medical-task-policy";

function task(qualified = false): MedicalTask {
  const publisher: MedicalPublisherContext = qualified
    ? {
        schemaVersion: "medical-publisher-v1",
        category: "MEDICAL_KOS",
        authorId: "author_123",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        validUntil: "2099-01-01T00:00:00.000Z",
        verifiedBy: "operator",
        evidence: "企业核对公开身份",
        role: "服务协调",
        allowBrandAttribution: true,
        allowPlatformConsultation: true,
      }
    : {
        schemaVersion: "medical-publisher-v1",
        category: "UNKNOWN",
        allowBrandAttribution: false,
        allowPlatformConsultation: false,
      };
  const plan: MedicalPlan = {
    schemaVersion: "medical-selection-v1",
    executionVersion: "medical-plan-v1",
    objective: "GEO_AND_TRANSACTION",
    priority: "BALANCED",
    readerSituation: "FIRST_UNDERSTANDING",
    noteForm: "QUESTION_LIST",
    imageMode: "QUESTION_CARD",
    conversionPath: qualified ? "OFFICIAL_PROFILE" : "NONE",
    topicIds: ["topic"],
    topics: [
      {
        id: "topic",
        seriesId: "series",
        version: 1,
        question: "首次准备哪些问题？",
        intent: "了解",
        entityId: "entity",
        entityName: "真实主体",
      },
    ],
    publishers: [{ membershipId: "member", publisherContext: publisher }],
    frozenAt: "2026-10-10T00:00:00.000Z",
  };
  return {
    membershipId: "member",
    campaign: { selectionSnapshot: plan },
    membership: { publisherContext: publisher },
    employeeContent: { revision: 2 },
    factsConfirmedAt: new Date(),
    factsConfirmedRevision: 2,
    factsReturnedAt: null,
  };
}

describe("employee medical publishing conditions", () => {
  it("requires generic and legacy campaigns to confirm facts without requiring a medical plan", () => {
    const legacy: MedicalTask = {
      campaign: {},
      membershipId: "member",
      employeeContent: { revision: 1 },
    };
    expect(taskMedicalPlan(legacy)).toBeUndefined();
    expect(taskFactsConfirmed(legacy)).toBe(false);
    expect(() => assertTaskFactsConfirmed(legacy, 1)).toThrow("先确认");
    expect(medicalPublicationIssue(legacy)).toContain("先确认");
    legacy.factsConfirmedAt = new Date();
    legacy.factsConfirmedRevision = 1;
    expect(taskFactsConfirmed(legacy)).toBe(true);
    expect(() => assertTaskFactsConfirmed(legacy, 1)).not.toThrow();
    expect(medicalPublicationIssue(legacy)).toBeNull();
  });
  it.each(["unconfirmed", "returned", "changed-version", "stale-request"])(
    "blocks %s generic facts in both task actions and publication verification",
    (scenario) => {
      const current = task();
      current.campaign.selectionSnapshot = null;
      if (scenario === "unconfirmed") current.factsConfirmedAt = null;
      if (scenario === "returned") current.factsReturnedAt = new Date();
      if (scenario === "changed-version") current.employeeContent.revision = 3;
      const revision = scenario === "stale-request" ? 1 : current.employeeContent.revision;
      expect(() => assertTaskFactsConfirmed(current, revision)).toThrow();
      if (scenario !== "stale-request") {
        expect(taskFactsConfirmed(current)).toBe(false);
        expect(medicalPublicationIssue(current)).toContain("先确认");
      }
    },
  );
  it("uses the frozen campaign plan and never falls back when it is malformed", () => {
    const current = task();
    expect(taskMedicalPlan(current)?.executionVersion).toBe("medical-plan-v1");
    current.campaign.selectionSnapshot = { schemaVersion: "old-poster" };
    expect(() => taskMedicalPlan(current)).toThrow("缺少有效");
  });
  it("requires facts confirmed for the exact revision and blocks returned copy", () => {
    const current = task();
    expect(() => assertTaskFactsConfirmed(current, 2)).not.toThrow();
    expect(() => assertTaskFactsConfirmed(current, 1)).toThrow("内容已更新");
    current.employeeContent.revision = 3;
    expect(() => assertTaskFactsConfirmed(current, 3)).toThrow("先确认");
    current.employeeContent.revision = 2;
    current.factsReturnedAt = new Date();
    expect(() => assertTaskFactsConfirmed(current, 2)).toThrow("先确认");
  });
  it("rejects expired or changed enterprise arrangements without asking employees to choose an account", () => {
    const current = task(true);
    expect(() => assertTaskPublishingCurrent(current)).not.toThrow();
    current.membership = {
      publisherContext: {
        ...(current.membership?.publisherContext as MedicalPublisherContext),
        authorId: "other_author",
      },
    };
    expect(() => assertTaskPublishingCurrent(current)).toThrow("已变化");
    expect(() => assertTaskPublishingCurrent(task(true), new Date("2100-01-01"))).toThrow("过期");
  });
  it("requires the real readback author to match a qualified frozen publisher", () => {
    expect(medicalPublicationIssue(task(true), "author_123")).toBeNull();
    expect(medicalPublicationIssue(task(true), "another_author")).toContain("不一致");
    expect(medicalPublicationIssue(task(true))).toContain("缺少");
    expect(medicalPublicationIssue(task(true), "another_author", true)).toContain("不一致");
  });
  it("keeps unknown ordinary authors in manual review and allows an explicit enterprise ownership declaration", () => {
    expect(medicalPublicationIssue(task(), "author_123")).toContain("尚未核实");
    expect(medicalPublicationIssue(task(), "author_123", true)).toBeNull();
    const current = task(true);
    current.factsConfirmedAt = null;
    expect(medicalPublicationIssue(current, "author_123", true)).toContain("先确认");
  });
  it("validates an explicit return reason and refuses negative or missing revisions", () => {
    expect(
      validateSync(plainToInstance(EmployeeFactsDto, { revision: 2, confirmed: true })),
    ).toEqual([]);
    expect(
      validateSync(plainToInstance(EmployeeFactsDto, { revision: 2, confirmed: false })).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(
        plainToInstance(EmployeeFactsDto, {
          revision: 2,
          confirmed: false,
          reason: "MATERIAL_PRIVACY",
        }),
      ),
    ).toEqual([]);
    expect(
      validateSync(plainToInstance(EmployeeFactsDto, { revision: 0, confirmed: true })).length,
    ).toBeGreaterThan(0);
  });
});
