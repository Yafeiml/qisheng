export type Job = Readonly<{
  id: string;
  kind: "VERIFY" | "METRICS";
  accessUrl: string;
  submittedAt: string;
  dueAt: string;
  windowHours: number | null;
  leaseToken: string;
  leaseExpiresAt: string;
}>;

export type Status =
  | "AVAILABLE"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "WRONG_TARGET"
  | "LOGIN_REQUIRED"
  | "CHALLENGE_REQUIRED"
  | "RISK_BLOCKED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "PARSER_CHANGED"
  | "LINK_UNAVAILABLE";

export type Metric = Readonly<{
  value: number | null;
  raw: string | null;
  precision: "EXACT" | "APPROXIMATE" | "UNAVAILABLE";
}>;

export type NoteEvidence = Readonly<{
  status: Status;
  observedAt: string;
  canonicalUrl?: string;
  title?: string;
  body?: string;
  hashtags?: string[];
  images?: ReadonlyArray<Readonly<{ url?: string; perceptualHash?: string }>>;
  externalPublishedAt?: string;
  visibilityContext: "COLLECTOR_ACCOUNT";
  metrics?: Readonly<{ likes: Metric; comments: Metric; favorites: Metric }>;
}>;

export type Claim = Readonly<{ paused: boolean; reason?: string; job: Job | null }>;
export type Health = Readonly<{ paused: boolean; reason: string | null }>;
export type LeaseHealth = Readonly<{ paused: boolean; leaseExpiresAt: string }>;

export interface JobSource {
  status(): Promise<Health>;
  claim(): Promise<Claim>;
  heartbeat(job: Job): Promise<LeaseHealth>;
  evidence(job: Job, result: NoteEvidence): Promise<void>;
  pause(reason: string): Promise<void>;
}

export interface NoteReader {
  read(job: Job): Promise<NoteEvidence>;
  close(): Promise<void>;
}
