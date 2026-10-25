import { describe, expect, it } from "vitest";
import { publicationWallDestination, publicationWallStatus } from "./publication-wall-status";

type Campaign = Parameters<typeof publicationWallStatus>[0];
type Task = NonNullable<Parameters<typeof publicationWallStatus>[2]>;
const campaign = (extra: Partial<Campaign> = {}) =>
  ({ status: "ACTIVE", generationRuns: [], employeeContents: [], ...extra }) as Campaign;
const task = (extra: Partial<Task> = {}) =>
  ({ status: "AVAILABLE", submissions: [], ...extra }) as Task;
const submission = (status: string, submittedAt: string) =>
  ({ status, submittedAt }) as Task["submissions"][number];

describe("publication wall status", () => {
  it("does not show a failure icon for material preparation", () => {
    expect(publicationWallStatus(campaign(), "employee", null)).toEqual({
      label: "素材准备中",
      icon: "file-clock",
      tone: "preparing",
    });
  });

  it.each([
    ["LOCKED", "素材就绪 · 等待开放"],
    ["AVAILABLE", "待领取素材"],
    ["VERIFYING", "发布链接核验中"],
    ["COMPLETED", "发布成功"],
    ["LATE_CORRECTED", "逾期补交成功"],
    ["EXPIRED", "逾期未完成"],
    ["CANCELLED", "任务已取消"],
  ])("represents task state %s", (status, label) => {
    expect(publicationWallStatus(campaign(), "employee", task({ status })).label).toBe(label);
  });

  it("distinguishes viewing and collecting materials", () => {
    expect(
      publicationWallStatus(campaign(), "employee", task({ firstViewedAt: "2026-09-22" })).label,
    ).toBe("已查看 · 待发布");
    expect(
      publicationWallStatus(campaign(), "employee", task({ copiedAt: "2026-09-22" })).label,
    ).toBe("已领取素材 · 待发布");
  });

  it.each([
    ["INVALID", "链接核验未通过"],
    ["DUPLICATE", "链接重复 · 请重新提交"],
    ["UNAVAILABLE", "链接无法访问 · 待重试"],
    ["MANUAL_REVIEW", "等待人工复核"],
  ])("uses latest submission state %s regardless of array ordering", (status, label) => {
    const submissions = [submission("INVALID", "2026-09-20"), submission(status, "2026-09-22")];
    expect(publicationWallStatus(campaign(), "employee", task({ submissions })).label).toBe(label);
    expect(
      publicationWallStatus(campaign(), "employee", task({ submissions: submissions.toReversed() }))
        .label,
    ).toBe(label);
  });

  it("does not let old failures override a completed task or an ongoing retry", () => {
    const submissions = [submission("INVALID", "2026-09-20")];
    expect(
      publicationWallStatus(campaign(), "employee", task({ status: "COMPLETED", submissions }))
        .tone,
    ).toBe("success");
    expect(
      publicationWallStatus(campaign(), "employee", task({ status: "VERIFYING", submissions }))
        .label,
    ).toBe("发布链接核验中");
  });

  it("uses the employee's latest generation attempt", () => {
    const generationRuns = [
      { createdAt: "2026-09-20", workItems: [{ membershipId: "employee", status: "FAILED" }] },
      { createdAt: "2026-09-22", workItems: [{ membershipId: "employee", status: "RUNNING" }] },
    ] as Campaign["generationRuns"];
    expect(publicationWallStatus(campaign({ generationRuns }), "employee", null).label).toBe(
      "素材生成中",
    );
    expect(
      publicationWallStatus(
        campaign({ generationRuns: generationRuns.slice(0, 1) }),
        "employee",
        null,
      ).label,
    ).toBe("素材生成失败");
    expect(publicationWallStatus(campaign({ generationRuns }), "other", null).label).toBe(
      "素材准备中",
    );
  });

  it("shows cancellation before unfinished generation", () => {
    expect(publicationWallStatus(campaign({ status: "CANCELLED" }), "employee", null).label).toBe(
      "任务已取消",
    );
  });
});

describe("publication wall destination", () => {
  const content = {
    id: "content",
    membershipId: "employee",
  } as Campaign["employeeContents"][number];
  it.each(["FAILED", "QUEUED", "RUNNING", "CANCELLED"])(
    "prioritizes the current generation attempt over old content: %s",
    (status) => {
      const generationRuns = [
        { createdAt: "2026-09-20", workItems: [{ membershipId: "employee", status: "SUCCEEDED" }] },
        { createdAt: "2026-10-10", workItems: [{ membershipId: "employee", status }] },
      ] as Campaign["generationRuns"];
      expect(
        publicationWallDestination(
          campaign({ employeeContents: [content], generationRuns }),
          "employee",
          null,
        ),
      ).toEqual({ tab: status === "CANCELLED" ? "RECORDS" : "EXECUTION" });
    },
  );
  it.each(["LOCKED", "AVAILABLE"])("opens the exact employee content for %s", (status) => {
    expect(
      publicationWallDestination(
        campaign({ employeeContents: [content] }),
        "employee",
        task({ status }),
      ),
    ).toEqual({ tab: "REVIEW", contentId: "content" });
    expect(
      publicationWallDestination(campaign({ employeeContents: [content] }), "other", null),
    ).toEqual({ tab: "EXECUTION" });
  });
  it.each(["VERIFYING", "COMPLETED", "LATE_CORRECTED"])("opens verification for %s", (status) => {
    expect(
      publicationWallDestination(campaign(), "employee", task({ id: "task", status })),
    ).toEqual({ tab: "PUBLICATION", href: "/console/publications?taskId=task" });
  });
  it.each(["INVALID", "DUPLICATE", "UNAVAILABLE", "MANUAL_REVIEW"])(
    "keeps publication failures out of content sampling: %s",
    (status) => {
      expect(
        publicationWallDestination(
          campaign({ employeeContents: [content] }),
          "employee",
          task({ id: "task", submissions: [submission(status, "2026-10-10")] }),
        ),
      ).toMatchObject({ tab: "PUBLICATION" });
    },
  );
  it.each(["EXPIRED", "CANCELLED"])("opens records when an unfinished task is %s", (status) => {
    expect(
      publicationWallDestination(
        campaign({ employeeContents: [content] }),
        "employee",
        task({ status }),
      ),
    ).toEqual({ tab: "RECORDS" });
  });
});
