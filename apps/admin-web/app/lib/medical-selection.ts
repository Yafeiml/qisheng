export type MedicalSelection = {
  schemaVersion: "medical-selection-v1";
  objective: "GEO_AND_TRANSACTION";
  priority: "GEO_ACCUMULATION" | "TRANSACTION" | "BALANCED";
  topicIds: string[];
  readerSituation:
    | "FIRST_UNDERSTANDING"
    | "LONG_CONSIDERATION"
    | "TIME_PLANNING"
    | "BUDGET_QUESTIONS"
    | "WORK_OBSERVATION"
    | "LIFE_INCONVENIENCE";
  noteForm: "QUESTION_LIST" | "PREPARATION" | "WORK_RECORD" | "PERSONAL_RECORD" | "SERVICE_INFO";
  imageMode: "ORIGINAL_EDIT" | "QUESTION_CARD" | "ILLUSTRATION";
  conversionPath: "NONE" | "OFFICIAL_PROFILE" | "PLATFORM_CONSULTATION";
  originalImageConfirmed?: boolean;
};

export type MedicalOptions = {
  enabled: boolean;
  objective: "GEO_AND_TRANSACTION";
  priorities: MedicalSelection["priority"][];
  readerSituations: MedicalSelection["readerSituation"][];
  noteForms: MedicalSelection["noteForm"][];
  imageModes: MedicalSelection["imageMode"][];
  conversionPaths: MedicalSelection["conversionPath"][];
  topics: {
    id: string;
    question: string;
    intent: string;
    entityId: string | null;
    entityName: string | null;
  }[];
  disabledNoteForms: { value: string; reason: string }[];
  approvedAdAssets: { enabled: boolean; reason: string };
  enterprise: { name: string; brandName: string | null; city: string | null };
  members?: { id: string; name: string; publisherContext: unknown }[];
  images?: { artifactId: string; title: string; description: string }[];
};

export type MedicalPublisherContext = {
  category: "ORDINARY" | "UNKNOWN" | "MEDICAL_KOS" | "INSTITUTION";
  authorId?: string;
  validUntil?: string;
  verifiedAt?: string;
  evidence?: string;
  role?: string;
  allowBrandAttribution?: boolean;
  allowPlatformConsultation?: boolean;
};

export function parseMedicalPublisherContext(value: unknown): MedicalPublisherContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== "medical-publisher-v1") return null;
  if (
    typeof raw.category !== "string" ||
    !["ORDINARY", "UNKNOWN", "MEDICAL_KOS", "INSTITUTION"].includes(raw.category)
  )
    return null;
  for (const [key, max] of [
    ["authorId", 100],
    ["role", 100],
    ["evidence", 2000],
    ["validUntil", 100],
    ["verifiedAt", 100],
  ] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key].length > max))
      return null;
  }
  for (const key of ["validUntil", "verifiedAt"] as const) {
    if (typeof raw[key] === "string" && !Number.isFinite(Date.parse(raw[key]))) return null;
  }
  if (typeof raw.authorId === "string" && !/^[a-zA-Z0-9_-]{6,100}$/u.test(raw.authorId))
    return null;
  for (const key of ["allowBrandAttribution", "allowPlatformConsultation"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") return null;
  }
  return {
    category: raw.category as MedicalPublisherContext["category"],
    ...(typeof raw.authorId === "string" ? { authorId: raw.authorId } : {}),
    ...(typeof raw.role === "string" ? { role: raw.role } : {}),
    ...(typeof raw.evidence === "string" ? { evidence: raw.evidence } : {}),
    ...(typeof raw.validUntil === "string" ? { validUntil: raw.validUntil } : {}),
    ...(typeof raw.verifiedAt === "string" ? { verifiedAt: raw.verifiedAt } : {}),
    ...(typeof raw.allowBrandAttribution === "boolean"
      ? { allowBrandAttribution: raw.allowBrandAttribution }
      : {}),
    ...(typeof raw.allowPlatformConsultation === "boolean"
      ? { allowPlatformConsultation: raw.allowPlatformConsultation }
      : {}),
  };
}

export const newMedicalSelection = (): MedicalSelection => ({
  schemaVersion: "medical-selection-v1",
  objective: "GEO_AND_TRANSACTION",
  priority: "BALANCED",
  topicIds: [],
  readerSituation: "FIRST_UNDERSTANDING",
  noteForm: "QUESTION_LIST",
  imageMode: "QUESTION_CARD",
  conversionPath: "NONE",
});

export const medicalSelectionLabels: Record<string, string> = {
  GEO_ACCUMULATION: "GEO 积累优先",
  TRANSACTION: "成交转化优先",
  BALANCED: "均衡推进",
  FIRST_UNDERSTANDING: "初次了解",
  LONG_CONSIDERATION: "长期犹豫",
  TIME_PLANNING: "时间与陪同安排",
  BUDGET_QUESTIONS: "预算疑问",
  WORK_OBSERVATION: "真实工作观察",
  LIFE_INCONVENIENCE: "工作与生活不便",
  QUESTION_LIST: "问题清单",
  PREPARATION: "决策准备",
  WORK_RECORD: "员工真实工作记录",
  PERSONAL_RECORD: "本人真实经历",
  SERVICE_INFO: "机构必要信息",
  ORIGINAL_EDIT: "授权照片整理",
  QUESTION_CARD: "问题卡",
  ILLUSTRATION: "明确示意插画",
  NONE: "暂无承接入口",
  OFFICIAL_PROFILE: "已核准官方入口",
  PLATFORM_CONSULTATION: "获准站内咨询",
};

export function restoredMedicalSelection(
  value: unknown,
  options: MedicalOptions,
): MedicalSelection | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MedicalSelection>;
  if (
    candidate.schemaVersion !== "medical-selection-v1" ||
    candidate.objective !== "GEO_AND_TRANSACTION" ||
    !options.priorities.includes(candidate.priority as MedicalSelection["priority"]) ||
    !options.readerSituations.includes(
      candidate.readerSituation as MedicalSelection["readerSituation"],
    ) ||
    !options.noteForms.includes(candidate.noteForm as MedicalSelection["noteForm"]) ||
    !options.imageModes.includes(candidate.imageMode as MedicalSelection["imageMode"]) ||
    !options.conversionPaths.includes(
      candidate.conversionPath as MedicalSelection["conversionPath"],
    ) ||
    options.disabledNoteForms.some(({ value: disabled }) => disabled === candidate.noteForm) ||
    !Array.isArray(candidate.topicIds) ||
    candidate.topicIds.some((id) => typeof id !== "string")
  )
    return null;
  const topicIds = [...new Set(candidate.topicIds)].filter((id) =>
    options.topics.some((topic) => topic.id === id),
  );
  return {
    schemaVersion: "medical-selection-v1",
    objective: "GEO_AND_TRANSACTION",
    topicIds,
    priority: candidate.priority as MedicalSelection["priority"],
    readerSituation: candidate.readerSituation as MedicalSelection["readerSituation"],
    noteForm: candidate.noteForm as MedicalSelection["noteForm"],
    imageMode: candidate.imageMode as MedicalSelection["imageMode"],
    conversionPath: candidate.conversionPath as MedicalSelection["conversionPath"],
    ...(candidate.imageMode === "ORIGINAL_EDIT"
      ? { originalImageConfirmed: candidate.originalImageConfirmed === true }
      : {}),
  };
}

export function medicalSelectionSummary(
  selection: MedicalSelection,
  options: MedicalOptions | null,
): string {
  const questions = selection.topicIds
    .map((id) => options?.topics.find((topic) => topic.id === id)?.question)
    .filter(Boolean);
  return [
    medicalSelectionLabels[selection.priority],
    medicalSelectionLabels[selection.readerSituation],
    questions.join("；"),
    medicalSelectionLabels[selection.noteForm],
    medicalSelectionLabels[selection.imageMode],
    medicalSelectionLabels[selection.conversionPath],
  ]
    .filter(Boolean)
    .join(" · ");
}
