export const CAMPAIGN_PREPARATION_MS = 0;

export function earliestCampaignSchedule(createdAt: number, now: number) {
  return Math.ceil(Math.max(createdAt + CAMPAIGN_PREPARATION_MS, now + 1) / 60_000) * 60_000;
}
