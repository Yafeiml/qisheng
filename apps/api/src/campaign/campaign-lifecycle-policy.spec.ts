import { describe, expect, it } from "vitest";
import {
  assertCampaignCancellationAllowed,
  assertFutureCampaignSchedule,
} from "./campaign-lifecycle-policy";

const now = new Date("2026-09-22T10:00:00Z");
const past = new Date(now.getTime() - 86400000);
const future = new Date(now.getTime() + 60000);

describe("campaign lifecycle schedule rules", () => {
  it.each(["DRAFT", "GENERATING", "GENERATION_FAILED", "REVIEW_PENDING"])(
    "allows cancellation of unapproved %s after its tentative schedule",
    (status) => {
      expect(() =>
        assertCampaignCancellationAllowed({ status, visibleAt: past }, now),
      ).not.toThrow();
    },
  );
  it("allows cancellation before the approved schedule", () => {
    expect(() =>
      assertCampaignCancellationAllowed({ status: "APPROVED", visibleAt: future }, now),
    ).not.toThrow();
  });
  it.each([past, now])("locks cancellation at and after the approved schedule", (visibleAt) => {
    expect(() => assertCampaignCancellationAllowed({ status: "APPROVED", visibleAt }, now)).toThrow(
      "不能取消",
    );
  });
  it.each(["ACTIVE", "COMPLETED", "EXPIRED", "CANCELLED"])(
    "never reopens terminal or active %s",
    (status) => {
      expect(() => assertCampaignCancellationAllowed({ status, visibleAt: future }, now)).toThrow();
    },
  );
  it.each([past, now, new Date("invalid")])(
    "rejects past, current and invalid schedules",
    (visibleAt) => {
      expect(() => assertFutureCampaignSchedule(visibleAt, now)).toThrow("未来");
    },
  );
  it("accepts a future schedule", () => {
    expect(() => assertFutureCampaignSchedule(future, now)).not.toThrow();
  });
});
