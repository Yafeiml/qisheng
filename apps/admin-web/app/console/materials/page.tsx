"use client";

import type { components } from "@xhs-agentic/contracts";
import Image from "next/image";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionConfirmDialog } from "../../components/action-confirm-dialog";
import { ActionIcon } from "../../components/action-icon";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage, useFeedbackToast } from "../../components/feedback-toast";
import { MaterialThumbnail } from "../../components/material-thumbnail";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { WorkspaceTabs } from "../../components/workspace-tabs";
import { copyBrowserText, randomBrowserId } from "../../lib/browser-capabilities";
import {
  apiRequest,
  consoleNavigationPermissions,
  selectedAdminRoleName,
  storageObjectUrl,
  trackedFetch,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";
import {
  materialAutomaticallyRetrying,
  materialCanManuallyRetry,
  materialFailureDiagnostic,
  materialFailureGuide,
} from "./material-failure-guide";
import styles from "./materials.module.css";

type Material = components["schemas"]["MaterialResponseDto"];
type MaterialPreview = components["schemas"]["MaterialArtifactPreviewResponseDto"];
type UploadIntent = components["schemas"]["MaterialUploadIntentResponseDto"];
type RevisionResponse = { materialId: string; intents: UploadIntent[] };
type MaterialView = "ALL" | "USABLE" | "PROCESSING" | "NEEDS_INPUT" | "FAILED";
type Upload = {
  description?: string;
  usage?: "REFERENCE" | "LOGO";
  id: string;
  file: File;
  intent?: UploadIntent;
  uploaded?: boolean;
  status: "WAITING" | "UPLOADING" | "DONE" | "FAILED";
  error?: string;
};
const BUNDLE_PARSER_VERSION = "material-ai-bundle-v1";
type MedicalMaterial = {
  schemaVersion: "medical-material-v1";
  purpose: "ANSWER_EVIDENCE" | "REAL_SCENE" | "ARCHIVE";
  sceneType?: "ENVIRONMENT" | "ROUTE" | "OBJECT" | "WORKSPACE" | "OTHER";
  question?: string;
  sourceNote?: string;
  privacyConfirmed?: boolean;
};
const medicalPurposeLabels = {
  ANSWER_EVIDENCE: "问题依据",
  REAL_SCENE: "可选实拍",
  ARCHIVE: "历史 / 归档",
} as const;

function medicalMaterialOf(material: Material): MedicalMaterial | null {
  const value = material.structuredFacts?.medicalMaterial;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Partial<MedicalMaterial>;
  return metadata.schemaVersion === "medical-material-v1" &&
    metadata.purpose &&
    Object.hasOwn(medicalPurposeLabels, metadata.purpose)
    ? (metadata as MedicalMaterial)
    : null;
}

export default function MaterialsPage() {
  const auth = useMvpSession();
  const feedback = useFeedbackToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const descriptionInputs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [materials, setMaterials] = useState<Material[]>([]);
  const [filter, setFilter] = useState<MaterialView>("ALL");
  const [scopeFilter, setScopeFilter] = useState("ALL");
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [scope, setScope] = useState("ENTERPRISE");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [restoreArtifactIds, setRestoreArtifactIds] = useState<string[]>([]);
  const [intakeType, setIntakeType] = useState<"TEXT" | "IMAGE_REFERENCE">("TEXT");
  const [libraryType, setLibraryType] = useState<"ALL" | "TEXT" | "IMAGE_REFERENCE">("ALL");
  const [removedArtifactIds, setRemovedArtifactIds] = useState<string[]>([]);
  const [attachmentDescriptions, setAttachmentDescriptions] = useState<
    Record<string, { description: string; usage: "REFERENCE" | "LOGO" }>
  >({});
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [supplementing, setSupplementing] = useState<Material | null>(null);
  const [supplement, setSupplement] = useState("");
  const [pendingDisable, setPendingDisable] = useState<Material | null>(null);
  const [preview, setPreview] = useState<{
    title: string;
    text: string;
    optimizedDataUrl: string | null;
    image: boolean;
  } | null>(null);
  const [attachmentList, setAttachmentList] = useState<Material | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const authorizationInput = useRef<HTMLInputElement>(null);

  const medicalMaterial = editing ? (medicalMaterialOf(editing) ?? undefined) : undefined;

  function showSupplement(material: Material) {
    setSupplementing(material);
    setSupplement(material.supplement ?? "");
    setError(null);
    setAuthorizationConfirmed(false);
  }

  async function copyFailureDiagnostic(material: Material) {
    setError(null);
    try {
      await copyBrowserText(materialFailureDiagnostic(material));
      feedback.notify({ tone: "success", content: "排查信息已复制，可发给平台管理员定位问题。" });
    } catch {
      feedback.notify({
        tone: "error",
        content: "复制未完成，请展开“排查信息”手动复制后交给管理员。",
      });
    }
  }

  const canManageShared = Boolean(
    auth.session?.adminAccess.scopes.some(
      (item) =>
        item.scopeType === "TENANT" &&
        item.tenant?.id === auth.session?.tenantId &&
        item.permissions.includes("material.manage"),
    ),
  );
  const load = useCallback(async () => {
    if (!auth.session) return;
    try {
      setMaterials(
        await apiRequest<Material[]>(
          `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/materials`,
          { token: auth.session.adminToken },
        ),
      );
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session]);
  useEffect(() => {
    void load();
  }, [load]);
  // Disabled versions remain in the audit/history data but are not part of the working library.
  // Keep an older ACTIVE version visible while its replacement is still being processed:
  // that version can still be used for generation until the replacement becomes usable.
  const activeMaterials = useMemo(
    () => materials.filter((material) => material.status === "ACTIVE"),
    [materials],
  );
  const processing = activeMaterials.some(isProcessing);
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 4000);
    return () => clearInterval(timer);
  }, [load, processing]);

  const visibleMaterials = useMemo(
    () =>
      activeMaterials.filter((material) => {
        const query = search.trim().toLowerCase();
        return (
          material.status === "ACTIVE" &&
          (libraryType === "ALL" ||
            (libraryType === "IMAGE_REFERENCE"
              ? material.type === "IMAGE_REFERENCE"
              : material.type !== "IMAGE_REFERENCE")) &&
          (filter === "ALL" || materialView(material) === filter) &&
          (scopeFilter === "ALL" ||
            (scopeFilter === "SHARED"
              ? material.enterpriseId === null
              : material.enterpriseId !== null)) &&
          (!expiringOnly ||
            (material.status === "ACTIVE" &&
              material.expiresAt &&
              new Date(material.expiresAt).getTime() <= Date.now() + 30 * 86400000)) &&
          (!query ||
            [
              material.title,
              material.content,
              ...material.tags,
              ...material.artifacts.map((artifact) => artifact.originalFileName ?? ""),
            ].some((value) => value.toLowerCase().includes(query)))
        );
      }),
    [activeMaterials, filter, scopeFilter, search, expiringOnly, libraryType],
  );

  function materialRoot(material?: Material) {
    if (!auth.session) throw new Error("请先登录");
    const shared = material ? material.enterpriseId === null : scope === "SHARED";
    return `/console/tenants/${auth.session.tenantId}${shared ? "" : `/enterprises/${auth.session.enterpriseId}`}`;
  }

  function beginCreate(material?: Material, type: "TEXT" | "IMAGE_REFERENCE" = "TEXT") {
    setIntakeType(material?.type === "IMAGE_REFERENCE" ? "IMAGE_REFERENCE" : type);
    setRemovedArtifactIds([]);
    setAttachmentDescriptions({});
    setEditing(material ?? null);
    setText(
      material
        ? material.type === "TEXT"
          ? (material.sourceText ?? material.content)
          : (material.supplement ?? "")
        : "",
    );
    setScope(material?.enterpriseId === null ? "SHARED" : "ENTERPRISE");
    setUploads([]);
    setRestoreArtifactIds([]);
    setRevisionId(
      material?.parserVersion === BUNDLE_PARSER_VERSION && !material.ingestionJobs.length
        ? material.id
        : null,
    );
    setError(null);
    setNotice(null);
    setAuthorizationConfirmed(false);
    setEditorOpen(true);
  }

  function addFiles(files: File[]) {
    if (busy) return;
    const added: Upload[] = [];
    const errors: string[] = [];
    for (const file of files) {
      if (file.size < 1) {
        errors.push(
          `“${file.name}”读取到的大小为 0 字节，无法上传。请确认文件已保存且有内容，再通过“选择文件”添加。`,
        );
        continue;
      }
      if (file.size > 25 * 1024 * 1024) {
        errors.push(
          `“${file.name}”大小为 ${(file.size / 1024 / 1024).toFixed(2)} MiB，超过单个文件 25 MiB 的限制。`,
        );
        continue;
      }
      if (!supportedFile(file)) {
        errors.push(`“${file.name}”格式不受支持。支持 PDF、DOCX、TXT、Markdown、JPEG、PNG、WebP。`);
        continue;
      }
      if (
        !editing &&
        (fileType(file) === "IMAGE_REFERENCE") !== (intakeType === "IMAGE_REFERENCE")
      ) {
        errors.push(
          intakeType === "IMAGE_REFERENCE"
            ? "图片入口仅接受 JPEG、PNG、WebP。文档请使用文字资料入口。"
            : "请通过图片素材入口上传图片并填写说明。",
        );
        continue;
      }
      if (editing && (editing.type === "TEXT" || fileType(file) !== editing.type)) {
        errors.push(`“${file.name}”与原资料类型不一致，请选择对应的文档或图片。`);
        continue;
      }
      if (
        !uploads.some(
          (item) =>
            item.file.name === file.name &&
            item.file.size === file.size &&
            item.file.lastModified === file.lastModified,
        )
      ) {
        added.push({ id: randomBrowserId(), file, status: "WAITING" });
      }
    }
    setUploads((current) => [...current, ...added].slice(0, 20));
    if (uploads.length + added.length > 20) errors.push("每次最多添加 20 个文件，请分批上传。");
    setError(null);
    if (errors.length) {
      feedback.notify({ tone: "error", content: errors.join("\n"), field: fileInput });
    } else feedback.clearFieldError(fileInput);
  }

  async function saveMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;

    if (!authorizationConfirmed) {
      feedback.notify({
        tone: "error",
        content: "请确认拥有资料的使用权并获准用于本企业内容。",
        field: authorizationInput,
      });
      return;
    }

    if (editing && editing.type !== "TEXT") {
      await saveRevision();
      return;
    }
    const missingDescription = uploads.find((item) => !(item.description?.trim() || text.trim()));
    if (!editing && intakeType === "IMAGE_REFERENCE" && (!uploads.length || missingDescription)) {
      feedback.notify({
        tone: "error",
        content: "请添加图片，并填写公共说明或每张图片的说明，帮助 AI 确认主体、归属与场景。",
        field: missingDescription
          ? (descriptionInputs.current[missingDescription.id] ?? null)
          : fileInput,
      });
      return;
    }
    if (!text.trim() && !uploads.length) {
      feedback.notify({ tone: "error", content: "请粘贴文字或添加文件。", field: textInput });
      return;
    }
    if (editing && editing.type !== "TEXT" && !uploads.length) {
      feedback.notify({ tone: "error", content: "请选择新版本文件。", field: fileInput });
      return;
    }
    if (uploads.length && text.length > 5000) {
      feedback.notify({ tone: "error", content: "文件补充说明最多 5000 字。", field: textInput });
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const token = auth.session.adminToken;
    try {
      const root = materialRoot(editing ?? undefined);
      if (!uploads.length) {
        await apiRequest(
          editing ? `${root}/materials/${editing.id}/versions` : `${root}/materials`,
          {
            body: {
              authorizationConfirmed,
              medicalMaterial,
              content: text.trim(),
              type: "TEXT",
              changeNote: editing ? "更新资料内容" : undefined,
            },
            method: "POST",
            token,
          },
        );
        setEditorOpen(false);
        setNotice("文字已保存，AI 将自动整理标题和关键词。");
      } else {
        let completed = uploads.filter((item) => item.status === "DONE").length;
        for (const item of uploads.filter((entry) => entry.status !== "DONE")) {
          const updated = {
            ...item,
            status: "UPLOADING" as Upload["status"],
            error: undefined as string | undefined,
          };
          const update = () =>
            setUploads((current) =>
              current.map((entry) => (entry.id === item.id ? { ...updated } : entry)),
            );
          update();
          try {
            updated.intent ??= await apiRequest<UploadIntent>(`${root}/material-upload-intents`, {
              body: {
                authorizationConfirmed,
                medicalMaterial,
                byteSize: item.file.size,
                checksum: await fileSha256(item.file),
                fileName: item.file.name,
                mimeType: mimeType(item.file),
                type: fileType(item.file),
                supplement:
                  [text.trim(), item.description?.trim()].filter(Boolean).join("\n") || undefined,
                usage: item.usage ?? "REFERENCE",
                supersedesId: editing?.id,
                changeNote: editing ? "更新资料文件" : undefined,
              },
              method: "POST",
              token,
            });
            update();
            if (!updated.uploaded) {
              const response = await trackedFetch(storageObjectUrl(updated.intent.uploadUrl), {
                body: item.file,
                headers: updated.intent.headers,
                method: "PUT",
              });
              if (!response.ok) throw new Error("文件上传失败，请重试。");
              updated.uploaded = true;
              update();
            }
            await apiRequest(
              `${root}/materials/${updated.intent.materialId}/artifacts/${updated.intent.artifactId}/complete`,
              {
                body: { uploadCompleted: true },
                method: "POST",
                token,
              },
            );
            updated.status = "DONE";
            completed++;
          } catch (reason) {
            updated.status = "FAILED";
            updated.error = messageOf(reason);
          }
          update();
        }
        setNotice(
          `已提交 ${completed} 份资料，AI 将在后台继续整理。${completed < uploads.length ? "其余文件可单独重试。" : ""}`,
        );
        if (completed === uploads.length) setEditorOpen(false);
      }
      setFilter("PROCESSING");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveRevision() {
    if (!editing || !auth.session) return;
    const explanation = text.trim();
    if (
      !revisionId &&
      !uploads.length &&
      !restoreArtifactIds.length &&
      !removedArtifactIds.length &&
      !Object.keys(attachmentDescriptions).length &&
      explanation === (editing.supplement ?? "")
    ) {
      feedback.notify({ tone: "error", content: "请修改资料说明或添加附件。", field: textInput });
      return;
    }
    if (revisionId && editing.id === revisionId) {
      const waiting = editing.artifacts.filter((artifact) => artifact.status === "PENDING_UPLOAD");
      if (waiting.length && uploads.length !== waiting.length) {
        feedback.notify({
          tone: "error",
          content: `请选择全部 ${waiting.length} 个待上传附件，再继续更新。`,
          field: fileInput,
        });
        return;
      }
    }
    const previousCount = [
      ...new Set(
        materials
          .filter((item) => item.seriesId === editing.seriesId)
          .flatMap((item) => item.artifacts)
          .filter(
            (artifact) =>
              (artifact.status === "STORED" || artifact.status === "VERIFIED") &&
              !removedArtifactIds.includes(artifact.id) &&
              (editing.artifacts.some((current) => current.id === artifact.id) ||
                restoreArtifactIds.includes(artifact.id)),
          )
          .map((artifact) => artifact.checksum ?? artifact.id),
      ),
    ].length;
    if (!previousCount && !uploads.length) {
      if (await materialAction(editing, "disable", "移除全部附件，停止后续使用"))
        setEditorOpen(false);
      return;
    }
    if (previousCount + uploads.length > 20) {
      feedback.notify({
        tone: "error",
        content: "新旧附件合计最多 20 个，请减少本次添加的文件。",
        field: fileInput,
      });
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const root = materialRoot(editing);
    const token = auth.session.adminToken;
    try {
      let targetId = revisionId;
      let queuedUploads = uploads;
      const fileMetadata = async () => {
        const files = [];
        for (const item of uploads) {
          files.push({
            byteSize: item.file.size,
            checksum: await fileSha256(item.file),
            fileName: item.file.name,
            mimeType: mimeType(item.file),
            description: item.description ?? "",
            usage: item.usage ?? "REFERENCE",
          });
        }
        return files;
      };
      if (!targetId) {
        const revision = await apiRequest<RevisionResponse>(
          `${root}/materials/${editing.id}/revision`,
          {
            body: {
              authorizationConfirmed,
              medicalMaterial,
              files: await fileMetadata(),
              restoreArtifactIds,
              removeArtifactIds: removedArtifactIds,
              attachmentDescriptions: Object.entries(attachmentDescriptions)
                .filter(([id]) => !removedArtifactIds.includes(id))
                .map(([artifactId, value]) => ({ artifactId, ...value })),
              supplement: explanation,
            },
            method: "POST",
            token,
          },
        );
        targetId = revision.materialId;
        setRevisionId(targetId);
        queuedUploads = uploads.map((item, index) => ({
          ...item,
          intent: revision.intents[index],
        }));
        setUploads(queuedUploads);
      } else if (queuedUploads.some((item) => !item.intent)) {
        const resumed = await apiRequest<RevisionResponse>(
          `${root}/materials/${targetId}/revision/resume`,
          {
            body: { authorizationConfirmed, files: await fileMetadata() },
            method: "POST",
            token,
          },
        );
        queuedUploads = uploads.map((item, index) => ({ ...item, intent: resumed.intents[index] }));
        setUploads(queuedUploads);
      }
      let completed = queuedUploads.filter((item) => item.status === "DONE").length;
      for (const item of queuedUploads.filter((entry) => entry.status !== "DONE")) {
        const updated = {
          ...item,
          status: "UPLOADING" as Upload["status"],
          error: undefined as string | undefined,
        };
        const update = () =>
          setUploads((current) =>
            current.map((entry) => (entry.id === item.id ? { ...updated } : entry)),
          );
        update();
        try {
          if (!updated.intent) throw new Error("上传链接已失效，请重新选择文件。");
          if (!updated.uploaded) {
            const response = await trackedFetch(storageObjectUrl(updated.intent.uploadUrl), {
              body: item.file,
              headers: updated.intent.headers,
              method: "PUT",
            });
            if (!response.ok) throw new Error("文件上传失败，请重试。");
            updated.uploaded = true;
            update();
          }
          await apiRequest(
            `${root}/materials/${targetId}/artifacts/${updated.intent.artifactId}/complete`,
            { body: { uploadCompleted: true }, method: "POST", token },
          );
          updated.status = "DONE";
          completed++;
        } catch (reason) {
          updated.status = "FAILED";
          updated.error = messageOf(reason);
        }
        update();
      }
      if (completed !== queuedUploads.length) {
        setError("部分新附件尚未完成上传，原版本仍可使用。请重试未完成的文件。");
        return;
      }
      await apiRequest(`${root}/materials/${targetId}/revision/finalize`, {
        method: "POST",
        token,
      });
      setEditorOpen(false);
      setRevisionId(null);
      setFilter("PROCESSING");
      setNotice("资料已更新，保留的附件将重新整理；历史活动引用不变。");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveSupplement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !supplementing) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`${materialRoot(supplementing)}/materials/${supplementing.id}/supplement`, {
        body: { supplement: supplement.trim() },
        method: "POST",
        token: auth.session.adminToken,
      });
      setSupplementing(null);
      setSupplement("");
      setFilter("PROCESSING");
      setNotice("说明已保存，AI 会重新整理关键词并检查是否可以使用。");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function reanalyzePictures(material: Material) {
    if (!auth.session) return;
    if (!material.supplement?.trim()) {
      beginCreate(material);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`${materialRoot(material)}/materials/${material.id}/supplement`, {
        body: { supplement: material.supplement },
        method: "POST",
        token: auth.session.adminToken,
      });
      setNotice("已提交逐图整理，保留原文件和说明；每张图片将单独判断是否可用。");
      setFilter("PROCESSING");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function materialAction(
    material: Material,
    action: "disable" | "ingestion/retry",
    reason: string,
  ) {
    if (!auth.session) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`${materialRoot(material)}/materials/${material.id}/${action}`, {
        body: { reason },
        method: "POST",
        token: auth.session.adminToken,
      });
      setPendingDisable(null);
      setNotice(
        action === "disable"
          ? "资料已停用，历史活动引用保持不变。"
          : "资料已重新进入 AI 处理队列。",
      );
      await load();
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function previewMaterial(material: Material, artifactId?: string) {
    if (!auth.session) return;
    const artifact = material.artifacts.find(
      (item) =>
        (!artifactId || item.id === artifactId) &&
        (item.status === "STORED" || item.status === "VERIFIED"),
    );
    if (!artifact) return;
    setPreviewLoadingId(material.id);
    setError(null);
    try {
      const result = await apiRequest<MaterialPreview>(
        `${materialRoot(material)}/materials/${material.id}/artifacts/${artifact.id}/preview`,
        { token: auth.session.adminToken },
      );
      setPreview({
        title: artifact.originalFileName ?? material.title,
        text: material.sourceText ?? material.content,
        optimizedDataUrl: result.optimizedDataUrl,
        image: material.type === "IMAGE_REFERENCE",
      });
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setPreviewLoadingId(null);
    }
  }

  async function finalizePendingRevision(material: Material) {
    if (!auth.session) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`${materialRoot(material)}/materials/${material.id}/revision/finalize`, {
        method: "POST",
        token: auth.session.adminToken,
      });
      setNotice("已提交资料更新，AI 将整理现有附件。");
      setFilter("PROCESSING");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  if (auth.session === undefined)
    return (
      <main className="setupScreen">
        {/* Font extensions may inject attributes before hydration on this static heading. */}
        <h1 suppressHydrationWarning>正在读取品牌资料…</h1>
      </main>
    );
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  const counts = {
    ALL: activeMaterials.length,
    USABLE: 0,
    PROCESSING: 0,
    NEEDS_INPUT: 0,
    FAILED: 0,
  };
  for (const material of activeMaterials) {
    const view = materialView(material);
    if (view !== "ALL") counts[view]++;
  }
  const latest = new Map<string, number>();
  for (const material of activeMaterials)
    latest.set(material.seriesId, Math.max(latest.get(material.seriesId) ?? 0, material.version));
  const existingFiles = editing
    ? materials
        .filter((item) => item.seriesId === editing.seriesId)
        .sort((left, right) => right.version - left.version)
        .flatMap((item) =>
          item.artifacts
            .filter((artifact) => artifact.status === "STORED" || artifact.status === "VERIFIED")
            .map((artifact) => ({ artifact, material: item })),
        )
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (other) =>
                (other.artifact.checksum ?? other.artifact.id) ===
                (entry.artifact.checksum ?? entry.artifact.id),
            ) === index,
        )
    : [];
  const contentLabel =
    intakeType === "IMAGE_REFERENCE"
      ? "图片公共说明"
      : editing?.type !== "TEXT" && editing
        ? "资料说明（适用于所有附件）"
        : uploads.length
          ? "补充说明（可选，应用于本次文件）"
          : "资料内容";

  return (
    <SaasShell
      active="materials"
      title={"品牌资料"}
      description={"文字提供事实依据，图片提供真实主体与场景。生成内容时按主题联合选用。"}
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      toolbar={
        <div className="materialIntakeActions">
          <button
            className="ghostButton"
            onClick={() => beginCreate(undefined, "TEXT")}
            type="button"
          >
            {"新增文字资料"}
          </button>
          <button
            className="primaryButton"
            onClick={() => beginCreate(undefined, "IMAGE_REFERENCE")}
            type="button"
          >
            {"上传图片素材"}
          </button>
        </div>
      }
    >
      {error && !editorOpen && !supplementing ? (
        <FeedbackMessage tone="error">{error}</FeedbackMessage>
      ) : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <section className="metricGrid four">
        <Metric label="全部资料" value={counts.ALL} detail="企业专属及可见集团共享资料" />
        <Metric label="可用于生成" value={counts.USABLE} detail="信息明确，已完成整理" />
        <Metric label="AI 处理中" value={counts.PROCESSING} detail="后台处理，状态自动更新" />
        <Metric label="待补充" value={counts.NEEDS_INPUT} detail="补充一句说明后重新检查" />
      </section>
      <section className="workspaceActionBar">
        {
          <fieldset className="materialKindTabs" aria-label="资料类型">
            {(
              [
                ["ALL", "全部"],
                ["TEXT", "文字资料"],
                ["IMAGE_REFERENCE", "图片素材"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={libraryType === value}
                onClick={() => setLibraryType(value)}
              >
                <ActionIcon
                  name={value === "ALL" ? "files" : value === "TEXT" ? "file-text" : "image"}
                />
                {label}
              </button>
            ))}
          </fieldset>
        }
        <WorkspaceTabs
          active={filter}
          ariaLabel="品牌资料工作视图"
          onChange={setFilter}
          tabs={(["ALL", "USABLE", "PROCESSING", "NEEDS_INPUT", "FAILED"] as const).map((key) => ({
            key,
            label: viewLabel(key),
            count: counts[key],
          }))}
        />
      </section>
      <section className="panel materialLibraryPanel">
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">品牌资料库</span>
            <h2>{viewLabel(filter)}</h2>
            <p>
              {filter === "NEEDS_INPUT"
                ? "这些资料暂不用于生成。补充缺少的信息，AI 会继续整理。"
                : filter === "PROCESSING"
                  ? "可以离开本页，AI 会继续处理；完成后自动进入可用资料或待补充。"
                  : "输入活动主题时，系统会自动查找相关人物、项目及图片资料。"}
            </p>
          </div>
          <button
            className="ghostButton"
            onClick={() => {
              setError(null);
              void load();
            }}
            type="button"
          >
            刷新
          </button>
        </div>
        <div className="workspaceFilters materialLibraryFilters">
          <input
            aria-label="搜索品牌资料"
            placeholder={"搜索人物、项目、关键词或文件名"}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            type="search"
          />
          <select
            aria-label="资料范围"
            value={scopeFilter}
            onChange={(event) => setScopeFilter(event.target.value)}
          >
            <option value="ALL">全部范围</option>
            <option value="ENTERPRISE">企业专属</option>
            <option value="SHARED">集团共享</option>
          </select>
          <label className={styles.confirmation}>
            <input
              type="checkbox"
              checked={expiringOnly}
              onChange={(event) => setExpiringOnly(event.target.checked)}
            />
            仅看即将到期
          </label>
        </div>
        <div className="materialLibrary">
          {visibleMaterials.map((material) => {
            const view = materialView(material);
            const medicalMetadata = medicalMaterialOf(material);
            const hasFailure =
              material.ingestionStatus === "FAILED" || material.ingestionStatus === "QUARANTINED";
            const failureGuide = hasFailure ? materialFailureGuide(material) : null;
            const automaticallyRetrying = materialAutomaticallyRetrying(material);
            const userCanResolveFailure = failureGuide?.action === "UPDATE";
            const manageable =
              (material.enterpriseId !== null || canManageShared) &&
              latest.get(material.seriesId) === material.version;
            const needsInput =
              view === "NEEDS_INPUT" ||
              material.artifacts.some((a) => a.usabilityStatus === "NEEDS_INPUT");
            return (
              <article key={material.id}>
                <div
                  className="materialScope"
                  data-scope={material.enterpriseId ? "enterprise" : "shared"}
                >
                  <span>{material.enterpriseId ? "企业\n专属" : "集团\n共享"}</span>
                  <small>{typeLabel(material.type)}</small>
                </div>
                <div>
                  <div className="materialTitleRow">
                    <strong>{material.title}</strong>
                    {medicalMetadata ? (
                      <span className={styles.purposeBadge}>
                        历史分类：{medicalPurposeLabels[medicalMetadata.purpose]}
                      </span>
                    ) : null}
                    {needsInput ? (
                      <button
                        className="ghostButton materialClarifyButton"
                        type="button"
                        disabled={busy}
                        onClick={() => showSupplement(material)}
                      >
                        <ActionIcon name="file-warning" />
                        待补充说明
                      </button>
                    ) : null}
                  </div>
                  <p>
                    {typeof material.analysis?.summary === "string"
                      ? material.analysis.summary
                      : material.content}
                  </p>
                  <div className="tagLine">
                    {material.tags.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                  {material.artifacts.length ? (
                    <small className="materialAttachmentCount">
                      {
                        material.artifacts.filter((a) => ["STORED", "VERIFIED"].includes(a.status))
                          .length
                      }{" "}
                      个附件 · 点击查看时加载
                    </small>
                  ) : null}
                </div>
                <div className="materialMeta">
                  <div className="materialStatusActions">
                    <StatusBadge
                      tone={
                        view === "USABLE"
                          ? "success"
                          : view === "FAILED"
                            ? "danger"
                            : view === "NEEDS_INPUT"
                              ? "warning"
                              : "neutral"
                      }
                    >
                      {statusLabel(material)}
                    </StatusBadge>
                    {material.artifacts.some(
                      (artifact) => artifact.status === "STORED" || artifact.status === "VERIFIED",
                    ) ? (
                      <button
                        className="ghostButton materialPreviewButton"
                        type="button"
                        disabled={previewLoadingId !== null}
                        onClick={() => {
                          const files = material.artifacts.filter(
                            (artifact) =>
                              artifact.status === "STORED" || artifact.status === "VERIFIED",
                          );
                          if (files.length > 1) setAttachmentList(material);
                          else void previewMaterial(material);
                        }}
                      >
                        {previewLoadingId === material.id
                          ? "正在加载…"
                          : material.artifacts.filter(
                                (artifact) =>
                                  artifact.status === "STORED" || artifact.status === "VERIFIED",
                              ).length > 1
                            ? "查看附件"
                            : "查看原文件"}
                      </button>
                    ) : null}
                    {manageable &&
                    material.status === "ACTIVE" &&
                    !(
                      material.parserVersion === BUNDLE_PARSER_VERSION &&
                      !material.ingestionJobs.length
                    ) ? (
                      <button
                        className="ghostButton materialDisableButton"
                        type="button"
                        disabled={busy}
                        onClick={() => setPendingDisable(material)}
                      >
                        停用
                      </button>
                    ) : null}
                  </div>
                  <small>
                    v{material.version} ·{" "}
                    {material.expiresAt
                      ? `${new Date(material.expiresAt).toLocaleDateString("zh-CN")} 到期`
                      : "长期有效"}
                  </small>
                  {manageable && material.type !== "LINK" && !hasFailure ? (
                    <div className="materialActions">
                      {material.type === "IMAGE_REFERENCE" &&
                      material.ingestionStatus === "READY" &&
                      material.artifacts.some(
                        (artifact) =>
                          !artifact.usabilityStatus || artifact.usabilityStatus === "PENDING",
                      ) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void reanalyzePictures(material)}
                        >
                          按图片重新整理
                        </button>
                      ) : null}
                      {material.parserVersion === BUNDLE_PARSER_VERSION &&
                      !material.ingestionJobs.length ? (
                        material.artifacts.some(
                          (artifact) => artifact.status === "PENDING_UPLOAD",
                        ) ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => beginCreate(material)}
                          >
                            继续上传附件
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void finalizePendingRevision(material)}
                          >
                            完成资料更新
                          </button>
                        )
                      ) : null}
                      {material.status === "ACTIVE" &&
                      material.ingestionStatus === "READY" &&
                      !needsInput ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => showSupplement(material)}
                        >
                          <ActionIcon name="file-text" />
                          编辑说明
                        </button>
                      ) : null}
                      {!(
                        material.parserVersion === BUNDLE_PARSER_VERSION &&
                        !material.ingestionJobs.length
                      ) &&
                      !isProcessing(material) &&
                      !material.artifacts.some(
                        (artifact) => artifact.status === "PENDING_UPLOAD",
                      ) ? (
                        <button type="button" disabled={busy} onClick={() => beginCreate(material)}>
                          {material.status === "ACTIVE" ? "更新内容" : "新版本恢复"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {failureGuide && !userCanResolveFailure ? (
                  <div className="materialFailureInlineRow">
                    <p className="materialFailureInline">发生错误，请联系平台协助处理。</p>
                    {manageable && material.type !== "LINK" ? (
                      <div className="materialActions materialFailureInlineActions">
                        <button
                          type="button"
                          disabled={
                            busy ||
                            automaticallyRetrying ||
                            material.ingestionJobs[0]?.status === "PROCESSING" ||
                            !materialCanManuallyRetry(material)
                          }
                          title={
                            automaticallyRetrying
                              ? "系统正在自动重试，请稍后查看结果"
                              : !materialCanManuallyRetry(material)
                                ? "此任务暂不支持直接重试，请联系平台协助处理"
                                : undefined
                          }
                          onClick={() =>
                            void materialAction(material, "ingestion/retry", "用户重新处理资料")
                          }
                        >
                          重新处理
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : failureGuide ? (
                  <div className="materialFailureNotice" data-retrying={automaticallyRetrying}>
                    <strong className="materialFailureTitle">{failureGuide.title}</strong>
                    <p>{failureGuide.reason}</p>
                    {automaticallyRetrying ? (
                      <p className="materialRetryNotice">系统正在自动重试，无需重复提交。</p>
                    ) : null}
                    <ol className="materialFailureSteps" aria-label="建议处理步骤">
                      {failureGuide.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    <small className="materialFailurePreserved">
                      资料记录已保留，处理完成前暂不用于生成。
                    </small>
                    <div className="materialFailureActions">
                      {manageable && !automaticallyRetrying && material.type !== "LINK" ? (
                        <button
                          className="materialFailurePrimaryButton"
                          type="button"
                          disabled={busy}
                          onClick={() => beginCreate(material)}
                        >
                          检查并更新内容
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void copyFailureDiagnostic(material)}
                      >
                        复制排查信息
                      </button>
                    </div>
                    <details className="materialFailureDiagnostic">
                      <summary>排查信息</summary>
                      <pre>{materialFailureDiagnostic(material)}</pre>
                    </details>
                  </div>
                ) : null}
              </article>
            );
          })}
          {!visibleMaterials.length ? (
            <div className="emptyState compact">
              <strong>
                {filter === "NEEDS_INPUT"
                  ? "没有需要补充的资料"
                  : filter === "PROCESSING"
                    ? "当前没有正在处理的资料"
                    : "没有符合条件的资料"}
              </strong>
              <p>可以调整筛选，或新增文字和文件。</p>
            </div>
          ) : null}
        </div>
      </section>
      <WorkspaceDrawer
        open={editorOpen && !preview}
        onClose={() => {
          if (!busy) {
            setEditorOpen(false);
          }
        }}
        title={
          editing
            ? "更新品牌资料"
            : intakeType === "IMAGE_REFERENCE"
              ? "上传图片素材"
              : "新增文字资料"
        }
        description={
          editing
            ? "可以补充说明、追加或移除附件，历史活动引用保持不变。"
            : intakeType === "IMAGE_REFERENCE"
              ? "说明图片中的主体、归属和场景即可，AI 会逐张整理。"
              : "粘贴文字或上传文档，AI 自动提取可引用的事实。"
        }
      >
        <form
          className={`drawerForm materialEditorForm ${styles.editor}`}
          onSubmit={(event) => void saveMaterial(event)}
        >
          {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
          {editing && editing.type !== "TEXT" ? (
            <section className="materialExistingFiles" aria-label="已上传附件">
              <strong>已上传附件 · {existingFiles.length}</strong>
              <p>未移除的当前附件会保留。历史附件仅供查看，明确选择后才恢复使用。</p>
              {existingFiles.map(({ artifact, material }) => (
                <div
                  key={artifact.id}
                  className={`materialAttachmentRow${removedArtifactIds.includes(artifact.id) ? " isRemoved" : ""}`}
                >
                  {material.type === "IMAGE_REFERENCE" ? (
                    <MaterialThumbnail
                      endpoint={`${materialRoot(material)}/materials/${material.id}/artifacts/${artifact.id}/preview`}
                      token={auth.session?.adminToken ?? ""}
                      label={artifact.originalFileName ?? "图片"}
                      onClick={() => void previewMaterial(material, artifact.id)}
                    />
                  ) : null}
                  <span>{artifact.originalFileName ?? "未命名附件"}</span>
                  <small>
                    {material.id === editing.id ? "当前版本" : `历史 v${material.version}`}
                  </small>
                  <button
                    className="ghostButton materialFilePreviewButton"
                    type="button"
                    disabled={busy || previewLoadingId !== null}
                    onClick={() => void previewMaterial(material, artifact.id)}
                    aria-label={`查看${artifact.originalFileName ?? "附件"}`}
                  >
                    查看
                  </button>
                  {material.id === editing.id ? (
                    <button
                      type="button"
                      className="ghostButton materialUploadRemoveButton"
                      disabled={busy || Boolean(revisionId)}
                      onClick={() =>
                        setRemovedArtifactIds((ids) =>
                          ids.includes(artifact.id)
                            ? ids.filter((id) => id !== artifact.id)
                            : [...ids, artifact.id],
                        )
                      }
                    >
                      {removedArtifactIds.includes(artifact.id) ? "撤销移除" : "移除"}
                    </button>
                  ) : null}
                  {material.id === editing.id &&
                  editing.type === "IMAGE_REFERENCE" &&
                  !removedArtifactIds.includes(artifact.id) ? (
                    <div className="materialAttachmentFields">
                      <label className="field">
                        <span>本图说明</span>
                        <textarea
                          rows={2}
                          maxLength={5000}
                          disabled={busy || Boolean(revisionId)}
                          value={
                            attachmentDescriptions[artifact.id]?.description ??
                            artifact.description ??
                            ""
                          }
                          placeholder={"例如：上海门店大厅；人物形象照"}
                          onChange={(event) =>
                            setAttachmentDescriptions((current) => ({
                              ...current,
                              [artifact.id]: {
                                description: event.target.value,
                                usage: current[artifact.id]?.usage ?? artifact.usage ?? "REFERENCE",
                              },
                            }))
                          }
                        />
                      </label>
                      {
                        <label className={`materialUsageToggle ${styles.usageToggle}`}>
                          <input
                            type="checkbox"
                            disabled={busy || Boolean(revisionId)}
                            checked={
                              (attachmentDescriptions[artifact.id]?.usage ?? artifact.usage) ===
                              "LOGO"
                            }
                            onChange={(event) =>
                              setAttachmentDescriptions((current) => ({
                                ...current,
                                [artifact.id]: {
                                  description:
                                    current[artifact.id]?.description ?? artifact.description ?? "",
                                  usage: event.target.checked ? "LOGO" : "REFERENCE",
                                },
                              }))
                            }
                          />
                          用作品牌 Logo（原图使用）
                        </label>
                      }
                      {artifact.usabilityStatus === "NEEDS_INPUT" ? (
                        <small className="dangerText">
                          此图需要补充说明，其他可用图片不受影响。
                        </small>
                      ) : null}
                      {Array.isArray(artifact.analysis?.missingInformation)
                        ? artifact.analysis.missingInformation.map((message) => (
                            <small key={`${artifact.id}-${String(message)}`}>
                              {String(message)}
                            </small>
                          ))
                        : null}
                    </div>
                  ) : null}
                  {material.id !== editing.id && !revisionId ? (
                    <label className="materialRestoreToggle">
                      <input
                        type="checkbox"
                        checked={restoreArtifactIds.includes(artifact.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setRestoreArtifactIds((current) =>
                            event.target.checked
                              ? [...current, artifact.id]
                              : current.filter((id) => id !== artifact.id),
                          )
                        }
                      />
                      加入本次更新
                    </label>
                  ) : null}
                </div>
              ))}
              {editing.artifacts
                .filter((artifact) => artifact.status === "PENDING_UPLOAD")
                .map((artifact) => (
                  <div key={artifact.id}>
                    <span>{artifact.originalFileName ?? "未命名附件"}</span>
                    <small>待重新选择并上传</small>
                  </div>
                ))}
            </section>
          ) : null}
          <label className="field">
            <span>{contentLabel}</span>
            <textarea
              aria-label={contentLabel}
              ref={textInput}
              value={text}
              rows={intakeType === "IMAGE_REFERENCE" ? 3 : 8}
              maxLength={uploads.length || (editing && editing.type !== "TEXT") ? 5000 : 50000}
              disabled={
                busy || revisionId === editing?.id || uploads.some((item) => Boolean(item.intent))
              }
              placeholder={
                intakeType === "IMAGE_REFERENCE"
                  ? "例如：以下是本公司上海门店的建筑、门头和大厅实景。不同图片可在下方分别补充说明。"
                  : "粘贴人物简介、机构介绍、产品说明等内容，也可以上传文档。"
              }
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                if (event.clipboardData.files.length) {
                  event.preventDefault();
                  addFiles(Array.from(event.clipboardData.files));
                }
              }}
            />
          </label>
          {editing?.type !== "TEXT" ? (
            <label
              className="materialDropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                addFiles(Array.from(event.dataTransfer.files));
              }}
            >
              <strong>选择文件，或拖到这里</strong>
              <span>
                {editing
                  ? `仅添加${editing.type === "IMAGE_REFERENCE" ? "图片" : "文档"}；保留原附件，新旧合计最多 20 个，每个最大 25 MiB`
                  : intakeType === "IMAGE_REFERENCE"
                    ? "单次最多 20 张图片，每张最大 25 MiB"
                    : "单次最多 20 份文档，每份最大 25 MiB"}
              </span>
              <input
                aria-label="选择文件"
                ref={fileInput}
                type="file"
                accept={
                  intakeType === "IMAGE_REFERENCE" ? ".jpg,.jpeg,.png,.webp" : ".pdf,.docx,.txt,.md"
                }
                multiple
                disabled={busy}
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <small>
                {intakeType === "IMAGE_REFERENCE"
                  ? "支持 JPEG、PNG、WebP；Logo 推荐透明 PNG"
                  : "支持 PDF、DOCX、TXT、Markdown"}
              </small>
            </label>
          ) : null}
          {uploads.length ? (
            <div className="materialUploadList" aria-live="polite">
              {uploads.map((item) => (
                <div key={item.id}>
                  <strong>{item.file.name}</strong>
                  {fileType(item.file) === "IMAGE_REFERENCE" ? (
                    <div className="materialAttachmentFields">
                      <div className="materialUploadDescriptionRow">
                        <label className="field">
                          <textarea
                            aria-label={`${item.file.name} 的说明`}
                            ref={(element) => {
                              descriptionInputs.current[item.id] = element;
                            }}
                            rows={2}
                            maxLength={5000}
                            value={item.description ?? ""}
                            disabled={busy || Boolean(item.intent)}
                            placeholder={"可补充这张图片的主体和用途；留空使用公共说明"}
                            onChange={(event) =>
                              setUploads((current) =>
                                current.map((entry) =>
                                  entry.id === item.id
                                    ? { ...entry, description: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                        </label>
                        <MaterialUploadPreview file={item.file} />
                      </div>
                      {
                        <label className={`materialUsageToggle ${styles.usageToggle}`}>
                          <input
                            type="checkbox"
                            checked={item.usage === "LOGO"}
                            disabled={busy || Boolean(item.intent)}
                            onChange={(event) =>
                              setUploads((current) =>
                                current.map((entry) =>
                                  entry.id === item.id
                                    ? {
                                        ...entry,
                                        usage: event.target.checked ? "LOGO" : "REFERENCE",
                                      }
                                    : entry,
                                ),
                              )
                            }
                          />
                          用作品牌 Logo（原图使用）
                        </label>
                      }
                    </div>
                  ) : null}
                  <span>
                    {
                      {
                        WAITING: "待上传",
                        UPLOADING: "正在上传",
                        DONE:
                          editing && editing.type !== "TEXT"
                            ? "已上传，待统一处理"
                            : "已提交 AI 处理",
                        FAILED: "上传未完成",
                      }[item.status]
                    }
                  </span>
                  {item.error ? <p className="dangerText">{item.error}</p> : null}
                  {!busy && item.status !== "DONE" ? (
                    <button
                      className="ghostButton materialUploadRemoveButton"
                      type="button"
                      onClick={() =>
                        setUploads((current) => current.filter((entry) => entry.id !== item.id))
                      }
                    >
                      移除
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {canManageShared && !editing ? (
            <label className="field">
              <span>资料归属</span>
              <select
                disabled={busy || uploads.some((item) => Boolean(item.intent))}
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="ENTERPRISE">企业专属</option>
                <option value="SHARED">集团共享</option>
              </select>
            </label>
          ) : null}
          <div className={styles.confirmations}>
            <label className={styles.confirmation}>
              <input
                ref={authorizationInput}
                type="checkbox"
                checked={authorizationConfirmed}
                disabled={busy}
                onChange={(event) => setAuthorizationConfirmed(event.target.checked)}
              />
              <span>我确认拥有资料的使用权，并获准用于本企业内容</span>
            </label>
          </div>
          <button
            className="primaryButton"
            disabled={
              busy ||
              !authorizationConfirmed ||
              (editing && editing.type !== "TEXT"
                ? !revisionId &&
                  !uploads.length &&
                  !restoreArtifactIds.length &&
                  !removedArtifactIds.length &&
                  !Object.keys(attachmentDescriptions).length &&
                  text.trim() === (editing.supplement ?? "")
                : !text.trim() && !uploads.length)
            }
            type="submit"
          >
            {busy
              ? "正在提交…"
              : uploads.some((item) => item.status === "FAILED")
                ? "重试未完成的文件"
                : "提交资料"}
          </button>
        </form>
      </WorkspaceDrawer>
      <WorkspaceDrawer
        open={Boolean(supplementing)}
        onClose={() => {
          if (!busy) setSupplementing(null);
        }}
        title={
          supplementing && materialView(supplementing) === "NEEDS_INPUT"
            ? "补充资料说明"
            : "编辑资料说明"
        }
        description="已有说明可继续修改；可用资料会生成新版本，历史活动引用不变。"
      >
        <form className="drawerForm" onSubmit={(event) => void saveSupplement(event)}>
          {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
          <strong>{supplementing?.title}</strong>
          {supplementing &&
          materialView(supplementing) === "NEEDS_INPUT" &&
          (supplementing.enterpriseId !== null || canManageShared) &&
          latest.get(supplementing.seriesId) === supplementing.version ? (
            <button
              className="ghostButton"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (
                  await materialAction(supplementing, "ingestion/retry", "按当前规则重新检查原资料")
                ) {
                  setSupplementing(null);
                  setFilter("PROCESSING");
                }
              }}
            >
              <ActionIcon name="refresh" />
              重新检查原资料
            </button>
          ) : null}
          {supplementing
            ? analysisStrings(supplementing, "missingInformation").map((question) => (
                <p key={question}>{question}</p>
              ))
            : null}
          {supplementing?.artifacts
            .filter((a) => a.usabilityStatus === "NEEDS_INPUT")
            .map((a) => (
              <div key={a.id} className="materialMissing">
                <strong>{a.originalFileName}</strong>
                {Array.isArray(a.analysis?.missingInformation) ? (
                  a.analysis.missingInformation.map((q) => <p key={String(q)}>{String(q)}</p>)
                ) : (
                  <p>请明确此图的主体或用途。</p>
                )}
              </div>
            ))}
          {supplementing?.enterpriseId === null && !canManageShared ? (
            <p role="status">此资料为集团共享，请联系集团管理员修改说明。</p>
          ) : null}
          <label className="field">
            <span>补充说明</span>
            <textarea
              required
              minLength={2}
              maxLength={5000}
              rows={5}
              value={supplement}
              disabled={
                busy ||
                Boolean(
                  supplementing &&
                    ((supplementing.enterpriseId === null && !canManageShared) ||
                      latest.get(supplementing.seriesId) !== supplementing.version),
                )
              }
              placeholder={"可补充资料中已有依据的主体、用途和关键词。"}
              onChange={(event) => setSupplement(event.target.value)}
            />
          </label>
          <button
            className="primaryButton"
            type="submit"
            disabled={
              busy ||
              supplement.trim().length < 2 ||
              Boolean(
                supplementing &&
                  ((supplementing.enterpriseId === null && !canManageShared) ||
                    latest.get(supplementing.seriesId) !== supplementing.version),
              )
            }
          >
            {busy ? "正在保存…" : "保存并重新分析"}
          </button>
        </form>
      </WorkspaceDrawer>
      <WorkspaceDrawer
        open={Boolean(attachmentList) && !preview}
        onClose={() => setAttachmentList(null)}
        title="资料附件"
      >
        {attachmentList ? (
          <section className="materialExistingFiles" aria-label="资料附件列表">
            <strong>
              {attachmentList.title} ·{" "}
              {
                attachmentList.artifacts.filter(
                  (artifact) => artifact.status === "STORED" || artifact.status === "VERIFIED",
                ).length
              }{" "}
              个附件
            </strong>
            {attachmentList.artifacts
              .filter((artifact) => artifact.status === "STORED" || artifact.status === "VERIFIED")
              .map((artifact) => (
                <div key={artifact.id}>
                  <span>{artifact.originalFileName ?? "未命名附件"}</span>
                  <button
                    className="ghostButton materialFilePreviewButton"
                    type="button"
                    disabled={previewLoadingId !== null}
                    onClick={() => void previewMaterial(attachmentList, artifact.id)}
                    aria-label={`查看${artifact.originalFileName ?? "附件"}`}
                  >
                    查看
                  </button>
                </div>
              ))}
          </section>
        ) : null}
      </WorkspaceDrawer>
      <WorkspaceDrawer open={Boolean(preview)} onClose={() => setPreview(null)} title="原始资料">
        {preview ? (
          <div className="materialPreview">
            <strong>{preview.title}</strong>
            {preview.image ? (
              preview.optimizedDataUrl ? (
                <Image
                  src={preview.optimizedDataUrl}
                  alt={preview.title}
                  width={960}
                  height={960}
                  unoptimized
                />
              ) : (
                <p role="status">暂时无法生成压缩预览，请稍后重试。</p>
              )
            ) : null}
            {!preview.image ? (
              <pre className="materialSourceText">{preview.text || "暂无可预览的文字内容。"}</pre>
            ) : null}
          </div>
        ) : null}
      </WorkspaceDrawer>
      <ActionConfirmDialog
        busy={busy}
        onCancel={() => setPendingDisable(null)}
        onConfirm={(reason) => {
          if (pendingDisable) void materialAction(pendingDisable, "disable", reason);
        }}
        state={
          pendingDisable
            ? {
                confirmLabel: "确认停用资料",
                defaultReason: "资料内容已不再适用于后续宣传",
                impacts: ["该版本不会再被后续活动检索和引用。", "已经创建的活动保留原始资料记录。"],
                reasonLabel: "停用原因",
                summary: `即将停用“${pendingDisable.title}”。`,
                title: "确认停用这份品牌资料？",
                tone: "warning",
              }
            : null
        }
      />
    </SaasShell>
  );
}

function MaterialUploadPreview({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="materialUploadPreview">
      {src && !failed ? (
        <Image
          src={src}
          alt={`${file.name} 预览`}
          fill
          sizes="(max-width: 640px) 88px, 120px"
          unoptimized
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{failed ? "无法预览" : "加载预览…"}</span>
      )}
    </div>
  );
}

function isProcessing(material: Material): boolean {
  if (
    material.status === "DISABLED" ||
    material.artifacts.some((artifact) => artifact.status === "PENDING_UPLOAD")
  )
    return false;
  return (
    material.ingestionStatus === "PENDING" ||
    material.ingestionStatus === "PROCESSING" ||
    materialAutomaticallyRetrying(material)
  );
}
function materialView(material: Material): MaterialView {
  if (material.status === "DISABLED" || medicalMaterialOf(material)?.purpose === "ARCHIVE")
    return "ALL";
  if (isProcessing(material)) return "PROCESSING";
  if (material.ingestionStatus === "FAILED" || material.ingestionStatus === "QUARANTINED")
    return "FAILED";
  if (material.usabilityStatus === "NEEDS_INPUT") return "NEEDS_INPUT";

  const now = Date.now();
  if (
    material.ingestionStatus === "READY" &&
    material.usabilityStatus !== "PENDING" &&
    material.authorizationStatus === "AUTHORIZED" &&
    (!material.validFrom || new Date(material.validFrom).getTime() <= now) &&
    (!material.expiresAt || new Date(material.expiresAt).getTime() > now)
  )
    return "USABLE";
  return "ALL";
}
function viewLabel(view: MaterialView): string {
  return {
    ALL: "全部资料",
    USABLE: "可用资料",
    PROCESSING: "AI 处理中",
    NEEDS_INPUT: "待补充",
    FAILED: "处理失败",
  }[view];
}
function statusLabel(material: Material): string {
  if (material.status === "DISABLED") return "已停用 / 历史版本";
  if (medicalMaterialOf(material)?.purpose === "ARCHIVE") return "已归档";
  if (materialView(material) === "NEEDS_INPUT") return "待补充 · 暂不用于生成";
  if (
    material.ingestionStatus === "PENDING" &&
    material.artifacts.some((item) => item.status === "PENDING_UPLOAD")
  )
    return "等待上传完成";
  if (material.ingestionStatus === "PENDING") return "排队中";
  if (material.ingestionStatus === "FAILED" && isProcessing(material)) return "正在自动重试";

  return materialView(material) === "ALL" ? "当前不可调用" : viewLabel(materialView(material));
}
function analysisStrings(material: Material, key: string): string[] {
  const value = material.analysis?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function typeLabel(type: Material["type"]): string {
  return { TEXT: "文本", DOCUMENT: "文档", IMAGE_REFERENCE: "图片", LINK: "网页" }[type];
}
function mimeType(file: File): string {
  return (
    (
      {
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        txt: "text/plain",
        md: "text/markdown",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
      } as Record<string, string>
    )[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? file.type
  );
}
function supportedFile(file: File): boolean {
  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "image/jpeg",
    "image/png",
    "image/webp",
  ].includes(mimeType(file));
}
function fileType(file: File): "DOCUMENT" | "IMAGE_REFERENCE" {
  return mimeType(file).startsWith("image/") ? "IMAGE_REFERENCE" : "DOCUMENT";
}
async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function Metric({
  label,
  detail,
  value,
}: Readonly<{ label: string; detail: string; value: number }>) {
  return (
    <article className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
