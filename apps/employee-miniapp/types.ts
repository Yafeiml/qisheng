export type TaskStatus =
  | "LOCKED"
  | "AVAILABLE"
  | "VERIFYING"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED"
  | "LATE_CORRECTED";

export interface EmployeeMembership {
  enterpriseId: string;
  enterpriseName: string;
  membershipId: string;
  tenantId: string;
}

export interface EmployeeSession {
  accessToken: string;
  memberships: EmployeeMembership[];
  phone: string;
  username?: string;
}

export interface EmployeeNotificationConfiguration {
  appId: string | null;
  authorizationGeneration: number | null;
  enabled: boolean;
  identityLinked: boolean;
  identityVersion: number | null;
  remainingSubscriptions: number;
  subscriptionStatus: "NONE" | "ACCEPT" | "REJECT" | "BAN";
  templateId: string | null;
}

export type EmployeeSubscriptionResult = "accept" | "reject" | "ban";

export interface BindCandidate {
  alreadyBound: boolean;
  departmentName: string | null;
  employeeName: string;
  enterpriseId: string;
  enterpriseName: string;
  membershipId: string;
  tenantId: string;
  tenantName: string;
}

export interface EmployeeTaskMetric {
  comments: number | null;
  favorites: number | null;
  likes: number | null;
  observedAt: string;
  shares: number | null;
  views: number | null;
}

export interface EmployeeTaskImage {
  height: number;
  id: string;
  imageUrl: string;
  mimeType: string;
  synthetic: boolean;
  width: number;
}

export interface EmployeeTask {
  contentRevision: number;
  factsConfirmationRequired: boolean;
  factsConfirmed: boolean;
  factsReturned: boolean;
  publishingArrangement: string | null;
  campaign: { id: string; status: string; title: string };
  content: {
    body: string;
    hashtags: string[];
    images: EmployeeTaskImage[];
    synthetic: boolean;
    title: string;
  } | null;
  contentVisible: boolean;
  copiedAt: string | null;
  downloadedAt: string | null;
  enterprise: { id: string; name: string };
  expiresAt: string;
  firstViewedAt: string | null;
  id: string;
  publication: {
    latestMetrics: EmployeeTaskMetric | null;
    normalizedUrl: string;
    verifiedAt: string;
  } | null;
  status: TaskStatus;
  submissionFailureReason: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  visibleAt: string;
}

export interface EmployeeApp {
  globalData: { session: EmployeeSession | null };
}
