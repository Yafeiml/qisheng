import { describe, expect, it } from "vitest";
import { earliestCampaignSchedule } from "./campaign-schedule";

describe("campaign schedule picker", () => {
  const created = Date.parse("2026-09-22T09:00:00+08:00");
  it("allows the next minute without an eight-hour preparation window", () => {
    expect(earliestCampaignSchedule(created, created)).toBe(
      Date.parse("2026-09-22T09:01:00+08:00"),
    );
  });
  it("allows the next minute at review", () => {
    expect(earliestCampaignSchedule(created, Date.parse("2026-09-22T16:30:00+08:00"))).toBe(
      Date.parse("2026-09-22T16:31:00+08:00"),
    );
  });
  it("requires a new future minute if processing missed the original schedule", () => {
    expect(earliestCampaignSchedule(created, Date.parse("2026-09-22T18:00:00+08:00"))).toBe(
      Date.parse("2026-09-22T18:01:00+08:00"),
    );
  });
});
