import type { components } from "@xhs-agentic/contracts";
import type { ActionIconName } from "../components/action-icon";

type Campaign = components["schemas"]["CampaignDetailDto"];
type Task = Campaign["distributionTasks"][number];
type Tone = "preparing" | "info" | "warning" | "danger" | "success" | "neutral";
export type PublicationWallStatus = { label: string; icon: ActionIconName; tone: Tone };
type PublicationWallDestination =
  | { tab: "PUBLICATION"; href: string }
  | { tab: "REVIEW"; contentId: string }
  | { tab: "EXECUTION" | "RECORDS" };

export function publicationWallDestination(
  campaign: Campaign,
  membershipId: string,
  task: Task | null,
): PublicationWallDestination {
  if (
    task &&
    (task.submissions.length > 0 ||
      task.submittedAt ||
      ["VERIFYING", "COMPLETED", "LATE_CORRECTED"].includes(task.status))
  ) {
    return {
      tab: "PUBLICATION",
      href: `/console/publications?taskId=${encodeURIComponent(task.id)}`,
    };
  }
  if (
    task?.status === "CANCELLED" ||
    task?.status === "EXPIRED" ||
    campaign.status === "CANCELLED" ||
    campaign.status === "EXPIRED"
  ) {
    return { tab: "RECORDS" };
  }
  if (!task) {
    const work = latestGenerationWork(campaign, membershipId);
    if (work?.status === "CANCELLED") return { tab: "RECORDS" };
    if (work && ["FAILED", "QUEUED", "RUNNING"].includes(work.status)) return { tab: "EXECUTION" };
  }
  const content = campaign.employeeContents.find((item) => item.membershipId === membershipId);
  return content ? { tab: "REVIEW", contentId: content.id } : { tab: "EXECUTION" };
}

const status = (label: string, icon: ActionIconName, tone: Tone): PublicationWallStatus => ({
  label,
  icon,
  tone,
});

export function publicationWallStatus(
  campaign: Campaign,
  membershipId: string,
  task: Task | null,
): PublicationWallStatus {
  if (task?.status === "COMPLETED") return status("发布成功", "badge-check", "success");
  if (task?.status === "LATE_CORRECTED") return status("逾期补交成功", "history-check", "success");
  if (task?.status === "CANCELLED" || campaign.status === "CANCELLED") {
    return status("任务已取消", "ban", "neutral");
  }
  if (task) {
    const latest = [...task.submissions].sort((a, b) =>
      b.submittedAt.localeCompare(a.submittedAt),
    )[0];
    if (latest?.status === "MANUAL_REVIEW") return status("等待人工复核", "link-search", "warning");
    if (task.status === "VERIFYING") return status("发布链接核验中", "link-search", "info");
    if (task.status === "EXPIRED") return status("逾期未完成", "clock-alert", "warning");
    if (task.status === "LOCKED") return status("素材就绪 · 等待开放", "lock", "neutral");
    if (latest?.status === "INVALID") return status("链接核验未通过", "file-warning", "danger");
    if (latest?.status === "DUPLICATE") return status("链接重复 · 请重新提交", "copy", "danger");
    if (latest?.status === "UNAVAILABLE")
      return status("链接无法访问 · 待重试", "file-warning", "warning");
    if (task.status === "AVAILABLE") {
      if (task.copiedAt || task.downloadedAt) return status("已领取素材 · 待发布", "send", "info");
      if (task.firstViewedAt) return status("已查看 · 待发布", "send", "info");
      return status("待领取素材", "download", "info");
    }
    return status("状态待确认", "clock-alert", "neutral");
  }
  const work = latestGenerationWork(campaign, membershipId);
  if (work?.status === "FAILED") return status("素材生成失败", "file-warning", "danger");
  if (work?.status === "RUNNING") return status("素材生成中", "file-clock", "preparing");
  if (work?.status === "QUEUED") return status("素材排队生成", "file-clock", "preparing");
  if (work?.status === "CANCELLED") return status("素材生成已取消", "ban", "neutral");
  if (campaign.status === "EXPIRED") return status("活动已结束 · 未发布", "clock-alert", "warning");
  if (
    work?.status === "SUCCEEDED" ||
    campaign.employeeContents.some((c) => c.membershipId === membershipId)
  ) {
    return campaign.status === "REVIEW_PENDING"
      ? status("素材待审核", "file-search", "warning")
      : status("素材已就绪 · 待分发", "file-check", "info");
  }
  if (campaign.status === "GENERATION_FAILED")
    return status("素材准备受阻", "file-warning", "danger");
  return status("素材准备中", "file-clock", "preparing");
}

function latestGenerationWork(campaign: Campaign, membershipId: string) {
  return [...campaign.generationRuns]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((run) => run.workItems)
    .find((item) => item.membershipId === membershipId);
}
