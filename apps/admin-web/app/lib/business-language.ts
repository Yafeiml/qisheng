export type AdminWorkRole = "ADMIN" | "OPERATOR" | "REVIEWER" | "ANALYST";

export function adminWorkRole(roleName: string): AdminWorkRole {
  if (roleName.includes("管理员")) return "ADMIN";
  if (roleName.includes("合规") || roleName.includes("审核")) return "REVIEWER";
  if (roleName.includes("数据") || roleName.includes("查看")) return "ANALYST";
  if (roleName.includes("运营")) return "OPERATOR";
  return "ADMIN";
}

export function adminWorkspaceCopy(roleName: string): Readonly<{
  description: string;
  eyebrow: string;
  title: string;
}> {
  const role = adminWorkRole(roleName);
  if (role === "OPERATOR") {
    return {
      description: "从创建活动、检查生成结果到安排员工开放时间，集中处理今天的内容工作。",
      eyebrow: "内容运营",
      title: "我的工作",
    };
  }
  if (role === "REVIEWER") {
    return {
      description: "优先处理待审核内容与风险项，确认后再交给员工执行。",
      eyebrow: "合规审核",
      title: "审核工作台",
    };
  }
  if (role === "ANALYST") {
    return {
      description: "查看活动执行、内容表现和宣传重点覆盖，发现值得复用或改进的方向。",
      eyebrow: "经营分析",
      title: "经营概览",
    };
  }
  return {
    description: "掌握企业运营准备、员工参与、活动进度和经营结果。",
    eyebrow: "企业管理",
    title: "管理总览",
  };
}

export function campaignStatusLabel(status: string): string {
  return (
    {
      ACTIVE: "员工执行中",
      ALL: "全部活动",
      APPROVED: "等待开放",
      CANCELLED: "已取消",
      COMPLETED: "全部完成",
      DRAFT: "草稿",
      EXPIRED: "本期已结束",
      GENERATING: "正在生成",
      GENERATION_FAILED: "部分内容未生成",
      REVIEW_PENDING: "等待审核",
    }[status] ?? "状态待确认"
  );
}

export function campaignStatusTone(status: string): "danger" | "neutral" | "success" | "warning" {
  if (["ACTIVE", "COMPLETED"].includes(status)) return "success";
  if (status === "GENERATION_FAILED") return "danger";
  if (["REVIEW_PENDING", "APPROVED"].includes(status)) return "warning";
  return "neutral";
}

export function campaignNextAction(status: string, failedCount = 0): string {
  if (status === "GENERATING") return "等待系统完成生成";
  if (status === "GENERATION_FAILED") return `处理 ${failedCount} 名员工的生成异常`;
  if (status === "REVIEW_PENDING") return "审核内容并决定是否开放";
  if (status === "APPROVED") return "核对开放时间";
  if (status === "ACTIVE") return "查看员工提交进度";
  if (status === "COMPLETED" || status === "EXPIRED") return "查看本期结果";
  if (status === "CANCELLED") return "查看取消与任务处理记录";
  return "查看活动详情";
}

export function distributionTaskLabel(status: string): string {
  return (
    {
      AVAILABLE: "待提交发布链接",
      CANCELLED: "已取消",
      COMPLETED: "已按时完成",
      EXPIRED: "未按时提交链接",
      LATE_CORRECTED: "逾期核实有效",
      LOCKED: "尚未开放",
      VERIFYING: "链接核实中",
    }[status] ?? "状态待确认"
  );
}

export function distributionTaskTone(status: string): "danger" | "neutral" | "success" | "warning" {
  if (["COMPLETED", "LATE_CORRECTED"].includes(status)) return "success";
  if (status === "EXPIRED") return "danger";
  if (["LOCKED", "CANCELLED"].includes(status)) return "neutral";
  return "warning";
}

export function isCurrentDistributionTask(status: string): boolean {
  return !["CANCELLED", "COMPLETED", "EXPIRED", "LATE_CORRECTED"].includes(status);
}

export function distributionTaskTiming(
  task: Readonly<{
    expiresAt: string;
    status: string;
    verifiedAt?: string | null;
    visibleAt: string;
  }>,
): string {
  if (task.status === "CANCELLED") return "本期任务已取消，无需处理";
  if (task.status === "COMPLETED") {
    return task.verifiedAt ? `完成于 ${formatBusinessDate(task.verifiedAt)}` : "本期任务已完成";
  }
  if (task.status === "LATE_CORRECTED") return "逾期后已由管理员核实为有效发布";
  if (task.status === "EXPIRED") return "开放后 24 小时内未提交发布链接";
  if (task.status === "VERIFYING") return "已按时提交链接，等待系统或管理员核实";
  const now = Date.now();
  const opensAt = new Date(task.visibleAt).getTime();
  const expiresAt = new Date(task.expiresAt).getTime();
  if (now < opensAt) return `${formatBusinessDate(task.visibleAt)} 开放`;
  if (now >= expiresAt) return "提交时间已结束";
  const hours = Math.max(1, Math.ceil((expiresAt - now) / 3_600_000));
  return `还剩约 ${hours} 小时提交发布链接`;
}

export function workItemStatusLabel(status: string): string {
  return (
    {
      ALL: "全部",
      CANCELLED: "已取消",
      FAILED: "未成功生成",
      QUEUED: "等待生成",
      RUNNING: "正在生成",
      SUCCEEDED: "已生成",
    }[status] ?? "状态待确认"
  );
}

export function timelineStatusLabel(status: string): string {
  return (
    {
      CANCELLED: "已取消",
      COMPLETED: "已完成",
      FAILED: "未完成",
      GENERATION_FAILED: "部分未生成",
      PENDING: "待处理",
      RUNNING: "进行中",
      SCHEDULED: "已安排",
      SUCCEEDED: "已完成",
    }[status] ?? "已记录"
  );
}

export function formatBusinessDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}
