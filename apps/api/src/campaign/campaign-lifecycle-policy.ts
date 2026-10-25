import { ConflictException } from "@nestjs/common";

export function assertCampaignCancellationAllowed(
  campaign: { status: string; visibleAt: Date },
  now: Date,
) {
  if (["DRAFT", "GENERATING", "GENERATION_FAILED", "REVIEW_PENDING"].includes(campaign.status))
    return;
  if (campaign.status === "APPROVED" && campaign.visibleAt > now) return;
  throw new ConflictException("活动已正式开放或结束，不能取消。仅未开放的活动可取消。");
}

export function assertFutureCampaignSchedule(visibleAt: Date, now: Date) {
  if (!Number.isFinite(visibleAt.getTime()) || visibleAt <= now) {
    throw new ConflictException("原定开放时间已过或无效，请重新选择未来的开放时间。");
  }
}
