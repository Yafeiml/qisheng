export const distributionTaskStatuses = [
  "LOCKED",
  "AVAILABLE",
  "VERIFYING",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "LATE_CORRECTED",
] as const;

export type DistributionTaskStatus = (typeof distributionTaskStatuses)[number];
