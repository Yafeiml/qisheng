import type { EmployeeMembership, EmployeeTask, TaskStatus } from "../types";

export type StatusFilter = "CURRENT" | "HISTORY";

export interface EnterpriseFilter {
  active: boolean;
  id: string;
  name: string;
}

export interface TaskCounts {
  completed: number;
  expired: number;
  history: number;
  pending: number;
  total: number;
}

export interface TaskEmptyState {
  action: "JOIN" | "REFRESH";
  description: string;
  icon: string;
  title: string;
}

export function buildEnterpriseFilters(
  memberships: readonly EmployeeMembership[],
  selectedId: string,
): EnterpriseFilter[] {
  const enterprises = new Map(
    memberships.map(({ enterpriseId, enterpriseName }) => [enterpriseId, enterpriseName]),
  );
  return [
    { active: selectedId === "ALL", id: "ALL", name: "全部企业" },
    ...[...enterprises].map(([id, name]) => ({ active: selectedId === id, id, name })),
  ];
}

export function validEnterpriseSelection(
  memberships: readonly EmployeeMembership[],
  preferredId: string,
): string {
  if (preferredId === "ALL") return preferredId;
  return memberships.some(({ enterpriseId }) => enterpriseId === preferredId) ? preferredId : "ALL";
}

export function filterEmployeeTasks<T extends EmployeeTask>(
  tasks: readonly T[],
  enterpriseId: string,
  statusFilter: StatusFilter,
): T[] {
  return tasks.filter((task) => {
    const enterpriseMatched = enterpriseId === "ALL" || task.enterprise.id === enterpriseId;
    const statusMatched =
      (statusFilter === "CURRENT" && isPendingTask(task.status)) ||
      (statusFilter === "HISTORY" && !isPendingTask(task.status));
    return enterpriseMatched && statusMatched;
  });
}

export function summarizeTasks(tasks: readonly EmployeeTask[], enterpriseId: string): TaskCounts {
  const scoped = tasks.filter(
    (task) => enterpriseId === "ALL" || task.enterprise.id === enterpriseId,
  );
  const pending = scoped.filter(({ status }) => isPendingTask(status)).length;
  return {
    completed: scoped.filter(({ status }) => ["COMPLETED", "LATE_CORRECTED"].includes(status))
      .length,
    expired: scoped.filter(({ status }) => ["EXPIRED", "CANCELLED"].includes(status)).length,
    history: scoped.length - pending,
    pending,
    total: scoped.length,
  };
}

export function taskEmptyState(
  input: Readonly<{
    enterpriseId: string;
    enterpriseName: string;
    filteredCount: number;
    membershipCount: number;
    scopedTaskCount: number;
    statusFilter: StatusFilter;
  }>,
): TaskEmptyState {
  if (input.membershipCount === 0) {
    return {
      action: "JOIN",
      description: "请先加入企业。只有企业管理员已导入并启用的手机号才能完成绑定。",
      icon: "+",
      title: "还没有加入企业",
    };
  }
  if (input.scopedTaskCount === 0 && input.enterpriseId !== "ALL") {
    return {
      action: "REFRESH",
      description: "你已成功加入这家企业；企业安排新任务后会自动出现在这里。",
      icon: "○",
      title: `${input.enterpriseName || "当前企业"}暂未安排任务`,
    };
  }
  if (input.scopedTaskCount === 0) {
    return {
      action: "REFRESH",
      description: "企业尚未向你分配任务。无需反复操作，收到任务后会显示在当前任务中。",
      icon: "○",
      title: "已加入企业，暂时没有任务",
    };
  }
  if (input.filteredCount === 0 && input.statusFilter === "CURRENT") {
    return {
      action: "REFRESH",
      description: "当前范围内的任务都已处理；新的专属图文会在企业安排的时间开放。",
      icon: "✓",
      title: "当前没有待处理任务",
    };
  }
  return {
    action: "REFRESH",
    description: "完成、失效或取消的任务会保留在这里，方便你查看本人记录。",
    icon: "○",
    title: "当前范围还没有历史记录",
  };
}

export function isPendingTask(status: TaskStatus): boolean {
  return !["COMPLETED", "LATE_CORRECTED", "EXPIRED", "CANCELLED"].includes(status);
}
