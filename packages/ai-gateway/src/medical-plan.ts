export const MEDICAL_GENERATION_QUEUE = "campaign-generation-medical-v1";
export const MEDICAL_PLAN_EXECUTION_VERSION = "medical-plan-v1";

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

export type MedicalPublisherContext = {
  schemaVersion: "medical-publisher-v1";
  category: "ORDINARY" | "UNKNOWN" | "MEDICAL_KOS" | "INSTITUTION";
  authorId?: string;
  validUntil?: string;
  evidence?: string;
  verifiedAt?: string;
  verifiedBy?: string;
  role?: string;
  allowBrandAttribution: boolean;
  allowPlatformConsultation: boolean;
  experienceFacts?: string[];
};

export type MedicalPlan = MedicalSelection & {
  executionVersion: typeof MEDICAL_PLAN_EXECUTION_VERSION;
  topics: {
    id: string;
    seriesId: string;
    version: number;
    question: string;
    intent: string;
    entityId: string;
    entityName: string;
  }[];
  publishers: { membershipId: string; publisherContext: MedicalPublisherContext }[];
  frozenAt: string;
};

/** Saved plans are executable data. Unknown versions never fall back to the poster path. */
export function readMedicalPlan(value: unknown): MedicalPlan | undefined {
  if (value === null || value === undefined) return undefined;
  const plan = record(value);
  if (
    plan.schemaVersion !== "medical-selection-v1" ||
    plan.objective !== "GEO_AND_TRANSACTION" ||
    plan.executionVersion !== MEDICAL_PLAN_EXECUTION_VERSION
  )
    throw new Error("Invalid medical generation plan version");
  const selection: MedicalSelection = {
    schemaVersion: "medical-selection-v1",
    objective: "GEO_AND_TRANSACTION",
    priority: choice(plan.priority, ["GEO_ACCUMULATION", "TRANSACTION", "BALANCED"]),
    topicIds: strings(plan.topicIds),
    readerSituation: choice(plan.readerSituation, [
      "FIRST_UNDERSTANDING",
      "LONG_CONSIDERATION",
      "TIME_PLANNING",
      "BUDGET_QUESTIONS",
      "WORK_OBSERVATION",
      "LIFE_INCONVENIENCE",
    ]),
    noteForm: choice(plan.noteForm, [
      "QUESTION_LIST",
      "PREPARATION",
      "WORK_RECORD",
      "PERSONAL_RECORD",
      "SERVICE_INFO",
    ]),
    imageMode: choice(plan.imageMode, ["ORIGINAL_EDIT", "QUESTION_CARD", "ILLUSTRATION"]),
    conversionPath: choice(plan.conversionPath, [
      "NONE",
      "OFFICIAL_PROFILE",
      "PLATFORM_CONSULTATION",
    ]),
  };
  if (plan.originalImageConfirmed !== undefined) {
    if (typeof plan.originalImageConfirmed !== "boolean")
      throw new Error("Invalid medical image confirmation");
    selection.originalImageConfirmed = plan.originalImageConfirmed;
  }
  if (selection.imageMode === "ORIGINAL_EDIT" && selection.originalImageConfirmed !== true)
    throw new Error("Medical original image privacy confirmation is required");
  const topics = list(plan.topics).map((value) => {
    const topic = record(value);
    if (!Number.isInteger(topic.version) || Number(topic.version) < 1)
      throw new Error("Invalid medical topic version");
    return {
      id: text(topic.id),
      seriesId: text(topic.seriesId),
      version: Number(topic.version),
      question: text(topic.question),
      intent: optionalText(topic.intent) ?? "",
      entityId: optionalText(topic.entityId) ?? "",
      entityName: optionalText(topic.entityName) ?? "",
    };
  });
  const publishers = list(plan.publishers).map((value) => {
    const publisher = record(value);
    return {
      membershipId: text(publisher.membershipId),
      publisherContext: readMedicalPublisherContext(publisher.publisherContext),
    };
  });
  if (
    !topics.length ||
    !publishers.length ||
    !selection.topicIds.length ||
    selection.topicIds.some((id) => !topics.some((topic) => topic.id === id))
  )
    throw new Error("Incomplete medical generation plan");
  if (new Set(publishers.map((publisher) => publisher.membershipId)).size !== publishers.length)
    throw new Error("Duplicate medical publisher");
  return {
    ...selection,
    executionVersion: MEDICAL_PLAN_EXECUTION_VERSION,
    topics,
    publishers,
    frozenAt: date(plan.frozenAt),
  };
}

export function readMedicalPublisherContext(value: unknown): MedicalPublisherContext {
  const context = record(value);
  if (
    context.schemaVersion !== "medical-publisher-v1" ||
    typeof context.allowBrandAttribution !== "boolean" ||
    typeof context.allowPlatformConsultation !== "boolean"
  )
    throw new Error("Invalid medical publisher context");
  return {
    schemaVersion: "medical-publisher-v1",
    category: choice(context.category, ["ORDINARY", "UNKNOWN", "MEDICAL_KOS", "INSTITUTION"]),
    authorId: optionalText(context.authorId),
    validUntil: context.validUntil ? date(context.validUntil) : undefined,
    evidence: optionalText(context.evidence),
    verifiedAt: context.verifiedAt ? date(context.verifiedAt) : undefined,
    verifiedBy: optionalText(context.verifiedBy),
    role: optionalText(context.role),
    allowBrandAttribution: context.allowBrandAttribution,
    allowPlatformConsultation: context.allowPlatformConsultation,
    experienceFacts:
      context.experienceFacts === undefined ? undefined : strings(context.experienceFacts),
  };
}

export function medicalPublisherFor(
  plan: MedicalPlan,
  membershipId: string,
): MedicalPublisherContext {
  const publisher = plan.publishers.find(
    (publisher) => publisher.membershipId === membershipId,
  )?.publisherContext;
  if (!publisher) throw new Error("Medical publisher was not frozen for the member");
  assertMedicalPublisher(plan, publisher);
  return publisher;
}

export function medicalPlanForOrdinal(plan: MedicalPlan, ordinal: number): MedicalPlan {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error("Invalid medical member ordinal");
  const topic = plan.topics[(ordinal - 1) % plan.topics.length];
  if (!topic) throw new Error("Medical member question missing");
  return { ...plan, topicIds: [topic.id], topics: [topic] };
}

export function medicalOrdinalForMember(plan: MedicalPlan, membershipId: string): number {
  const index = plan.publishers.findIndex((publisher) => publisher.membershipId === membershipId);
  if (index < 0) throw new Error("Medical publisher was not frozen for the member");
  return index + 1;
}

export function assertMedicalPublisher(
  plan: MedicalSelection,
  publisher: MedicalPublisherContext,
  now = new Date(),
): void {
  const verified =
    (publisher.category === "MEDICAL_KOS" || publisher.category === "INSTITUTION") &&
    Boolean(
      publisher.evidence &&
        publisher.verifiedAt &&
        new Date(publisher.verifiedAt) <= now &&
        publisher.verifiedBy &&
        publisher.authorId &&
        publisher.validUntil &&
        new Date(publisher.validUntil) > now,
    );
  if (
    (publisher.allowBrandAttribution ||
      publisher.allowPlatformConsultation ||
      plan.noteForm === "WORK_RECORD" ||
      plan.noteForm === "SERVICE_INFO" ||
      plan.conversionPath !== "NONE") &&
    !verified
  )
    throw new Error("Medical publishing conditions are not verified or have expired");
  if (plan.noteForm === "WORK_RECORD" && !publisher.role)
    throw new Error("Medical work record requires a verified role");
  if (plan.noteForm === "SERVICE_INFO" && publisher.category !== "INSTITUTION")
    throw new Error("Medical service information requires the verified institution");
  if (plan.noteForm === "PERSONAL_RECORD")
    throw new Error(
      "Personal record requires confirmed personal facts bound to the member; this plan version has no bound evidence",
    );
  if (plan.conversionPath === "PLATFORM_CONSULTATION" && !publisher.allowPlatformConsultation)
    throw new Error("Medical consultation path is not approved");
  if (plan.conversionPath === "OFFICIAL_PROFILE" && !publisher.allowBrandAttribution)
    throw new Error("Medical official identity path is not approved");
}

export function medicalPublishingSafetyContext(
  plan: MedicalSelection,
  publisher: MedicalPublisherContext,
  now = new Date(),
) {
  return {
    schemaVersion: "medical-publishing-v1" as const,
    category: publisher.category,
    verified:
      (publisher.category === "MEDICAL_KOS" || publisher.category === "INSTITUTION") &&
      Boolean(
        publisher.evidence &&
          publisher.verifiedAt &&
          new Date(publisher.verifiedAt) <= now &&
          publisher.verifiedBy &&
          publisher.authorId &&
          publisher.validUntil &&
          new Date(publisher.validUntil) > now,
      ),
    role: publisher.role ?? null,
    allowBrandAttribution: publisher.allowBrandAttribution,
    allowPlatformConsultation: publisher.allowPlatformConsultation,
    conversionPath: plan.conversionPath,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid medical plan record");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid medical plan list");
  return value;
}
function strings(value: unknown): string[] {
  return list(value).map(text);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 12000)
    throw new Error("Invalid medical plan text");
  return value.trim();
}
function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : text(value);
}
function date(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid medical plan date");
  return result;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error("Invalid medical plan selection");
  return value as T;
}
