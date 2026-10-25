"use client";

import type { components } from "@xhs-agentic/contracts";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon } from "../../../components/action-icon";
import { ConsoleScopeSwitcher } from "../../../components/console-scope-switcher";
import { FeedbackMessage, useFeedbackToast } from "../../../components/feedback-toast";
import { MaterialThumbnail } from "../../../components/material-thumbnail";
import { MvpSetup } from "../../../components/mvp-setup";
import { PlatformName } from "../../../components/platform-branding";
import { SaasShell, StatusBadge } from "../../../components/saas-shell";
import { WorkspaceDrawer } from "../../../components/workspace-drawer";
import { formatBusinessDate } from "../../../lib/business-language";
import { CAMPAIGN_PREPARATION_MS, earliestCampaignSchedule } from "../../../lib/campaign-schedule";
import {
  ApiError,
  apiRequest,
  apiRequestAllCursorPages,
  consoleNavigationPermissions,
  selectedAdminRoleName,
} from "../../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../../lib/use-mvp-session";

type AudienceMode = "ALL" | "DEPARTMENT" | "SELECTED";
type Department = components["schemas"]["DepartmentResponseDto"];
type Material = components["schemas"]["MaterialResponseDto"];
type Membership = components["schemas"]["EnterpriseMembershipDto"];
type Preflight = components["schemas"]["GenerationPreflightResponseDto"];
type Workspace = components["schemas"]["EnterpriseWorkspaceSummaryDto"];
type RetrievalPreview = components["schemas"]["MaterialRetrievalResponseDto"];
type CopyInput = components["schemas"]["CampaignCopyInputDto"] & {
  selection?: unknown;
  selectionSnapshot?: unknown;
};
type CampaignTemplate = components["schemas"]["CampaignTemplateResponseDto"] & {
  selectionSnapshot?: unknown;
};
type PromptTemplate = components["schemas"]["PromptTemplateResponseDto"];
type TemplateDrawer = "CAMPAIGN" | "PROMPT";
type CampaignDraftEnvelope = components["schemas"]["CampaignDraftEnvelopeDto"];

export default function NewCampaignPage() {
  const auth = useMvpSession();
  const { notify, dismiss } = useFeedbackToast();
  const titleInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const scheduleInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [visibleAt, setVisibleAt] = useState(() =>
    localDateTime(new Date(Date.now() + 9 * 60 * 60_000)),
  );

  const [scheduleNow, setScheduleNow] = useState(0);
  useEffect(() => {
    setScheduleNow(Date.now());
    const timer = window.setInterval(() => setScheduleNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const contentSummary = prompt;
  const validationPrompt = prompt;
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("ALL");
  const [departmentId, setDepartmentId] = useState("");
  const [selectedMembershipIds, setSelectedMembershipIds] = useState<string[]>([]);
  const [imageCount, setImageCount] = useState(1);
  const [contentDirection, setContentDirection] = useState("");
  const [imageStyle, setImageStyle] = useState("");
  const [contentDirectionPresetId, setContentDirectionPresetId] = useState("");
  const [imageStylePresetId, setImageStylePresetId] = useState("");
  const [styleOptions, setStyleOptions] = useState<
    components["schemas"]["GenerationStyleOptionsResponseDto"] | null
  >(null);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [promptTemplateId, setPromptTemplateId] = useState("");
  const [reminderOffsetsHours, setReminderOffsetsHours] = useState<number[]>([6, 18]);
  const [campaignTemplates, setCampaignTemplates] = useState<CampaignTemplate[]>([]);
  const [campaignTemplateId, setCampaignTemplateId] = useState("");
  const [templateDrawer, setTemplateDrawer] = useState<TemplateDrawer | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [planningReady, setPlanningReady] = useState(false);
  const [draftCompatibilityFields, setDraftCompatibilityFields] = useState<Record<string, unknown>>(
    {},
  );
  const [draftStatus, setDraftStatus] = useState("正在读取草稿…");
  const [draftUnsaved, setDraftUnsaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalPreview | null>(null);
  const [referenceArtifactIds, setReferenceArtifactIds] = useState<string[] | undefined>();
  const [imagePreview, setImagePreview] = useState<{ title: string; src: string } | null>(null);
  // Choices survive draft restore. Scope changes clear them together with the draft.

  async function previewReference(image: NonNullable<RetrievalPreview["images"]>[number]) {
    if (!auth.session) return;
    setError(null);
    try {
      const root = `/console/tenants/${auth.session.tenantId}${image.enterpriseId ? `/enterprises/${image.enterpriseId}` : ""}`;
      const preview = await apiRequest<{ optimizedDataUrl: string | null }>(
        `${root}/materials/${image.materialId}/artifacts/${image.artifactId}/preview`,
        { token: auth.session.adminToken },
      );
      if (preview.optimizedDataUrl)
        setImagePreview({ title: image.fileName, src: preview.optimizedDataUrl });
    } catch (reason) {
      setError(messageOf(reason));
    }
  }
  const [step, setStep] = useState(1);
  const loadedWorkspace = useRef<string | null>(null);

  useEffect(() => {
    const session = auth.session;
    if (!session) {
      loadedWorkspace.current = null;
      return;
    }
    const workspaceKey = `${session.tenantId}:${session.enterpriseId}`;
    // Session renewal must not reload the draft over a user's in-progress edits.
    if (loadedWorkspace.current === workspaceKey) return;
    loadedWorkspace.current = null;
    let cancelled = false;
    const base = `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`;
    setLoading(true);
    setError(null);
    setAudienceMode("ALL");

    setDepartmentId("");
    setSelectedMembershipIds([]);
    setPlanningReady(false);
    setDraftCompatibilityFields({});
    setSelectionNotice("");
    setReferenceArtifactIds(undefined);
    setRetrieval(null);
    setDraftStatus("正在读取草稿…");
    const copyFrom = new URLSearchParams(window.location.search).get("copyFrom");
    void Promise.all([
      apiRequest<Workspace>(`${base}/workspace`, { token: session.adminToken }),
      apiRequestAllCursorPages<Membership>(`${base}/memberships`, {
        token: session.adminToken,
      }),
      apiRequest<Department[]>(`${base}/departments`, { token: session.adminToken }),
      apiRequest<Material[]>(`${base}/materials`, { token: session.adminToken }),
      apiRequest<PromptTemplate[]>(`${base}/campaign-planning/prompt-templates`, {
        token: session.adminToken,
      }),
      apiRequest<components["schemas"]["GenerationStyleOptionsResponseDto"]>(
        `${base}/campaign-planning/generation-styles`,
        { token: session.adminToken },
      ),
      apiRequest<CampaignTemplate[]>(`${base}/campaign-planning/campaign-templates`, {
        token: session.adminToken,
      }),
      apiRequest<CampaignDraftEnvelope>(`${base}/campaign-planning/draft`, {
        token: session.adminToken,
      }),
      copyFrom
        ? apiRequest<CopyInput>(`${base}/campaigns/${encodeURIComponent(copyFrom)}/copy-input`, {
            token: session.adminToken,
          }).catch((reason: unknown) => {
            if (!(reason instanceof ApiError) || reason.status !== 409) throw reason;
            if (!cancelled) setSelectionNotice(messageOf(reason));
            return null;
          })
        : Promise.resolve(null),
    ])
      .then(
        ([
          workspaceData,
          memberRows,
          departmentRows,
          materialRows,
          promptTemplateRows,
          generationStyles,
          campaignTemplateRows,
          draftEnvelope,
          copyInput,
        ]) => {
          if (cancelled) return;
          loadedWorkspace.current = workspaceKey;
          setStyleOptions(generationStyles);
          setPromptTemplates(promptTemplateRows);
          setContentDirection("");
          setContentDirectionPresetId("");
          setImageStyle("");
          setImageStylePresetId("");
          setPromptTemplateId("");
          setWorkspace(workspaceData);
          setMemberships([...memberRows]);
          setDepartments(departmentRows);
          setMaterials(materialRows);
          setCampaignTemplates(campaignTemplateRows);
          setDepartmentId(departmentRows[0]?.id ?? "");
          setImageCount(workspaceData.capabilities?.imagesPerDistribution ?? 1);
          if (copyInput) {
            setDraftCompatibilityFields(
              Array.isArray(copyInput.focusEntityIds)
                ? { focusEntityIds: [...copyInput.focusEntityIds] }
                : {},
            );
            setTitle(copyInput.title);
            setPrompt(copyInput.prompt);
            if (copyInput.selection ?? copyInput.selectionSnapshot) {
              setCampaignTemplateId("");
              setPrompt("");
              setSelectionNotice(
                "已保留历史活动设置。请重新填写主题和传播目标，历史医疗选项不会用于新的生成。",
              );
            }
            setVisibleAt(copiedVisibleAt(copyInput.visibleAt));
            setImageCount(
              Math.min(
                copyInput.imageCount,
                workspaceData.capabilities?.imagesPerDistribution ?? copyInput.imageCount,
              ),
            );
            setAudienceMode(copyInput.audienceMode);
            setDepartmentId(copyInput.departmentId ?? departmentRows[0]?.id ?? "");
            setSelectedMembershipIds([...copyInput.membershipIds]);
            if (!(copyInput.selection ?? copyInput.selectionSnapshot)) {
              setContentDirection(copyInput.contentDirection ?? "");
              setContentDirectionPresetId(
                copyInput.contentDirectionPresetId ??
                  generationStyles.contentDirections.find(
                    (p) => p.name === copyInput.contentDirection,
                  )?.id ??
                  "",
              );
              setImageStyle(copyInput.imageStyle ?? "");
              setImageStylePresetId(
                copyInput.imageStylePresetId ??
                  generationStyles.imageStyles.find((p) => p.name === copyInput.imageStyle)?.id ??
                  "",
              );
            }
            setReminderOffsetsHours([...copyInput.reminderOffsetsHours]);
            setDraftStatus("已从历史活动带入设置");
          } else if (!copyFrom && draftEnvelope.draft) {
            const payload = draftEnvelope.draft.payload;
            setDraftCompatibilityFields({
              ...(Array.isArray(payload.focusEntityIds)
                ? { focusEntityIds: draftStringArray(payload, "focusEntityIds") }
                : {}),
              ...(payload.logoArtifactId === null || typeof payload.logoArtifactId === "string"
                ? { logoArtifactId: payload.logoArtifactId }
                : {}),
            });

            setReferenceArtifactIds(
              Array.isArray(payload.referenceArtifactIds)
                ? draftStringArray(payload, "referenceArtifactIds")
                : undefined,
            );
            setTitle(draftText(payload, "title", ""));
            setPrompt(payload.selection ? "" : draftText(payload, "prompt", ""));
            setVisibleAt(draftVisibleAt(payload));
            setImageCount(
              Math.min(
                draftNumber(payload, "imageCount", 1),
                workspaceData.capabilities?.imagesPerDistribution ?? 1,
              ),
            );
            setAudienceMode(draftAudienceMode(payload));
            setDepartmentId(draftText(payload, "departmentId", departmentRows[0]?.id ?? ""));
            setSelectedMembershipIds(draftStringArray(payload, "membershipIds"));
            if (!payload.selection) {
              setContentDirection(draftText(payload, "contentDirection", ""));
              setContentDirectionPresetId(
                draftText(
                  payload,
                  "contentDirectionPresetId",
                  generationStyles.contentDirections.find(
                    (p) => p.name === payload.contentDirection,
                  )?.id ?? "",
                ),
              );
              setImageStyle(draftText(payload, "imageStyle", ""));
              setImageStylePresetId(
                draftText(
                  payload,
                  "imageStylePresetId",
                  generationStyles.imageStyles.find((p) => p.name === payload.imageStyle)?.id ?? "",
                ),
              );
              setPromptTemplateId(draftText(payload, "promptTemplateId", ""));
            }
            setReminderOffsetsHours(draftNumberArray(payload, "reminderOffsetsHours"));
            setCampaignTemplateId(draftText(payload, "campaignTemplateId", ""));
            if (payload.selection) {
              setSelectionNotice(
                "已保留历史草稿设置。请重新填写主题和传播目标，历史医疗选项不会用于新的生成。",
              );
              setCampaignTemplateId("");
            }
            setStep(payload.selection ? 1 : Math.min(4, Math.max(1, draftEnvelope.draft.step)));
            setDraftStatus(`已恢复 ${formatDraftTime(draftEnvelope.draft.updatedAt)} 的草稿`);
          } else {
            setTitle("");
            setPrompt("");
            setDraftStatus("尚未产生草稿，开始填写后会自动保存");
          }
          setPlanningReady(true);
        },
      )
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.session]);

  useEffect(() => {
    const session = auth.session;
    if (!session || !planningReady || loading || busy || (selectionNotice && !prompt.trim()))
      return;
    setDraftUnsaved(true);
    setDraftStatus("正在自动保存草稿…");
    const timer = window.setTimeout(() => {
      const base = `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`;
      void apiRequest(`${base}/campaign-planning/draft`, {
        body: {
          ...draftCompatibilityFields,
          ...campaignDraftBody({
            audienceMode,
            campaignTemplateId,
            contentDirection,
            contentDirectionPresetId,
            imageStyle,
            imageStylePresetId,
            promptTemplateId,
            departmentId,
            imageCount,
            membershipIds: selectedMembershipIds,
            prompt,
            reminderOffsetsHours,
            step,
            title,
            visibleAt,
          }),
          referenceArtifactIds,
        },
        method: "POST",
        token: session.adminToken,
      })
        .then(() => {
          setDraftUnsaved(false);
          setDraftStatus(`草稿已自动保存 · ${formatClock(new Date())}`);
        })
        .catch((reason: unknown) => {
          setDraftUnsaved(true);
          setDraftStatus(`草稿暂未保存：${messageOf(reason)}`);
        });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    referenceArtifactIds,
    audienceMode,
    auth.session,
    busy,
    campaignTemplateId,
    contentDirection,
    contentDirectionPresetId,
    imageStyle,
    imageStylePresetId,
    promptTemplateId,
    departmentId,

    imageCount,
    loading,
    draftCompatibilityFields,
    planningReady,
    selectionNotice,
    prompt,
    reminderOffsetsHours,
    selectedMembershipIds,
    step,
    title,
    visibleAt,
  ]);

  useEffect(() => {
    if (!draftUnsaved) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [draftUnsaved]);

  const eligibleMembers = useMemo(
    () =>
      memberships.filter(
        (membership) =>
          membership.seatStatus === "ENABLED" &&
          (membership.status === "ACTIVE" || membership.status === "PENDING_BIND") &&
          participationAllowsCampaign(membership),
      ),
    [memberships],
  );
  const activeEmploymentMembers = useMemo(
    () => memberships.filter(({ status }) => status === "ACTIVE" || status === "PENDING_BIND"),
    [memberships],
  );
  const notEnabledSeatCount = activeEmploymentMembers.filter(
    ({ seatStatus }) => seatStatus !== "ENABLED",
  ).length;
  const participationExcludedCount = activeEmploymentMembers.filter(
    (membership) => membership.seatStatus === "ENABLED" && !participationAllowsCampaign(membership),
  ).length;
  const audienceMembers = useMemo(() => {
    if (audienceMode === "DEPARTMENT") {
      return eligibleMembers.filter((membership) => membership.departmentId === departmentId);
    }
    if (audienceMode === "SELECTED") {
      const selected = new Set(selectedMembershipIds);
      return eligibleMembers.filter(({ id }) => selected.has(id));
    }
    return eligibleMembers;
  }, [audienceMode, departmentId, eligibleMembers, selectedMembershipIds]);
  const workspaceReady = Boolean(workspace?.steps.every(({ status }) => status !== "BLOCKING"));
  const activeMaterials = materials.filter(
    ({ authorizationStatus, ingestionStatus, status }) =>
      authorizationStatus === "AUTHORIZED" && ingestionStatus === "READY" && status === "ACTIVE",
  );
  const maxImages = workspace?.capabilities?.imagesPerDistribution ?? 1;
  const imageSelectionRequired = retrieval?.imageSelectionRequired === true;
  const referenceCandidates = useMemo(
    () =>
      (retrieval?.images ?? [])
        .filter((image) => image.usage === "REFERENCE" && image.score > 0)
        .slice(0, 5),
    [retrieval],
  );
  const selectedReferences =
    referenceArtifactIds === undefined
      ? imageSelectionRequired
        ? []
        : referenceCandidates.slice(0, 1).map((image) => image.artifactId)
      : referenceArtifactIds.filter((id) =>
          referenceCandidates.some((image) => image.artifactId === id),
        );

  useEffect(() => {
    if (!retrieval || referenceArtifactIds === undefined) return;
    const validIds = referenceArtifactIds.filter((id) =>
      referenceCandidates.some((image) => image.artifactId === id),
    );
    if (validIds.length !== referenceArtifactIds.length) setReferenceArtifactIds(validIds);
  }, [retrieval, referenceCandidates, referenceArtifactIds]);

  useEffect(() => {
    const session = auth.session;
    if (
      !session ||
      loading ||
      title.trim().length < 2 ||
      validationPrompt.trim().length < 4 ||
      audienceMembers.length === 0 ||
      !visibleAt
    ) {
      setPreflight(null);
      setRetrieval(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPreflightLoading(true);
      setPreflightError(null);
      const base = `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`;
      const requestBody = campaignRequestBody({
        audienceMembers,
        audienceMode,
        campaignTemplateId,
        contentDirection,
        contentDirectionPresetId,
        imageStyle,
        imageStylePresetId,
        promptTemplateId,
        departmentId,
        imageCount,
        prompt,
        reminderOffsetsHours,
        title,
        visibleAt: new Date(visibleAt).toISOString(),
      });
      void Promise.allSettled([
        apiRequest<Preflight>(`${base}/campaigns/preflight`, {
          body: requestBody,
          method: "POST",
          token: session.adminToken,
        }),
        apiRequest<RetrievalPreview>(`${base}/campaigns/retrieval-preview`, {
          body: requestBody,
          method: "POST",
          token: session.adminToken,
        }),
      ])
        .then(([preflightResult, retrievalResult]) => {
          if (controller.signal.aborted) return;
          if (preflightResult.status === "fulfilled") {
            setPreflight(preflightResult.value);
            setPreflightError(null);
          } else {
            setPreflight(null);
            setPreflightError(messageOf(preflightResult.reason));
          }
          if (retrievalResult.status === "fulfilled") setRetrieval(retrievalResult.value);
          else {
            setRetrieval(null);
            setPreflightError(messageOf(retrievalResult.reason));
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setPreflight(null);
            setRetrieval(null);
            setPreflightError(messageOf(reason));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreflightLoading(false);
        });
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    audienceMembers,
    audienceMode,
    auth.session,
    campaignTemplateId,
    contentDirection,
    contentDirectionPresetId,
    imageStyle,
    imageStylePresetId,
    promptTemplateId,
    departmentId,

    imageCount,
    loading,
    prompt,
    validationPrompt,
    reminderOffsetsHours,
    title,
    visibleAt,
  ]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const session = auth.session;
    if (!session || busy) return;
    if (step !== 4) {
      nextStep();
      return;
    }
    if (!styleOptions || unavailableStyle) {
      setStep(1);
      notifyStepError("请重新选择可用的内容方向、图片风格和传播要求模板。", 1);
      return;
    }
    for (const validationStep of [1, 2, 3]) {
      const reason = stepValidationMessage(validationStep, {
        audienceCount: audienceMembers.length,
        prompt: validationPrompt,
        title,
        visibleAt,
      });
      if (reason) {
        setStep(validationStep);
        notifyStepError(reason, validationStep);
        return;
      }
    }
    dismiss("campaign-step-validation");
    setBusy(true);
    setError(null);
    try {
      const campaign = await apiRequest<components["schemas"]["CampaignDetailDto"]>(
        `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}/campaigns`,
        {
          body: {
            ...campaignRequestBody({
              audienceMembers,
              audienceMode,
              campaignTemplateId,
              contentDirection,
              contentDirectionPresetId,
              imageStyle,
              imageStylePresetId,
              promptTemplateId,
              departmentId,
              imageCount,
              prompt,
              reminderOffsetsHours,
              title,
              visibleAt: new Date(visibleAt).toISOString(),
            }),
            referenceArtifactIds: retrieval ? selectedReferences : referenceArtifactIds,
          },
          method: "POST",
          token: session.adminToken,
        },
      );
      setPlanningReady(false);
      setDraftUnsaved(false);
      await apiRequest(
        `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}/campaign-planning/draft/clear`,
        { method: "POST", token: session.adminToken },
      ).catch(() => undefined);
      router.push(`/console/campaigns/${campaign.id}`);
    } catch (reason) {
      setError(messageOf(reason));
      setBusy(false);
    }
  }

  function applyCampaignTemplate(templateId: string) {
    setCampaignTemplateId(templateId);
    const template = campaignTemplates.find(({ id }) => id === templateId);
    if (!template) return;
    setTitle(template.title);
    setReferenceArtifactIds(undefined);
    setPrompt(template.prompt);
    if (template.selectionSnapshot) {
      setPrompt("");
      setCampaignTemplateId("");
      setPromptTemplateId("");
      setSelectionNotice(
        "已带入历史模板设置。请重新填写主题和传播目标，历史医疗选项不会用于新的生成。",
      );
      setContentDirection("");
      setContentDirectionPresetId("");
      setImageStyle("");
      setImageStylePresetId("");
      setImageCount(Math.min(template.imageCount, maxImages));
      setReminderOffsetsHours([...template.reminderOffsetsHours]);
      return;
    }
    setSelectionNotice("");
    setContentDirection(template.contentDirection ?? "");
    setContentDirectionPresetId(
      template.contentDirectionPresetId ??
        styleOptions?.contentDirections.find((p) => p.name === template.contentDirection)?.id ??
        "",
    );
    setImageStyle(template.imageStyle ?? "");
    setImageStylePresetId(
      template.imageStylePresetId ??
        styleOptions?.imageStyles.find((p) => p.name === template.imageStyle)?.id ??
        "",
    );
    setImageCount(Math.min(template.imageCount, maxImages));
    setReminderOffsetsHours([...template.reminderOffsetsHours]);
    setPromptTemplateId(template.promptTemplateId ?? "");
  }

  function applyPromptTemplate(templateId: string) {
    setPromptTemplateId(templateId);
    const template = promptTemplates.find(({ id }) => id === templateId);
    if (!template) return;
    setPrompt(template.content);
    setSelectionNotice("");
    setReferenceArtifactIds(undefined);
    setContentDirection(template.contentDirection ?? "");
    setContentDirectionPresetId(
      template.contentDirectionPresetId ??
        styleOptions?.contentDirections.find((p) => p.name === template.contentDirection)?.id ??
        "",
    );
  }

  function toggleReminder(offset: number) {
    setReminderOffsetsHours((current) =>
      current.includes(offset)
        ? current.filter((value) => value !== offset)
        : [...current, offset].sort((left, right) => left - right),
    );
  }

  async function createPlanningTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const session = auth.session;
    if (!session || !templateDrawer || !templateName.trim()) return;
    setTemplateBusy(true);
    setError(null);
    try {
      const base = `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}/campaign-planning`;
      if (templateDrawer === "PROMPT") {
        const created = await apiRequest<PromptTemplate>(`${base}/prompt-templates`, {
          body: {
            content: prompt,
            contentDirection,
            contentDirectionPresetId: contentDirectionPresetId || undefined,
            name: templateName,
          },
          method: "POST",
          token: session.adminToken,
        });
        setPromptTemplates((current) => [created, ...current]);
        setPromptTemplateId(created.id);
      } else {
        const created = await apiRequest<CampaignTemplate>(`${base}/campaign-templates`, {
          body: {
            contentDirection,
            contentDirectionPresetId,
            imageCount,
            imageStyle,
            imageStylePresetId,
            name: templateName,
            prompt,
            promptTemplateId: promptTemplateId || undefined,
            reminderOffsetsHours,
            title,
          },
          method: "POST",
          token: session.adminToken,
        });
        setCampaignTemplates((current) => [created, ...current]);
        setCampaignTemplateId(created.id);
      }
      setTemplateName("");
      setTemplateDrawer(null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setTemplateBusy(false);
    }
  }

  function toggleMembership(membershipId: string) {
    setSelectedMembershipIds((current) =>
      current.includes(membershipId)
        ? current.filter((id) => id !== membershipId)
        : [...current, membershipId],
    );
  }

  const unavailableStyle = Boolean(
    (promptTemplateId && !promptTemplates.some((template) => template.id === promptTemplateId)) ||
      (contentDirectionPresetId &&
        !styleOptions?.contentDirections.some((p) => p.id === contentDirectionPresetId)) ||
      (imageStylePresetId && !styleOptions?.imageStyles.some((p) => p.id === imageStylePresetId)),
  );

  function notifyStepError(content: string, validationStep: number) {
    notify({
      id: "campaign-step-validation",
      tone: "error",
      content,
      field:
        validationStep === 1
          ? title.trim().length < 2
            ? titleInput
            : promptInput
          : validationStep === 3
            ? scheduleInput
            : undefined,
    });
  }

  function nextStep() {
    if (!styleOptions || unavailableStyle) {
      setStep(1);
      notifyStepError("请重新选择可用的内容方向、图片风格和传播要求模板。", 1);
      return;
    }
    const reason = stepValidationMessage(step, {
      audienceCount: audienceMembers.length,
      prompt: validationPrompt,
      title,
      visibleAt,
    });
    if (reason) {
      notifyStepError(reason, step);
      return;
    }
    dismiss("campaign-step-validation");
    setStep((current) => Math.min(4, current + 1));
    window.scrollTo({ behavior: "smooth", top: 0 });
  }

  function previousStep() {
    dismiss("campaign-step-validation");
    setStep((current) => Math.max(1, current - 1));
    window.scrollTo({ behavior: "smooth", top: 0 });
  }

  if (auth.session === undefined) return <MvpLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }
  const scheduleError = stepValidationMessage(
    3,
    { audienceCount: audienceMembers.length, prompt: validationPrompt, title, visibleAt },
    scheduleNow || Date.now(),
  );
  const canGenerate =
    Boolean(styleOptions) &&
    !unavailableStyle &&
    workspaceReady &&
    !scheduleError &&
    Boolean(preflight?.ready) &&
    Boolean(retrieval?.hits.length) &&
    audienceMembers.length > 0 &&
    !busy &&
    !loading &&
    !preflightLoading;
  const attentionChecks = preflight?.checks.filter((check) => check.status !== "PASSED") ?? [];
  const generationBlockReason = loading
    ? "正在读取企业配置。"
    : !workspaceReady
      ? "请先完成企业的必要准备项。"
      : preflightLoading || (!preflight && !preflightError)
        ? "正在检查生成准备。"
        : scheduleError
          ? scheduleError
          : !preflight?.ready
            ? "生成服务暂不可用，请联系平台管理员处理。"
            : audienceMembers.length === 0
              ? "请选择至少一名员工。"
              : "未找到可引用资料，请调整传播目标或补充资料。";

  return (
    <SaasShell
      active="campaign-new"
      description="企业确定活动与发布安排，系统组织内容；员工只需领取、确认真实、发布和回填。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="创建营销活动"
      toolbar={
        <Link className="ghostButton backButton" href="/console/campaigns">
          返回活动列表
        </Link>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {!workspaceReady && workspace ? (
        <div className="inlineWarning">
          当前企业尚未满足活动前置条件。
          <Link href={workspace.nextAction.href}>{workspace.nextAction.title}</Link>
        </div>
      ) : null}
      <div className={`campaignDraftStatus ${draftUnsaved ? "pending" : ""}`} aria-live="polite">
        <span>{draftUnsaved ? "●" : "✓"}</span>
        <p>{draftStatus}</p>
      </div>

      <nav aria-label="创建活动步骤" className="campaignWizardSteps">
        {(
          [
            [1, "活动内容"],
            [2, "选择员工"],
            [3, "开放时间"],
            [4, "最终确认"],
          ] as const
        ).map(([number, label]) => (
          <button
            aria-current={step === number ? "step" : undefined}
            className={step === number ? "active" : number < step ? "complete" : ""}
            disabled={number > step}
            key={number}
            onClick={() => {
              setStep(Number(number));
              dismiss("campaign-step-validation");
            }}
            type="button"
          >
            <span>{number < step ? "✓" : number}</span>
            {label}
          </button>
        ))}
      </nav>

      {/* Hidden step controls otherwise block submission without a visible validation warning. */}
      <form
        className={`contentGrid formLayout campaignWizard ${step < 4 ? "singleStep" : ""}`}
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <div className="formStack">
          <article className="panel formPanel campaignWizardStep formFlow" hidden={step !== 1}>
            <div className="numberTitle">
              <span>1</span>
              <div>
                <h2>{"定义这次要传播什么"}</h2>
                <p>{"使用日常运营语言描述，不需要手工撰写内部母版或模型指令。"}</p>
              </div>
            </div>
            <section className="campaignTemplatePicker">
              <div>
                <span className="sectionKicker">复用团队经验</span>
                <strong>从已有模板开始，也可以重新选择</strong>
                <small>套用后仍可修改，不会影响原模板。</small>
              </div>
              <label className="field">
                <span>活动模板</span>
                <select
                  aria-label="活动模板"
                  onChange={(event) => applyCampaignTemplate(event.target.value)}
                  value={campaignTemplateId}
                >
                  <option value="">不使用活动模板</option>
                  {campaignTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>传播要求模板</span>
                <select
                  aria-label="传播要求模板"
                  onChange={(event) => applyPromptTemplate(event.target.value)}
                  value={promptTemplateId}
                >
                  <option value="">不使用传播要求模板</option>
                  {promptTemplateId &&
                  !promptTemplates.some((template) => template.id === promptTemplateId) ? (
                    <option value={promptTemplateId} disabled>
                      原模板已停用，请重新选择
                    </option>
                  ) : null}
                  {promptTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <label className="field">
              <span>活动名称</span>
              <input
                placeholder="例如：秋季新品分享活动"
                maxLength={200}
                minLength={2}
                ref={titleInput}
                onChange={(event) => setTitle(event.target.value)}
                required
                value={title}
              />
            </label>
            {
              <>
                {selectionNotice ? <p className="inlineWarning">{selectionNotice}</p> : null}
                <label className="field">
                  <span>主题和传播目标</span>
                  <textarea
                    aria-label="主题和传播目标"
                    placeholder="例如：介绍本季新品的使用场景和产品特点，结合品牌资料写成自然的小红书分享。"
                    maxLength={4000}
                    minLength={4}
                    ref={promptInput}
                    onChange={(event) => {
                      setPrompt(event.target.value);
                      setReferenceArtifactIds(undefined);
                    }}
                    required
                    rows={7}
                    value={prompt}
                  />
                  <small>{prompt.length} / 4000</small>
                </label>
              </>
            }
            <div className="fieldGrid">
              <StyleSelector
                label="内容方向"
                options={styleOptions?.contentDirections ?? []}
                value={contentDirectionPresetId}
                loading={!styleOptions}
                onChange={(id) => {
                  setContentDirectionPresetId(id);
                  setContentDirection(
                    styleOptions?.contentDirections.find((p) => p.id === id)?.name ?? "",
                  );
                }}
              />
              <StyleSelector
                label="图片风格"
                options={styleOptions?.imageStyles ?? []}
                value={imageStylePresetId}
                loading={!styleOptions}
                onChange={(id) => {
                  setImageStylePresetId(id);
                  setImageStyle(styleOptions?.imageStyles.find((p) => p.id === id)?.name ?? "");
                }}
              />
            </div>
            <div className="templateSaveActions">
              <button
                className="ghostButton"
                onClick={() => {
                  setTemplateName("");
                  setTemplateDrawer("PROMPT");
                }}
                type="button"
              >
                保存传播要求模板
              </button>
              <button
                className="ghostButton"
                onClick={() => {
                  setTemplateName("");
                  setTemplateDrawer("CAMPAIGN");
                }}
                type="button"
              >
                保存为活动模板
              </button>
            </div>
          </article>

          <article className="panel formPanel campaignWizardStep formFlow" hidden={step !== 2}>
            <div className="numberTitle">
              <span>2</span>
              <div>
                <h2>选择收到本期内容的员工</h2>
                <p>企业指定参与员工，系统为每名员工生成独立图文。</p>
              </div>
            </div>
            <div className="audienceModeGrid">
              <AudienceModeButton
                active={audienceMode === "ALL"}
                count={eligibleMembers.length}
                label="全部已启用员工"
                onClick={() => setAudienceMode("ALL")}
              />
              <AudienceModeButton
                active={audienceMode === "DEPARTMENT"}
                count={departments.length}
                disabled={departments.length === 0}
                label="按部门"
                onClick={() => setAudienceMode("DEPARTMENT")}
              />
              <AudienceModeButton
                active={audienceMode === "SELECTED"}
                count={selectedMembershipIds.length}
                label="指定员工"
                onClick={() => setAudienceMode("SELECTED")}
              />
            </div>

            <fieldset aria-label="活动受众资格拆解" className="audienceEligibilityBreakdown">
              <div>
                <span>组织内有效员工</span>
                <strong>{activeEmploymentMembers.length}</strong>
              </div>
              <div>
                <span>未启用任务资格</span>
                <strong>{notEnabledSeatCount}</strong>
              </div>
              <div>
                <span>待确认、暂停或免参与</span>
                <strong>{participationExcludedCount}</strong>
              </div>
              <div className="eligible">
                <span>本次可选择员工</span>
                <strong>{eligibleMembers.length}</strong>
              </div>
            </fieldset>

            {audienceMode === "DEPARTMENT" ? (
              <label className="field">
                <span>部门</span>
                <select
                  onChange={(event) => setDepartmentId(event.target.value)}
                  value={departmentId}
                >
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name} ·{" "}
                      {
                        eligibleMembers.filter(({ departmentId: id }) => id === department.id)
                          .length
                      }{" "}
                      人
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {audienceMode === "SELECTED" ? (
              <div className="audienceMemberPicker">
                <div>
                  <span>已选 {selectedMembershipIds.length} 人</span>
                  <button
                    className="textButton"
                    onClick={() =>
                      setSelectedMembershipIds(
                        selectedMembershipIds.length === eligibleMembers.length
                          ? []
                          : eligibleMembers.map(({ id }) => id),
                      )
                    }
                    type="button"
                  >
                    {selectedMembershipIds.length === eligibleMembers.length ? "清空" : "全选"}
                  </button>
                </div>
                <div>
                  {eligibleMembers.map((membership) => (
                    <label key={membership.id}>
                      <input
                        checked={selectedMembershipIds.includes(membership.id)}
                        onChange={() => toggleMembership(membership.id)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{membership.name}</strong>
                        <small>
                          {maskPhone(membership.phone)} ·{" "}
                          {departments.find(({ id }) => id === membership.departmentId)?.name ??
                            "未分部门"}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="selectionSummary">
              <div>
                <span>最终受众</span>
                <strong>{audienceMembers.length} 人</strong>
              </div>
            </div>
          </article>

          <article className="panel formPanel campaignWizardStep formFlow" hidden={step !== 3}>
            <div className="numberTitle">
              <span>3</span>
              <div>
                <h2>设置员工可查看素材的时间</h2>
                <p>内容生成后仍需人工审核；审核通过前，员工不会看到任何素材。</p>
              </div>
            </div>
            <div className="campaignCapabilityGrid">
              <div>
                <span>内容生成</span>
                <strong>平台统一路由</strong>
                <small>企业无需配置模型 API 或密钥</small>
              </div>
              <div>
                <span>{"独立生图"}</span>
                <strong>每人最多 {maxImages} 张</strong>
                <small>{"每名员工都会生成新的独立图片"}</small>
              </div>
              <label>
                <span>{"每人图片数"}</span>
                <select
                  onChange={(event) => setImageCount(Number(event.target.value))}
                  value={imageCount}
                >
                  {Array.from({ length: maxImages }, (_, index) => index + 1).map((count) => (
                    <option key={count} value={count}>
                      {""}
                      {count} 张
                    </option>
                  ))}
                </select>
                <small>当前租户策略最多 {maxImages} 张</small>
              </label>
            </div>
            <label className="field">
              <span>员工可查看素材的时间</span>
              <input
                ref={scheduleInput}
                onChange={(event) => setVisibleAt(event.target.value)}
                required
                type="datetime-local"
                value={visibleAt}
                min={
                  scheduleNow
                    ? localDateTime(new Date(earliestCampaignSchedule(scheduleNow, scheduleNow)))
                    : undefined
                }
              />
              <small>选择开放时间；生成并审核通过后即可开放。</small>
            </label>
            <section className="campaignReminderPolicy">
              <div>
                <span className="sectionKicker">未完成提醒策略</span>
                <strong>只提醒尚未提交链接的员工</strong>
                <small>
                  系统记录提醒时点并预留通知接口，不替员工发布，也不会改变 24 小时截止时间。
                </small>
              </div>
              <div className="reminderChoices">
                {[6, 12, 18].map((offset) => (
                  <label key={offset}>
                    <input
                      checked={reminderOffsetsHours.includes(offset)}
                      onChange={() => toggleReminder(offset)}
                      type="checkbox"
                    />
                    开放后 {offset} 小时
                  </label>
                ))}
              </div>
              {reminderOffsetsHours.length === 0 ? (
                <p>本期不安排系统提醒，运营仍可在活动看板查看未完成人员。</p>
              ) : (
                <p>
                  本期将在 {reminderOffsetsHours.map((offset) => `${offset} 小时`).join("、")}{" "}
                  检查未完成人员。
                </p>
              )}
            </section>
            <div className="materialRecallPreview">
              <div>
                <span className="sectionKicker">本次将引用的品牌资料</span>
                <strong>
                  {retrieval
                    ? `已找到 ${retrieval.hits.length} 条相关资料`
                    : `当前可用 ${workspace?.counts.effectiveMaterials ?? 0} 份生效素材`}
                </strong>
              </div>
              <p>系统选择与读者问题相关的已授权资料，并保存本次实际引用内容。</p>
              {retrieval ? (
                <section className="campaignReferences" aria-label="额外参考图片（可选）">
                  <div className="campaignReferenceHeader">
                    <strong>
                      {"额外参考图片"} <small>{"可选"}</small>
                    </strong>
                    {referenceCandidates.length ? (
                      <button
                        type="button"
                        className="ghostButton"
                        disabled={busy}
                        onClick={() => setReferenceArtifactIds(undefined)}
                      >
                        {imageSelectionRequired ? "清除图片选择" : "恢复推荐选择"}
                      </button>
                    ) : null}
                  </div>
                  <p role={imageSelectionRequired ? "status" : undefined}>
                    {imageSelectionRequired
                      ? "人物描述不够明确，参考图片不会自动引用。请自行确认以下候选图；不选择则不引用参考图片。最多展示 5 张，可选择 3 张。"
                      : referenceCandidates.length
                        ? "系统已推荐最相关的图片，可额外勾选或取消，无需操作也可继续。仅展示关联性最强的 5 张，最多使用 3 张参考图。"
                        : "未找到与本次主题匹配的参考图片，将按传播目标生成。"}
                  </p>
                  {referenceCandidates.length ? (
                    <div className="campaignReferenceGrid">
                      {referenceCandidates.map((image) => {
                        const selected = selectedReferences.includes(image.artifactId);
                        const root = `/console/tenants/${auth.session?.tenantId}${image.enterpriseId ? `/enterprises/${image.enterpriseId}` : ""}`;
                        return (
                          <article key={image.artifactId} data-selected={selected}>
                            <MaterialThumbnail
                              endpoint={`${root}/materials/${image.materialId}/artifacts/${image.artifactId}/preview`}
                              token={auth.session?.adminToken ?? ""}
                              label={image.fileName}
                              onClick={() => void previewReference(image)}
                            />
                            <label className="campaignReferenceChoice">
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={busy || (selectedReferences.length >= 3 && !selected)}
                                onChange={(event) => {
                                  const checked = event.target.checked;

                                  setReferenceArtifactIds((current) => {
                                    const selected =
                                      current ??
                                      (imageSelectionRequired
                                        ? []
                                        : referenceCandidates
                                            .slice(0, 1)
                                            .map((candidate) => candidate.artifactId));
                                    if (!checked)
                                      return selected.filter((id) => id !== image.artifactId);
                                    return selected.length >= 3 ||
                                      selected.includes(image.artifactId)
                                      ? selected
                                      : [...selected, image.artifactId];
                                  });
                                }}
                              />
                              <span title={image.fileName}>{image.fileName}</span>
                            </label>
                            <small title={image.description}>{image.description}</small>
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                  <p className="campaignLogoNotice">
                    {null}
                    {"品牌 Logo 自动叠加；有多个版本时按图片色调选择，只有一个时默认使用。"}
                  </p>
                </section>
              ) : null}
              {retrieval?.hits.length ? (
                <div className="retrievalEvidenceList">
                  {retrieval.hits.map((hit) => (
                    <article key={hit.chunkId}>
                      <div>
                        <strong>
                          {hit.rank}. {hit.materialTitle} · v{hit.materialVersion} ·{" "}
                          {hit.materialType === "IMAGE_REFERENCE" ? "图片" : "文字"}
                        </strong>
                        <span>{hit.enterpriseId ? "本企业资料" : "集团共享资料"}</span>
                      </div>
                      <p>{hit.snippet}</p>
                      <small>与本次主题相关度 {Math.round(hit.score * 100)}%</small>
                    </article>
                  ))}
                </div>
              ) : (
                <div>
                  {activeMaterials.slice(0, 4).map((material) => (
                    <span key={material.id}>{material.title}</span>
                  ))}
                </div>
              )}
            </div>
          </article>

          <WorkspaceDrawer
            open={Boolean(imagePreview)}
            onClose={() => setImagePreview(null)}
            title={imagePreview?.title ?? "参考图片"}
          >
            {imagePreview ? (
              <div className="materialPreview">
                <Image
                  src={imagePreview.src}
                  alt={imagePreview.title}
                  width={960}
                  height={960}
                  unoptimized
                />
              </div>
            ) : null}
          </WorkspaceDrawer>
          <article className="panel formPanel campaignFinalReview" hidden={step !== 4}>
            <div className="numberTitle">
              <span>4</span>
              <div>
                <h2>最后核对一次</h2>
                <p>提交后系统立即开始逐人生成，员工范围和本次引用资料将被固定。</p>
              </div>
            </div>
            <dl className="campaignReviewSummary">
              <div>
                <dt>活动</dt>
                <dd>{title}</dd>
              </div>
              <div>
                <dt>{"传播要求"}</dt>
                <dd>{contentSummary}</dd>
              </div>
              <div>
                <dt>内容策略</dt>
                <dd>
                  {styleOptions?.contentDirections.find(
                    (p) =>
                      p.id === contentDirectionPresetId ||
                      (!contentDirectionPresetId && p.isDefault),
                  )?.name ??
                    contentDirection ??
                    "默认内容方向"}{" "}
                  ·{" "}
                  {styleOptions?.imageStyles.find(
                    (p) => p.id === imageStylePresetId || (!imageStylePresetId && p.isDefault),
                  )?.name ??
                    imageStyle ??
                    "默认图片风格"}
                </dd>
              </div>
              <div>
                <dt>员工范围</dt>
                <dd>
                  {audienceSummary(audienceMode, audienceMembers.length, departments, departmentId)}
                </dd>
              </div>
              <div>
                <dt>员工开放时间</dt>
                <dd>
                  {visibleAt ? formatBusinessDate(new Date(visibleAt).toISOString()) : "尚未设置"}
                </dd>
              </div>
              <div>
                <dt>预计交付</dt>
                <dd>
                  {`${audienceMembers.length} 篇文案 + ${audienceMembers.length * imageCount} 张独立图片`}
                </dd>
              </div>
              <div>
                <dt>未完成提醒</dt>
                <dd>
                  {reminderOffsetsHours.length > 0
                    ? `开放后 ${reminderOffsetsHours.join("、")} 小时`
                    : "本期不安排系统提醒"}
                </dd>
              </div>
            </dl>
          </article>

          <div className="campaignWizardNavigation" hidden={step === 4}>
            {step > 1 ? (
              <button className="ghostButton" onClick={previousStep} type="button">
                上一步
              </button>
            ) : (
              <Link className="ghostButton" href="/console/campaigns">
                取消创建
              </Link>
            )}
            {step < 4 ? (
              <button className="primaryButton" onClick={nextStep} type="button">
                下一步
              </button>
            ) : null}
          </div>
        </div>

        <aside
          className="panel confirmationCard campaignConfirmationCard"
          hidden={step !== 4}
          aria-label="确认生成"
        >
          <h2>确认并生成</h2>
          <p>生成完成后需人工审核，审核通过才向员工开放。</p>
          <section className="campaignPreflight" aria-live="polite">
            <div>
              <span>生成准备</span>
              <StatusBadge
                tone={
                  busy || loading || preflightLoading || (!preflight && !preflightError)
                    ? "neutral"
                    : canGenerate
                      ? "success"
                      : "warning"
                }
              >
                {busy
                  ? "正在创建"
                  : loading || preflightLoading || (!preflight && !preflightError)
                    ? "检查中"
                    : canGenerate
                      ? "可生成"
                      : preflightError
                        ? "检查失败"
                        : "待处理"}
              </StatusBadge>
            </div>
            {preflightError ? <p className="dangerText">{preflightError}</p> : null}
            {!preflightLoading && attentionChecks.length ? (
              <ul>
                {attentionChecks.map((check) => (
                  <li data-status={check.status} key={check.code}>
                    <span aria-hidden="true">
                      <ActionIcon name={check.status === "WARNING" ? "clock-alert" : "x"} />
                    </span>
                    <div>
                      <strong>{check.title}</strong>
                      <small>{check.description}</small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {!canGenerate &&
            !busy &&
            !preflightError &&
            !attentionChecks.some((check) => check.status === "BLOCKING") ? (
              <p className="campaignGenerateHint">{generationBlockReason}</p>
            ) : null}
            {preflight?.estimatedWaitLevel === "DELAYED" && !preflightLoading ? (
              <p>当前生成任务较多，可能需要等待。</p>
            ) : null}
          </section>
          <div className="campaignGenerationActions">
            <button className="primaryButton block" disabled={!canGenerate} type="submit">
              {busy ? "正在创建生成任务…" : `生成 ${audienceMembers.length} 份独立图文`}
            </button>
            <button
              className="ghostButton block"
              disabled={busy}
              onClick={previousStep}
              type="button"
            >
              <ActionIcon name="arrow-left" />
              上一步
            </button>
          </div>
        </aside>
      </form>
      <WorkspaceDrawer
        description={
          templateDrawer === "PROMPT"
            ? "保存当前传播要求，后续活动可一键套用；保存后仍可在每期活动中继续修改。"
            : "保存当前活动名称、传播要求、内容方向、图片风格、图片数和提醒策略。员工范围与开放时间不会写入模板。"
        }
        onClose={() => setTemplateDrawer(null)}
        open={templateDrawer !== null}
        title={templateDrawer === "PROMPT" ? "保存传播要求模板" : "保存活动模板"}
      >
        <form
          className="drawerForm campaignTemplateForm"
          onSubmit={(event) => void createPlanningTemplate(event)}
        >
          <label className="field">
            <span>模板名称</span>
            <input
              maxLength={120}
              onChange={(event) => setTemplateName(event.target.value)}
              placeholder={
                templateDrawer === "PROMPT" ? "例如：新品日常分享" : "例如：每月品牌共创"
              }
              required
              value={templateName}
            />
          </label>
          <div className="templatePreviewCard">
            <span>将保存的内容</span>
            <strong>{templateDrawer === "PROMPT" ? contentDirection || "未分类" : title}</strong>
            <p>{prompt}</p>
          </div>
          <button className="primaryButton drawerSubmit" disabled={templateBusy} type="submit">
            {templateBusy ? "正在保存…" : "保存并立即使用"}
          </button>
        </form>
      </WorkspaceDrawer>
    </SaasShell>
  );
}

function participationAllowsCampaign(membership: Membership): boolean {
  const participation = membership.participation;
  if (!participation || participation.status === "PARTICIPATING") return true;
  return Boolean(
    participation.status === "PAUSED" &&
      participation.effectiveUntil &&
      new Date(participation.effectiveUntil) <= new Date(),
  );
}

function AudienceModeButton({
  active,
  count,
  disabled = false,
  label,
  onClick,
}: Readonly<{
  active: boolean;
  count: number;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}>) {
  return (
    <button
      aria-pressed={active}
      className={active ? "active" : ""}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <strong>{label}</strong>
      <span>{count}</span>
    </button>
  );
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function copiedVisibleAt(value: string): string {
  const copied = new Date(value);
  const now = Date.now();
  const minimum = new Date(earliestCampaignSchedule(now, now));
  return localDateTime(copied > minimum ? copied : minimum);
}

function campaignRequestBody(
  input: Readonly<{
    audienceMembers: readonly Membership[];
    audienceMode: AudienceMode;
    campaignTemplateId: string;
    contentDirection: string;
    contentDirectionPresetId: string;
    departmentId: string;
    imageCount: number;
    imageStyle: string;
    imageStylePresetId: string;
    prompt: string;
    promptTemplateId: string;
    reminderOffsetsHours: readonly number[];
    title: string;
    visibleAt: string;
  }>,
) {
  return {
    audienceMode: input.audienceMode,
    ...(input.audienceMode === "DEPARTMENT" ? { departmentId: input.departmentId } : {}),
    imageCount: input.imageCount,
    ...(input.campaignTemplateId ? { campaignTemplateId: input.campaignTemplateId } : {}),
    ...(input.contentDirectionPresetId
      ? { contentDirectionPresetId: input.contentDirectionPresetId }
      : {}),
    ...(input.imageStylePresetId ? { imageStylePresetId: input.imageStylePresetId } : {}),
    ...(input.audienceMode === "ALL"
      ? {}
      : { membershipIds: input.audienceMembers.map(({ id }) => id) }),
    prompt: input.prompt,
    ...(input.promptTemplateId ? { promptTemplateId: input.promptTemplateId } : {}),
    reminderOffsetsHours: [...input.reminderOffsetsHours],
    title: input.title,
    visibleAt: input.visibleAt,
  };
}

function campaignDraftBody(
  input: Readonly<{
    audienceMode: AudienceMode;
    campaignTemplateId: string;
    contentDirection: string;
    contentDirectionPresetId: string;
    departmentId: string;
    imageCount: number;
    imageStyle: string;
    imageStylePresetId: string;
    membershipIds: readonly string[];
    prompt: string;
    promptTemplateId: string;
    reminderOffsetsHours: readonly number[];
    step: number;
    title: string;
    visibleAt: string;
  }>,
) {
  return {
    audienceMode: input.audienceMode,
    campaignTemplateId: input.campaignTemplateId || undefined,
    contentDirection: input.contentDirection || undefined,
    contentDirectionPresetId: input.contentDirectionPresetId || undefined,
    departmentId: input.departmentId || undefined,
    imageCount: input.imageCount,
    imageStyle: input.imageStyle || undefined,
    imageStylePresetId: input.imageStylePresetId || undefined,
    membershipIds: [...input.membershipIds],
    prompt: input.prompt,
    promptTemplateId: input.promptTemplateId || undefined,
    reminderOffsetsHours: [...input.reminderOffsetsHours],
    step: input.step,
    title: input.title,
    visibleAt: input.visibleAt ? new Date(input.visibleAt).toISOString() : undefined,
  };
}

function draftText(payload: Record<string, unknown>, key: string, fallback: string): string {
  return typeof payload[key] === "string" ? payload[key] : fallback;
}

function draftNumber(payload: Record<string, unknown>, key: string, fallback: number): number {
  return typeof payload[key] === "number" && Number.isFinite(payload[key])
    ? payload[key]
    : fallback;
}

function draftStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function draftNumberArray(payload: Record<string, unknown>, key: string): number[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isInteger(item))
    : [6, 18];
}

function draftAudienceMode(payload: Record<string, unknown>): AudienceMode {
  const value = payload.audienceMode;
  return value === "DEPARTMENT" || value === "SELECTED" ? value : "ALL";
}

function draftVisibleAt(payload: Record<string, unknown>): string {
  const value = payload.visibleAt;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return localDateTime(new Date(Date.now() + 9 * 60 * 60_000));
  }
  return copiedVisibleAt(value);
}

function formatDraftTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

function formatClock(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function maskPhone(value: string): string {
  return value.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}

function audienceSummary(
  mode: AudienceMode,
  count: number,
  departments: readonly Department[],
  departmentId: string,
): string {
  if (mode === "DEPARTMENT") {
    return `${departments.find(({ id }) => id === departmentId)?.name ?? "所选部门"} · ${count} 人`;
  }
  if (mode === "SELECTED") return `指定员工 · ${count} 人`;
  return `全部已启用员工 · ${count} 人`;
}

function stepValidationMessage(
  step: number,
  values: Readonly<{
    audienceCount: number;
    prompt: string;
    title: string;
    visibleAt: string;
  }>,
  now = Date.now(),
): string | null {
  if (step === 1 && values.title.trim().length < 2) return "请填写便于团队识别的活动名称。";
  if (step === 1 && values.prompt.trim().length < 4) return "请说明本期希望传播的主题和重点。";
  if (step === 2 && values.audienceCount === 0) return "请至少选择一名会收到本期内容的员工。";
  if (step === 3 && !values.visibleAt) return "请设置员工可查看素材的时间。";
  if (
    step === 3 &&
    (!Number.isFinite(Date.parse(values.visibleAt)) ||
      Date.parse(values.visibleAt) < now + CAMPAIGN_PREPARATION_MS)
  ) {
    return "请选择当前或未来的开放时间。";
  }
  return null;
}

function MvpLoading() {
  return (
    <main className="setupScreen">
      <section aria-busy="true" aria-live="polite" className="sessionRestoreCard">
        <span aria-hidden="true" className="sessionRestoreMark">
          <i />
        </span>
        <p className="sessionRestoreEyebrow" suppressHydrationWarning>
          <PlatformName />
        </p>
        <h1 suppressHydrationWarning>正在恢复本机会话…</h1>
        <p className="sessionRestoreDetail">正在确认你的身份与工作区配置</p>
        <span aria-hidden="true" className="sessionRestoreProgress" />
      </section>
    </main>
  );
}

function StyleSelector({
  label,
  options,
  value,
  onChange,
  loading,
}: {
  label: string;
  options: components["schemas"]["GenerationStyleOptionDto"][];
  value: string;
  onChange: (value: string) => void;
  loading: boolean;
}) {
  const selected = options.find((p) => (value ? p.id === value : p.isDefault));
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={loading}
      >
        <option value="">
          使用平台默认
          {options.find((p) => p.isDefault) ? `（${options.find((p) => p.isDefault)?.name}）` : ""}
        </option>
        {value && !selected ? (
          <option value={value} disabled>
            原预设已停用，请重新选择
          </option>
        ) : null}
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <small>
        {value && !selected
          ? "此预设已停用或不可用，请选择其他预设。"
          : selected?.description || "无需填写提示词，系统会应用平台设置。"}
      </small>
    </label>
  );
}
