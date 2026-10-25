import { describe, expect, it } from "vitest";
import type {
  EmployeeMembership,
  EmployeeTask,
  TaskStatus,
} from "../../apps/employee-miniapp/types";
import {
  buildEnterpriseFilters,
  filterEmployeeTasks,
  summarizeTasks,
  taskEmptyState,
  validEnterpriseSelection,
} from "../../apps/employee-miniapp/utils/task-list";

const memberships: EmployeeMembership[] = [
  {
    enterpriseId: "enterprise-a",
    enterpriseName: "春风眼科",
    membershipId: "membership-a",
    tenantId: "tenant-1",
  },
  {
    enterpriseId: "enterprise-b",
    enterpriseName: "明亮视光",
    membershipId: "membership-b",
    tenantId: "tenant-1",
  },
];

describe("employee miniapp task list state", () => {
  it("keeps joined enterprises visible even when one has no tasks", () => {
    expect(buildEnterpriseFilters(memberships, "enterprise-b")).toEqual([
      { active: false, id: "ALL", name: "全部企业" },
      { active: false, id: "enterprise-a", name: "春风眼科" },
      { active: true, id: "enterprise-b", name: "明亮视光" },
    ]);
  });

  it("falls back to all enterprises when a saved membership no longer exists", () => {
    expect(validEnterpriseSelection(memberships, "enterprise-removed")).toBe("ALL");
    expect(validEnterpriseSelection(memberships, "enterprise-a")).toBe("enterprise-a");
  });

  it("filters and summarizes the currently selected enterprise", () => {
    const tasks = [
      task("a-current", "enterprise-a", "AVAILABLE"),
      task("a-done", "enterprise-a", "COMPLETED"),
      task("b-expired", "enterprise-b", "EXPIRED"),
    ];

    expect(filterEmployeeTasks(tasks, "enterprise-a", "CURRENT").map(({ id }) => id)).toEqual([
      "a-current",
    ]);
    expect(summarizeTasks(tasks, "enterprise-a")).toEqual({
      completed: 1,
      expired: 0,
      history: 1,
      pending: 1,
      total: 2,
    });
  });

  it("distinguishes no membership, no assigned task and completed current work", () => {
    expect(
      taskEmptyState({
        enterpriseId: "ALL",
        enterpriseName: "",
        filteredCount: 0,
        membershipCount: 0,
        scopedTaskCount: 0,
        statusFilter: "CURRENT",
      }),
    ).toMatchObject({ action: "JOIN", title: "还没有加入企业" });

    expect(
      taskEmptyState({
        enterpriseId: "enterprise-b",
        enterpriseName: "明亮视光",
        filteredCount: 0,
        membershipCount: 2,
        scopedTaskCount: 0,
        statusFilter: "CURRENT",
      }),
    ).toMatchObject({ action: "REFRESH", title: "明亮视光暂未安排任务" });

    expect(
      taskEmptyState({
        enterpriseId: "ALL",
        enterpriseName: "",
        filteredCount: 0,
        membershipCount: 2,
        scopedTaskCount: 3,
        statusFilter: "CURRENT",
      }),
    ).toMatchObject({ title: "当前没有待处理任务" });
  });
});

function task(id: string, enterpriseId: string, status: TaskStatus): EmployeeTask {
  return {
    contentRevision: 1,
    factsConfirmationRequired: false,
    factsConfirmed: false,
    factsReturned: false,
    publishingArrangement: null,
    campaign: { id: `campaign-${id}`, status: "ACTIVE", title: `任务 ${id}` },
    content: null,
    contentVisible: false,
    copiedAt: null,
    downloadedAt: null,
    enterprise: { id: enterpriseId, name: enterpriseId },
    expiresAt: "2026-09-02T12:00:00.000Z",
    firstViewedAt: null,
    id,
    publication: null,
    status,
    submissionFailureReason: null,
    submittedAt: null,
    verifiedAt: null,
    visibleAt: "2026-09-01T12:00:00.000Z",
  };
}
