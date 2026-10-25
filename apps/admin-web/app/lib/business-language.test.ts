import { describe, expect, it } from "vitest";
import {
  adminWorkRole,
  distributionTaskLabel,
  distributionTaskTiming,
  isCurrentDistributionTask,
} from "./business-language";

describe("business language", () => {
  it("keeps broad administrator responsibility when merged roles contain operator words", () => {
    expect(adminWorkRole("集团主管理员 + 企业内容运营")).toBe("ADMIN");
    expect(adminWorkRole("企业合规审核员")).toBe("REVIEWER");
    expect(adminWorkRole("集团数据查看员")).toBe("ANALYST");
  });

  it("separates terminal employee records from current work", () => {
    expect(isCurrentDistributionTask("AVAILABLE")).toBe(true);
    expect(isCurrentDistributionTask("VERIFYING")).toBe(true);
    expect(isCurrentDistributionTask("CANCELLED")).toBe(false);
    expect(isCurrentDistributionTask("EXPIRED")).toBe(false);
    expect(isCurrentDistributionTask("COMPLETED")).toBe(false);
    expect(isCurrentDistributionTask("LATE_CORRECTED")).toBe(false);
  });

  it("never shows a countdown for cancelled, expired or completed tasks", () => {
    const timing = (status: string) =>
      distributionTaskTiming({
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        status,
        verifiedAt: status === "COMPLETED" ? new Date().toISOString() : null,
        visibleAt: new Date(Date.now() - 3_600_000).toISOString(),
      });

    expect(timing("CANCELLED")).toBe("本期任务已取消，无需处理");
    expect(timing("EXPIRED")).toBe("开放后 24 小时内未提交发布链接");
    expect(timing("COMPLETED")).toMatch(/^完成于/u);
  });

  it("uses action-oriented employee labels", () => {
    expect(distributionTaskLabel("AVAILABLE")).toBe("待提交发布链接");
    expect(distributionTaskLabel("CANCELLED")).toBe("已取消");
    expect(distributionTaskLabel("VERIFYING")).toBe("链接核实中");
  });
});
