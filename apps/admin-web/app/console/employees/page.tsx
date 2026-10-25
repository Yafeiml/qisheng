"use client";

import type { components } from "@xhs-agentic/contracts";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ActionConfirmDialog,
  type ConfirmDialogState,
} from "../../components/action-confirm-dialog";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import publisherStyles from "../../components/publisher-context-form.module.css";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { WorkspaceTabs } from "../../components/workspace-tabs";
import {
  type MedicalPublisherContext as PublisherContext,
  parseMedicalPublisherContext,
} from "../../lib/medical-selection";
import {
  apiRequest,
  consoleNavigationPermissions,
  cursorPagePath,
  selectedAdminRoleName,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type Membership = Omit<components["schemas"]["EnterpriseMembershipDto"], "publisherContext"> & {
  publisherContext?: PublisherContext | null;
};
function decodedMembership(row: components["schemas"]["EnterpriseMembershipDto"]): Membership {
  return { ...row, publisherContext: parseMedicalPublisherContext(row.publisherContext) };
}
type SmsNotificationStatus = NonNullable<Membership["smsNotificationStatus"]>;
type MembershipPage = components["schemas"]["EnterpriseMembershipPageDto"];
type Department = components["schemas"]["DepartmentResponseDto"];
type CsvMember = Readonly<{
  departmentCode?: string;
  employeeNo?: string;
  name: string;
  phone: string;
  rowNumber: number;
}>;
type ImportPreview = components["schemas"]["MembershipImportPreviewDto"];
type ImportBatch = components["schemas"]["MembershipImportBatchResponseDto"];
type DepartmentImpact = components["schemas"]["DepartmentImpactResponseDto"];
type PersonnelPolicy = components["schemas"]["EnterprisePersonnelPolicyResponseDto"];
type DrawerMode =
  | "BULK"
  | "BULK_PARTICIPATION"
  | "CSV"
  | "DEPARTMENT"
  | "EDIT"
  | "IMPORT_HISTORY"
  | "MEMBER"
  | "PHONE"
  | "PARTICIPATION"
  | "PUBLISHER"
  | "WEB_ACCOUNT";
type EmployeeView = "ALL" | "LEFT" | "NO_SEAT" | "PENDING_BIND";
type SeatAction = "disable" | "enable" | "leave";
type BulkAction = "DISABLE" | "ENABLE" | "LEAVE" | "TRANSFER";
type ParticipationStatus = "EXEMPT" | "PARTICIPATING" | "PAUSED" | "PENDING_REVIEW";
type PendingSeatAction = Readonly<{ action: SeatAction; membership: Membership }>;
type PendingDepartmentDisable = Readonly<{
  department: Department;
  impact: DepartmentImpact;
  transferDepartmentId?: string;
}>;

export default function EmployeesPage() {
  const auth = useMvpSession();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [importBatches, setImportBatches] = useState<ImportBatch[]>([]);
  const [personnelPolicy, setPersonnelPolicy] = useState<PersonnelPolicy | null>(null);
  const [memberForm, setMemberForm] = useState({
    departmentCode: "",
    employeeNo: "",
    name: "",
    phone: "",
  });
  const [departmentForm, setDepartmentForm] = useState({ code: "", name: "" });
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);
  const [editingMembership, setEditingMembership] = useState<Membership | null>(null);
  const [participationMembership, setParticipationMembership] = useState<Membership | null>(null);
  const [publisherMembership, setPublisherMembership] = useState<Membership | null>(null);
  const [publisherForm, setPublisherForm] = useState({
    category: "UNKNOWN" as PublisherContext["category"],
    authorId: "",
    role: "",
    evidence: "",
    validUntil: "",
    allowBrandAttribution: false,
    allowPlatformConsultation: false,
    reason: "企业核实发布条件",
  });
  const [membershipEditForm, setMembershipEditForm] = useState({
    departmentId: "",
    employeeNo: "",
    name: "",
    reason: "人资核对后更新员工档案",
  });
  const [phoneCorrectionForm, setPhoneCorrectionForm] = useState({ phone: "", reason: "" });
  const [selectedMembershipIds, setSelectedMembershipIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkForm, setBulkForm] = useState({ departmentId: "", reason: "" });
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvMembers, setCsvMembers] = useState<CsvMember[]>([]);
  const [csvPreview, setCsvPreview] = useState<ImportPreview | null>(null);
  const [csvInputKey, setCsvInputKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [webAccountMember, setWebAccountMember] = useState<Membership | null>(null);
  const [webAccountForm, setWebAccountForm] = useState({
    username: "",
    password: "",
    confirmation: "",
  });
  const [membershipNextCursor, setMembershipNextCursor] = useState<string | null>(null);
  const [membershipTotalCount, setMembershipTotalCount] = useState(0);
  const [smsStatusFilter, setSmsStatusFilter] = useState<SmsNotificationStatus | "">("");
  const loadGeneration = useRef(0);
  const [activeView, setActiveView] = useState<EmployeeView>("ALL");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [participationFilter, setParticipationFilter] = useState<ParticipationStatus | "">("");
  const [drawerMode, setDrawerMode] = useState<DrawerMode | null>(null);
  const [pendingSeatAction, setPendingSeatAction] = useState<PendingSeatAction | null>(null);
  const [pendingDepartmentDisable, setPendingDepartmentDisable] =
    useState<PendingDepartmentDisable | null>(null);
  const [departmentDisableConfirmOpen, setDepartmentDisableConfirmOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [participationForm, setParticipationForm] = useState({
    effectiveUntil: "",
    lockedByTenant: false,
    reason: "根据岗位安排调整后续活动参与状态",
    status: "PARTICIPATING" as ParticipationStatus,
  });

  const navigationPermissions = auth.session ? consoleNavigationPermissions(auth.session) : [];
  const hasParticipationPermission = navigationPermissions.includes(
    "enterprise.membership.participation.manage",
  );
  const canManagePublisher = navigationPermissions.includes("enterprise.membership.manage");
  const canTenantLockParticipation = navigationPermissions.includes(
    "tenant.membership.policy.manage",
  );
  const canManageParticipation =
    hasParticipationPermission &&
    (canTenantLockParticipation ||
      personnelPolicy?.allowEnterpriseParticipationManagement !== false);

  const load = useCallback(
    async (cursor: string | null = null) => {
      if (!auth.session) return;
      const generation = ++loadGeneration.current;
      setError(null);
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const membershipPath = smsStatusFilter
        ? `${base}/memberships?smsNotificationStatus=${smsStatusFilter}`
        : `${base}/memberships`;
      try {
        const [memberRows, departmentRows, importBatchRows, policyRow] = await Promise.all([
          apiRequest<MembershipPage>(cursorPagePath(membershipPath, cursor, 100), {
            token: auth.session.adminToken,
          }),
          apiRequest<Department[]>(`${base}/departments`, { token: auth.session.adminToken }),
          apiRequest<ImportBatch[]>(`${base}/memberships/import-batches`, {
            token: auth.session.adminToken,
          }),
          apiRequest<PersonnelPolicy>(`${base}/personnel-policy`, {
            token: auth.session.adminToken,
          }),
        ]);
        if (generation !== loadGeneration.current) return;
        setMemberships((current) =>
          cursor
            ? [...current, ...memberRows.items.map(decodedMembership)]
            : memberRows.items.map(decodedMembership),
        );
        setMembershipNextCursor(memberRows.pageInfo.nextCursor);
        setMembershipTotalCount(memberRows.pageInfo.totalCount ?? memberRows.items.length);
        setDepartments(departmentRows);
        setImportBatches(importBatchRows);
        setPersonnelPolicy(policyRow);
      } catch (reason) {
        if (generation !== loadGeneration.current) return;
        setError(messageOf(reason));
      }
    },
    [auth.session, smsStatusFilter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function createWebAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !webAccountMember) return;
    if (webAccountForm.password !== webAccountForm.confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusyId(webAccountMember.id);
    setError(null);
    try {
      await apiRequest(
        `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/memberships/${webAccountMember.id}/web-account`,
        {
          token: auth.session.adminToken,
          method: "POST",
          body: { username: webAccountForm.username, password: webAccountForm.password },
        },
      );
      setNotice(
        `已为 ${webAccountMember.name} 创建网页账号 ${webAccountForm.username}。请安全告知本人初始密码，通过 /employee 登录领取任务。`,
      );
      setWebAccountForm({ username: "", password: "", confirmation: "" });
      setDrawerMode(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function importMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    setBusyId("import");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const result = await apiRequest<components["schemas"]["MembershipImportResponseDto"]>(
        `${base}/memberships/import`,
        {
          body: {
            members: [
              {
                ...memberForm,
                departmentCode: memberForm.departmentCode || undefined,
                employeeNo: memberForm.employeeNo || undefined,
              },
            ],
          },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setNotice(
        result.createdCount > 0
          ? "员工已录入并启用任务资格，可发送网页邀请链接"
          : "员工资料已更新，原有任务资格保持不变",
      );
      setMemberForm({ departmentCode: "", employeeNo: "", name: "", phone: "" });
      setDrawerMode(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function previewCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !auth.session) return;
    setBusyId("csv-preview");
    setError(null);
    setNotice(null);
    setCsvFileName(file.name);
    setCsvPreview(null);
    try {
      const parsed = await parseMembershipCsv(file);
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const preview = await apiRequest<ImportPreview>(`${base}/memberships/import/preview`, {
        body: { headers: parsed.headers, members: parsed.members, sourceFileName: file.name },
        method: "POST",
        token: auth.session.adminToken,
      });
      setCsvHeaders(parsed.headers);
      setCsvMembers(parsed.members);
      setCsvPreview(preview);
    } catch (reason) {
      setCsvHeaders([]);
      setCsvMembers([]);
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmCsvImport() {
    if (!auth.session || !csvPreview?.canImport || csvMembers.length === 0) return;
    setBusyId("csv-import");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const result = await apiRequest<components["schemas"]["MembershipImportResponseDto"]>(
        `${base}/memberships/import`,
        {
          body: {
            headers: csvHeaders,
            members: csvMembers,
            previewBatchId: csvPreview.batchId,
            sourceFileName: csvFileName ?? undefined,
          },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setNotice(
        `CSV 已完整导入：新增并启用 ${result.createdCount} 人，更新 ${result.updatedCount} 人；已有员工保留原任务资格`,
      );
      setCsvFileName(null);
      setCsvHeaders([]);
      setCsvMembers([]);
      setCsvPreview(null);
      setCsvInputKey((value) => value + 1);
      setDrawerMode(null);
      await load();
    } catch (reason) {
      setError(`${messageOf(reason)}。数据可能已变化，请重新选择文件预检。`);
    } finally {
      setBusyId(null);
    }
  }

  async function createDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    setBusyId("department");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      await apiRequest(
        editingDepartment ? `${base}/departments/${editingDepartment.id}` : `${base}/departments`,
        {
          body: editingDepartment ? departmentForm : { name: departmentForm.name },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setDepartmentForm({ code: "", name: "" });
      setNotice(editingDepartment ? "部门信息已更新" : "部门已创建");
      setEditingDepartment(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  function openMembershipEditor(membership: Membership) {
    setEditingMembership(membership);
    setMembershipEditForm({
      departmentId: membership.departmentId ?? "",
      employeeNo: membership.employeeNo ?? "",
      name: membership.name,
      reason: "人资核对后更新员工档案",
    });
    setDrawerMode("EDIT");
  }

  function openPublisherEditor(membership: Membership) {
    const context = membership.publisherContext;
    setPublisherMembership(membership);
    setPublisherForm({
      category: context?.category ?? "UNKNOWN",
      authorId: context?.authorId ?? "",
      role: context?.role ?? "",
      evidence: context?.evidence ?? "",
      validUntil: toDateTimeLocal(context?.validUntil),
      allowBrandAttribution: context?.allowBrandAttribution ?? false,
      allowPlatformConsultation: context?.allowPlatformConsultation ?? false,
      reason: "企业核实发布条件",
    });
    setDrawerMode("PUBLISHER");
  }

  async function savePublisherContext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !publisherMembership || busyId === "publisher") return;
    setBusyId("publisher");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      await apiRequest(`${base}/memberships/${publisherMembership.id}/publisher-context`, {
        token: auth.session.adminToken,
        method: "POST",
        body: {
          ...publisherForm,
          validUntil: publisherForm.validUntil
            ? new Date(publisherForm.validUntil).toISOString()
            : undefined,
        },
      });
      setNotice(`${publisherMembership.name} 的发布安排已由企业更新`);
      setDrawerMode(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function updateMembership(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !editingMembership) return;
    setBusyId("edit-membership");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      await apiRequest(`${base}/memberships/${editingMembership.id}/profile`, {
        body: {
          departmentId: membershipEditForm.departmentId || null,
          employeeNo: membershipEditForm.employeeNo,
          name: membershipEditForm.name,
          reason: membershipEditForm.reason,
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setNotice(`${membershipEditForm.name} 的员工档案已更新`);
      setDrawerMode(null);
      setEditingMembership(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  function openPhoneCorrection() {
    if (!editingMembership) return;
    setPhoneCorrectionForm({ phone: editingMembership.phone, reason: "" });
    setError(null);
    setDrawerMode("PHONE");
  }

  async function correctMembershipPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !editingMembership) return;
    setBusyId("correct-phone");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      await apiRequest(`${base}/memberships/${editingMembership.id}/phone`, {
        body: {
          phone: phoneCorrectionForm.phone.trim(),
          reason: phoneCorrectionForm.reason.trim(),
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setNotice(`${editingMembership.name} 的手机号已更正，短信通知状态已重置为待验证`);
      setDrawerMode(null);
      setEditingMembership(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  function openParticipationEditor(membership: Membership) {
    const status = membership.participation?.status ?? "PARTICIPATING";
    setParticipationMembership(membership);
    setParticipationForm({
      effectiveUntil: toDateTimeLocal(membership.participation?.effectiveUntil),
      lockedByTenant: membership.participation?.lockedByTenant ?? false,
      reason: participationDefaultReason(status),
      status,
    });
    setDrawerMode("PARTICIPATION");
  }

  function openBulkParticipation() {
    setParticipationMembership(null);
    setParticipationForm({
      effectiveUntil: "",
      lockedByTenant: false,
      reason: "批量调整所选员工的后续活动参与状态",
      status: "PARTICIPATING",
    });
    setDrawerMode("BULK_PARTICIPATION");
  }

  async function saveParticipation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session) return;
    const membershipIds = participationMembership
      ? [participationMembership.id]
      : selectedMembershipIds;
    if (membershipIds.length === 0) return;
    setBusyId("participation");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const body = {
        effectiveUntil:
          participationForm.status === "PAUSED" && participationForm.effectiveUntil
            ? new Date(participationForm.effectiveUntil).toISOString()
            : undefined,
        lockedByTenant: canTenantLockParticipation ? participationForm.lockedByTenant : undefined,
        reason: participationForm.reason,
        status: participationForm.status,
      };
      if (participationMembership) {
        await apiRequest(`${base}/memberships/${participationMembership.id}/participation`, {
          body,
          method: "POST",
          token: auth.session.adminToken,
        });
        setNotice(
          `${participationMembership.name} 已设为${participationStatusLabel(participationForm.status)}`,
        );
      } else {
        const result = await apiRequest<
          components["schemas"]["BulkMembershipParticipationResponseDto"]
        >(`${base}/memberships/participation/bulk`, {
          body: { ...body, membershipIds },
          method: "POST",
          token: auth.session.adminToken,
        });
        setNotice(`已批量更新 ${result.updatedCount} 名员工的任务参与状态`);
        setSelectedMembershipIds([]);
      }
      setDrawerMode(null);
      setParticipationMembership(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  function openBulkAction(action: BulkAction) {
    setBulkAction(action);
    setBulkForm({
      departmentId: "",
      reason: bulkActionDefaultReason(action),
    });
    setDrawerMode("BULK");
  }

  async function executeBulkAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !bulkAction || selectedMembershipIds.length === 0) return;
    setBusyId("bulk-membership");
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const result = await apiRequest<components["schemas"]["BulkMembershipActionResponseDto"]>(
        `${base}/memberships/bulk`,
        {
          body: {
            action: bulkAction,
            departmentId: bulkAction === "TRANSFER" ? bulkForm.departmentId : undefined,
            membershipIds: selectedMembershipIds,
            reason: bulkForm.reason,
          },
          method: "POST",
          token: auth.session.adminToken,
        },
      );
      setNotice(`${bulkActionLabel(bulkAction)}已完成，共处理 ${result.updatedCount} 名员工`);
      setSelectedMembershipIds([]);
      setBulkAction(null);
      setDrawerMode(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  function editDepartment(department: Department) {
    setEditingDepartment(department);
    setDepartmentForm({ code: department.code, name: department.name });
  }

  async function inspectDepartmentDisable(department: Department) {
    if (!auth.session) return;
    setBusyId(`department-impact-${department.id}`);
    setError(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      const impact = await apiRequest<DepartmentImpact>(
        `${base}/departments/${department.id}/impact`,
        { token: auth.session.adminToken },
      );
      setPendingDepartmentDisable({ department, impact });
      setDepartmentDisableConfirmOpen(false);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function disableDepartment(reason: string) {
    if (!auth.session || !pendingDepartmentDisable) return;
    setBusyId(`department-disable-${pendingDepartmentDisable.department.id}`);
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      await apiRequest(`${base}/departments/${pendingDepartmentDisable.department.id}/disable`, {
        body: {
          reason,
          transferDepartmentId: pendingDepartmentDisable.transferDepartmentId,
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setNotice(`${pendingDepartmentDisable.department.name} 已停用`);
      setPendingDepartmentDisable(null);
      setDepartmentDisableConfirmOpen(false);
      setEditingDepartment(null);
      setDepartmentForm({ code: "", name: "" });
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function changeSeat(membership: Membership, action: SeatAction, reason?: string) {
    if (!auth.session) return;
    setBusyId(membership.id);
    setError(null);
    setNotice(null);
    try {
      const base = `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}`;
      await apiRequest(`${base}/memberships/${membership.id}/${action}`, {
        body: {
          reason:
            reason ??
            (action === "enable"
              ? "后台启用员工"
              : action === "disable"
                ? "后台停用员工"
                : "后台标记员工离职"),
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setNotice(
        action === "enable" ? "员工已启用" : action === "disable" ? "员工已停用" : "员工已标记离职",
      );
      setPendingSeatAction(null);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusyId(null);
    }
  }

  function requestSeatChange(membership: Membership, action: SeatAction) {
    if (action === "enable") {
      void changeSeat(membership, action);
      return;
    }
    setPendingSeatAction({ action, membership });
  }

  if (auth.session === undefined) return <EmployeesLoading />;
  if (auth.session === null)
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;

  const enabled = memberships.filter(({ seatStatus }) => seatStatus === "ENABLED").length;
  const activeDepartments = departments.filter(({ status }) => status === "ACTIVE");
  const participating = memberships.filter(
    (membership) => effectiveParticipationStatus(membership) === "PARTICIPATING",
  ).length;
  const pendingParticipation = memberships.filter(
    (membership) => effectiveParticipationStatus(membership) === "PENDING_REVIEW",
  ).length;
  const pendingBind = memberships.filter(({ status }) => status === "PENDING_BIND").length;
  const noSeat = memberships.filter(
    ({ seatStatus, status }) => seatStatus !== "ENABLED" && status !== "LEFT",
  ).length;
  const left = memberships.filter(({ status }) => status === "LEFT").length;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredMemberships = memberships.filter((membership) => {
    const departmentName =
      departments.find(({ id }) => id === membership.departmentId)?.name ?? "未分组";
    const matchesView =
      activeView === "ALL" ||
      (activeView === "PENDING_BIND" && membership.status === "PENDING_BIND") ||
      (activeView === "NO_SEAT" &&
        membership.seatStatus !== "ENABLED" &&
        membership.status !== "LEFT") ||
      (activeView === "LEFT" && membership.status === "LEFT");
    const matchesDepartment =
      !departmentFilter ||
      (departmentFilter === "UNGROUPED"
        ? !membership.departmentId
        : membership.departmentId === departmentFilter);
    const matchesParticipation =
      !participationFilter || effectiveParticipationStatus(membership) === participationFilter;
    const matchesSearch =
      !normalizedSearch ||
      [membership.name, membership.phone, membership.employeeNo ?? "", departmentName].some(
        (value) => value.toLowerCase().includes(normalizedSearch),
      );
    return matchesView && matchesDepartment && matchesParticipation && matchesSearch;
  });
  const selectableMemberships = filteredMemberships.filter(({ status }) => status !== "LEFT");
  const selectedMemberships = memberships.filter(({ id }) => selectedMembershipIds.includes(id));
  const allVisibleSelected =
    selectableMemberships.length > 0 &&
    selectableMemberships.every(({ id }) => selectedMembershipIds.includes(id));
  const someVisibleSelected =
    !allVisibleSelected &&
    selectableMemberships.some(({ id }) => selectedMembershipIds.includes(id));
  const seatDialogState: ConfirmDialogState | null = pendingSeatAction
    ? pendingSeatAction.action === "leave"
      ? {
          confirmLabel: "确认员工离职",
          defaultReason: "员工已办理离职",
          impacts: [
            "该员工将不再进入后续活动受众，也不会再生成新的员工图文。",
            "员工原有活动记录和提交数据会继续保留，便于企业追溯。",
            "如为误操作，需要重新恢复员工关系后才能继续参与活动。",
          ],
          reasonLabel: "离职说明",
          summary: `即将把 ${pendingSeatAction.membership.name} 标记为离职。`,
          title: "确认员工已经离职？",
          tone: "danger",
        }
      : {
          confirmLabel: "确认停用员工",
          defaultReason: "员工暂不参与后续活动",
          impacts: [
            "该员工不会进入停用后的新活动受众，也不会产生新的内容消耗。",
            "已经生成的活动内容和历史执行数据不会被删除。",
            "再次启用后，该员工可重新进入符合条件的新活动受众。",
          ],
          reasonLabel: "停用原因",
          summary: `即将停用 ${pendingSeatAction.membership.name} 在当前企业的员工状态。`,
          title: "确认停用这个员工？",
          tone: "warning",
        }
    : null;
  const departmentDialogState: ConfirmDialogState | null =
    pendingDepartmentDisable && departmentDisableConfirmOpen
      ? {
          confirmLabel: "确认停用部门",
          defaultReason: "组织调整，部门停止使用",
          impacts: [
            pendingDepartmentDisable.impact.memberCount > 0
              ? `${pendingDepartmentDisable.impact.memberCount} 名在职员工将整体转入所选接收部门。`
              : "该部门当前没有在职员工，无需转移人员。",
            `${pendingDepartmentDisable.impact.enabledSeatCount} 名已启用员工的任务资格保持不变。`,
            "历史员工档案、活动归属和审计记录不会被删除。",
          ],
          reasonLabel: "停用原因",
          summary: `即将停用 ${pendingDepartmentDisable.department.name}。`,
          title: "确认停用这个部门？",
          tone: "warning",
        }
      : null;
  return (
    <SaasShell
      active="employees"
      description="分别管理员工任职、启用状态和后续活动参与状态。"
      mode="console"
      navigationPermissions={navigationPermissions}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="员工管理"
      toolbar={
        <div className="workspaceActionButtons">
          <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
            刷新员工
          </button>
          <button
            className="primaryButton createButton"
            onClick={() => setDrawerMode("MEMBER")}
            type="button"
          >
            录入员工
          </button>
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      {hasParticipationPermission && !canManageParticipation ? (
        <div className="inlineNotice">
          当前由集团统一决定本企业哪些人员参与发布。你仍可查看参与状态，但不能修改。
        </div>
      ) : null}
      <section className="metricGrid four">
        <Metric
          detail="当前企业成员身份"
          label="员工档案"
          value={memberships.length}
          tone="accent"
        />
        <Metric detail="已启用员工可参与后续活动" label="已启用员工" value={enabled} />
        <Metric detail="可进入以后创建的活动" label="正常参与" value={participating} />
        <Metric detail="新成员需要运营确认" label="待确认参与" value={pendingParticipation} />
      </section>

      <section className="workspaceActionBar">
        <WorkspaceTabs
          active={activeView}
          ariaLabel="员工工作视图"
          onChange={setActiveView}
          tabs={[
            { count: memberships.length, key: "ALL", label: "全部员工" },
            { count: pendingBind, key: "PENDING_BIND", label: "待绑定" },
            { count: noSeat, key: "NO_SEAT", label: "未启用员工" },
            { count: left, key: "LEFT", label: "已离职" },
          ]}
        />
        <div className="workspaceActionButtons">
          <button className="ghostButton" onClick={() => setDrawerMode("DEPARTMENT")} type="button">
            管理部门
          </button>
          <button
            className="ghostButton"
            onClick={() => setDrawerMode("IMPORT_HISTORY")}
            type="button"
          >
            导入记录
          </button>
          <button className="ghostButton" onClick={() => setDrawerMode("CSV")} type="button">
            批量导入
          </button>
        </div>
      </section>

      <section className="panel employeeDirectoryPanel">
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">员工目录</span>
            <h2>{employeeViewTitle(activeView)}</h2>
            <p>短信通知状态以运营商送达结果为准；待验证表示尚无送达确认。</p>
          </div>
          <StatusBadge tone="neutral">
            当前显示 {filteredMemberships.length} / {membershipTotalCount} 人
          </StatusBadge>
        </div>
        <div className="workspaceFilters employeeDirectoryFilters">
          <input
            aria-label="搜索员工"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索姓名、手机号、工号或部门"
            type="search"
            value={search}
          />
          <select
            aria-label="按部门筛选"
            onChange={(event) => setDepartmentFilter(event.target.value)}
            value={departmentFilter}
          >
            <option value="">全部部门</option>
            <option value="UNGROUPED">未分组</option>
            {activeDepartments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
          <select
            aria-label="按任务参与状态筛选"
            onChange={(event) =>
              setParticipationFilter(event.target.value as ParticipationStatus | "")
            }
            value={participationFilter}
          >
            <option value="">全部参与状态</option>
            <option value="PENDING_REVIEW">待确认</option>
            <option value="PARTICIPATING">正常参与</option>
            <option value="PAUSED">暂停参与</option>
            <option value="EXEMPT">长期免参与</option>
          </select>
          <select
            aria-label="按号码状态筛选"
            onChange={(event) => {
              setSelectedMembershipIds([]);
              setSmsStatusFilter(event.target.value as SmsNotificationStatus | "");
            }}
            value={smsStatusFilter}
          >
            <option value="">全部号码状态</option>
            <option value="PENDING_VERIFICATION">待验证</option>
            <option value="NORMAL">正常</option>
            <option value="NEEDS_REVIEW">请核实号码</option>
          </select>
        </div>
        {selectedMembershipIds.length > 0 ? (
          <div className="employeeBulkBar" aria-live="polite">
            <div>
              <strong>已选择 {selectedMembershipIds.length} 人</strong>
              <span>
                {selectedMemberships.some(({ status }) => status === "LEFT")
                  ? "包含离职员工时，系统会拒绝不适用的整批操作。"
                  : "整批操作要么全部成功，要么不修改任何员工。"}
              </span>
            </div>
            <div className="workspaceActionButtons">
              {hasParticipationPermission ? (
                <button
                  disabled={!canManageParticipation}
                  onClick={openBulkParticipation}
                  title={canManageParticipation ? undefined : "当前由集团统一管理"}
                  type="button"
                >
                  设置参与状态
                </button>
              ) : null}
              <button onClick={() => openBulkAction("ENABLE")} type="button">
                批量启用
              </button>
              <button onClick={() => openBulkAction("DISABLE")} type="button">
                批量停用
              </button>
              <button onClick={() => openBulkAction("TRANSFER")} type="button">
                批量转部门
              </button>
              <button className="dangerText" onClick={() => openBulkAction("LEAVE")} type="button">
                批量离职
              </button>
              <button
                className="ghostButton"
                onClick={() => setSelectedMembershipIds([])}
                type="button"
              >
                取消选择
              </button>
            </div>
          </div>
        ) : null}
        <div className="membershipTable">
          <div className="membershipTableHead">
            <label className="rowSelection">
              <input
                aria-label="选择当前显示的员工"
                checked={allVisibleSelected}
                ref={(input) => {
                  if (input) input.indeterminate = someVisibleSelected;
                }}
                onChange={(event) => {
                  const visibleIds = selectableMemberships.map(({ id }) => id);
                  setSelectedMembershipIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, ...visibleIds])]
                      : current.filter((id) => !visibleIds.includes(id)),
                  );
                }}
                type="checkbox"
              />
            </label>
            <span>员工</span>
            <span>部门</span>
            <span>账号绑定</span>
            <span>任务参与</span>
            <span>员工启用</span>
            <span>短信通知状态</span>
            <span>操作</span>
          </div>
          {filteredMemberships.map((membership) => (
            <article key={membership.id}>
              <label className="rowSelection">
                <input
                  aria-label={`选择员工 ${membership.name}`}
                  checked={selectedMembershipIds.includes(membership.id)}
                  disabled={membership.status === "LEFT"}
                  onChange={(event) =>
                    setSelectedMembershipIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, membership.id])]
                        : current.filter((id) => id !== membership.id),
                    )
                  }
                  type="checkbox"
                />
              </label>
              <div className="membershipIdentity">
                <strong>{membership.name}</strong>
                <small>
                  {maskPhone(membership.phone)} · {membership.employeeNo ?? "未设工号"}
                </small>
              </div>
              <span>
                {departments.find(({ id }) => id === membership.departmentId)?.name ?? "未分组"}
              </span>
              <StatusBadge tone={membershipStatusTone(membership.status)}>
                {membershipStatusLabel(membership.status)}
              </StatusBadge>
              <div className="membershipParticipationCell">
                <StatusBadge
                  tone={participationStatusTone(effectiveParticipationStatus(membership))}
                >
                  {participationStatusLabel(effectiveParticipationStatus(membership))}
                </StatusBadge>
                {membership.participation?.lockedByTenant ? <small>集团锁定</small> : null}
              </div>
              <StatusBadge tone={membership.seatStatus === "ENABLED" ? "success" : "warning"}>
                {membership.seatStatus === "ENABLED" ? "已启用" : "未启用"}
              </StatusBadge>
              <div className="membershipSmsCell">
                <small>短信通知状态</small>
                {membership.smsNotificationStatus === null ? (
                  <span className="membershipSmsUnknown" title="暂无可靠号码结论">
                    —
                  </span>
                ) : (
                  <StatusBadge tone={smsNotificationStatusTone(membership.smsNotificationStatus)}>
                    {smsNotificationStatusLabel(membership.smsNotificationStatus)}
                  </StatusBadge>
                )}
              </div>
              <div className="membershipActions">
                {membership.status !== "LEFT" &&
                canManagePublisher &&
                !membership.globalUserId &&
                membership.seatStatus === "ENABLED" ? (
                  <button
                    className="ghostButton"
                    disabled={busyId === membership.id}
                    type="button"
                    onClick={() => {
                      setWebAccountMember(membership);
                      setWebAccountForm({ username: "", password: "", confirmation: "" });
                      setDrawerMode("WEB_ACCOUNT");
                    }}
                  >
                    创建网页账号
                  </button>
                ) : null}
                {membership.status !== "LEFT" &&
                canManagePublisher &&
                membership.publisherContext ? (
                  <button type="button" onClick={() => openPublisherEditor(membership)}>
                    历史发布安排
                  </button>
                ) : null}
                {membership.status !== "LEFT" ? (
                  <button onClick={() => openMembershipEditor(membership)} type="button">
                    编辑
                  </button>
                ) : null}
                {membership.status !== "LEFT" && hasParticipationPermission ? (
                  <button
                    disabled={!canManageParticipation}
                    onClick={() => openParticipationEditor(membership)}
                    title={canManageParticipation ? undefined : "当前由集团统一管理"}
                    type="button"
                  >
                    参与设置
                  </button>
                ) : null}
                {membership.status !== "LEFT" ? (
                  <button
                    disabled={busyId === membership.id}
                    onClick={() =>
                      requestSeatChange(
                        membership,
                        membership.seatStatus === "ENABLED" ? "disable" : "enable",
                      )
                    }
                    type="button"
                  >
                    {busyId === membership.id
                      ? "处理中…"
                      : membership.seatStatus === "ENABLED"
                        ? "停用"
                        : "启用"}
                  </button>
                ) : null}
                {membership.status !== "LEFT" ? (
                  <button
                    className="dangerText"
                    disabled={busyId === membership.id}
                    onClick={() => requestSeatChange(membership, "leave")}
                    type="button"
                  >
                    离职
                  </button>
                ) : null}
              </div>
            </article>
          ))}
          {filteredMemberships.length === 0 ? (
            <div className="emptyState compact">
              <strong>
                {memberships.length === 0 && !smsStatusFilter
                  ? "还没有员工档案"
                  : "没有符合条件的员工"}
              </strong>
              <p>
                {memberships.length === 0 && !smsStatusFilter
                  ? "可以录入单个员工，或通过 CSV 一次导入多人。"
                  : "请更换号码状态、工作视图、部门或搜索条件。"}
              </p>
            </div>
          ) : null}
          {membershipNextCursor ? (
            <button
              className="ghostButton directoryLoadMore"
              disabled={busyId !== null}
              onClick={() => void load(membershipNextCursor)}
              type="button"
            >
              加载更多员工
            </button>
          ) : null}
        </div>
      </section>

      <WorkspaceDrawer
        open={drawerMode === "WEB_ACCOUNT"}
        onClose={() => {
          setDrawerMode(null);
          setWebAccountForm({ username: "", password: "", confirmation: "" });
        }}
        title="创建员工网页账号"
        description={`为 ${webAccountMember?.name ?? "当前成员"} 创建登录账号并绑定其成员身份，无需员工注册。`}
      >
        <form className="drawerForm" onSubmit={(event) => void createWebAccount(event)}>
          <section className="drawerSection">
            <label className="field">
              登录账号
              <input
                autoComplete="off"
                required
                minLength={3}
                maxLength={64}
                value={webAccountForm.username}
                onChange={(event) =>
                  setWebAccountForm({ ...webAccountForm, username: event.target.value })
                }
                disabled={busyId !== null}
              />
            </label>
            <label className="field">
              初始密码
              <input
                autoComplete="new-password"
                required
                type="password"
                minLength={12}
                maxLength={128}
                value={webAccountForm.password}
                onChange={(event) =>
                  setWebAccountForm({ ...webAccountForm, password: event.target.value })
                }
                disabled={busyId !== null}
              />
              <small>12–128 位，含字母和数字。请通过安全方式告知员工。</small>
            </label>
            <label className="field">
              确认密码
              <input
                autoComplete="new-password"
                required
                type="password"
                minLength={12}
                maxLength={128}
                value={webAccountForm.confirmation}
                onChange={(event) =>
                  setWebAccountForm({ ...webAccountForm, confirmation: event.target.value })
                }
                disabled={busyId !== null}
              />
            </label>
          </section>
          <button
            className="primaryButton block drawerSubmit"
            type="submit"
            disabled={busyId !== null}
          >
            {busyId ? "正在创建…" : "创建并绑定员工"}
          </button>
        </form>
      </WorkspaceDrawer>

      <WorkspaceDrawer
        open={drawerMode === "PUBLISHER"}
        onClose={() => setDrawerMode(null)}
        title="维护历史发布安排"
        description="仅用于已有医疗计划与历史内容的兼容维护；新活动使用通用生成方式。"
      >
        <form
          className={publisherStyles.form}
          onSubmit={(event) => void savePublisherContext(event)}
        >
          <p>
            当前员工：{publisherMembership?.name}
            。助理昵称和任职证明不能代替平台资格；请填写可核查依据。
          </p>
          <label>
            实际发布条件
            <select
              aria-label="实际发布条件"
              value={publisherForm.category}
              disabled={busyId === "publisher"}
              onChange={(event) =>
                setPublisherForm({
                  ...publisherForm,
                  category: event.target.value as PublisherContext["category"],
                  allowBrandAttribution: false,
                  allowPlatformConsultation: false,
                })
              }
            >
              <option value="UNKNOWN">尚未核实</option>
              <option value="ORDINARY">普通个人 / 员工账号</option>
              <option value="MEDICAL_KOS">已核实医疗企业 KOS</option>
              <option value="INSTITUTION">已核实机构官方账号</option>
            </select>
          </label>
          <label>
            小红书公开作者 ID
            <input
              value={publisherForm.authorId}
              required
              minLength={6}
              maxLength={100}
              pattern="[a-zA-Z0-9_-]{6,100}"
              onChange={(event) =>
                setPublisherForm({ ...publisherForm, authorId: event.target.value })
              }
              placeholder="企业核对的作者标识"
            />
          </label>
          <label>
            真实岗位
            <input
              value={publisherForm.role}
              maxLength={100}
              onChange={(event) => setPublisherForm({ ...publisherForm, role: event.target.value })}
              placeholder="仅填写本人真实岗位"
            />
          </label>
          <label>
            核验依据
            <textarea
              value={publisherForm.evidence}
              required
              minLength={4}
              maxLength={2000}
              rows={4}
              onChange={(event) =>
                setPublisherForm({ ...publisherForm, evidence: event.target.value })
              }
              placeholder="平台核验记录、适用内容范围和依据"
            />
          </label>
          <label>
            核验有效期
            <input
              type="datetime-local"
              value={publisherForm.validUntil}
              required
              onChange={(event) =>
                setPublisherForm({ ...publisherForm, validUntil: event.target.value })
              }
            />
          </label>
          <label className={publisherStyles.check}>
            <input
              type="checkbox"
              checked={publisherForm.allowBrandAttribution}
              disabled={
                !["MEDICAL_KOS", "INSTITUTION"].includes(publisherForm.category) ||
                busyId === "publisher"
              }
              onChange={(event) =>
                setPublisherForm({ ...publisherForm, allowBrandAttribution: event.target.checked })
              }
            />
            本次核实范围允许品牌归属表达
          </label>
          <label className={publisherStyles.check}>
            <input
              type="checkbox"
              checked={publisherForm.allowPlatformConsultation}
              disabled={
                !["MEDICAL_KOS", "INSTITUTION"].includes(publisherForm.category) ||
                busyId === "publisher"
              }
              onChange={(event) =>
                setPublisherForm({
                  ...publisherForm,
                  allowPlatformConsultation: event.target.checked,
                })
              }
            />
            本次核实范围允许站内咨询承接
          </label>
          <label>
            变更原因
            <input
              value={publisherForm.reason}
              required
              minLength={4}
              maxLength={500}
              onChange={(event) =>
                setPublisherForm({ ...publisherForm, reason: event.target.value })
              }
            />
          </label>
          <p>系统仍按每次内容和渠道检查。未核验或已过期时，由企业补齐条件，员工只报告异常。</p>
          <button type="submit" disabled={busyId === "publisher"}>
            {busyId === "publisher" ? "正在保存…" : "确认并保存发布安排"}
          </button>
        </form>
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="新增员工默认启用任务资格，录入后可发送网页邀请。同手机号且姓名一致时更新原员工资料；姓名不一致时提示冲突。"
        onClose={() => setDrawerMode(null)}
        open={drawerMode === "MEMBER"}
        title="录入员工"
      >
        <form className="drawerForm" onSubmit={(event) => void importMember(event)}>
          <label className="field">
            <span>姓名</span>
            <input
              autoComplete="name"
              required
              value={memberForm.name}
              onChange={(event) => setMemberForm({ ...memberForm, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>手机号</span>
            <input
              autoComplete="tel"
              inputMode="numeric"
              maxLength={11}
              required
              value={memberForm.phone}
              onChange={(event) => setMemberForm({ ...memberForm, phone: event.target.value })}
            />
            <small>手机号用于员工档案及可选通知；网页加入使用成员专属邀请链接。</small>
          </label>
          <div className="fieldGrid">
            <label className="field">
              <span>工号（选填）</span>
              <input
                value={memberForm.employeeNo}
                onChange={(event) =>
                  setMemberForm({ ...memberForm, employeeNo: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>部门</span>
              <select
                value={memberForm.departmentCode}
                onChange={(event) =>
                  setMemberForm({ ...memberForm, departmentCode: event.target.value })
                }
              >
                <option value="">未分组</option>
                {activeDepartments.map((department) => (
                  <option key={department.id} value={department.code}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="primaryButton block drawerSubmit"
            disabled={busyId === "import"}
            type="submit"
          >
            {busyId === "import" ? "正在保存…" : "保存员工档案"}
          </button>
        </form>
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="姓名、工号和部门调整保留审计记录；手机号有误时，请单独更正。"
        onClose={() => {
          setDrawerMode(null);
          setEditingMembership(null);
        }}
        open={drawerMode === "EDIT"}
        title="编辑员工资料"
      >
        {editingMembership ? (
          <form className="drawerForm" onSubmit={(event) => void updateMembership(event)}>
            <div className="recordContextCard">
              <span>当前员工</span>
              <strong>{editingMembership.name}</strong>
              <small>{maskPhone(editingMembership.phone)}</small>
              <button
                className="ghostButton employeePhoneEditButton"
                onClick={openPhoneCorrection}
                type="button"
              >
                更正手机号
              </button>
            </div>
            <label className="field">
              <span>姓名</span>
              <input
                required
                value={membershipEditForm.name}
                onChange={(event) =>
                  setMembershipEditForm({ ...membershipEditForm, name: event.target.value })
                }
              />
            </label>
            <div className="fieldGrid">
              <label className="field">
                <span>工号（选填）</span>
                <input
                  value={membershipEditForm.employeeNo}
                  onChange={(event) =>
                    setMembershipEditForm({
                      ...membershipEditForm,
                      employeeNo: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>部门</span>
                <select
                  value={membershipEditForm.departmentId}
                  onChange={(event) =>
                    setMembershipEditForm({
                      ...membershipEditForm,
                      departmentId: event.target.value,
                    })
                  }
                >
                  <option value="">未分组</option>
                  {activeDepartments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>修改说明</span>
              <textarea
                required
                rows={3}
                value={membershipEditForm.reason}
                onChange={(event) =>
                  setMembershipEditForm({ ...membershipEditForm, reason: event.target.value })
                }
              />
            </label>
            <button
              className="primaryButton block drawerSubmit"
              disabled={busyId === "edit-membership"}
              type="submit"
            >
              {busyId === "edit-membership" ? "正在保存…" : "保存员工资料"}
            </button>
          </form>
        ) : null}
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="同一企业的手机号不能重复；手机号更正后，短信通知状态变为待验证。"
        onClose={() => {
          setDrawerMode(null);
          setEditingMembership(null);
        }}
        open={drawerMode === "PHONE"}
        title="更正员工手机号"
      >
        {editingMembership ? (
          <form className="drawerForm" onSubmit={(event) => void correctMembershipPhone(event)}>
            <div className="recordContextCard">
              <span>当前员工</span>
              <strong>{editingMembership.name}</strong>
              <small>当前手机号：{maskPhone(editingMembership.phone)}</small>
            </div>
            <label className="field">
              <span>正确手机号</span>
              <input
                autoComplete="tel"
                inputMode="tel"
                maxLength={11}
                pattern="1[3-9][0-9]{9}"
                required
                type="tel"
                value={phoneCorrectionForm.phone}
                onChange={(event) =>
                  setPhoneCorrectionForm({ ...phoneCorrectionForm, phone: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>更正原因</span>
              <textarea
                required
                rows={3}
                value={phoneCorrectionForm.reason}
                onChange={(event) =>
                  setPhoneCorrectionForm({ ...phoneCorrectionForm, reason: event.target.value })
                }
              />
            </label>
            <div className="inlineNotice employeePhoneCorrectionNotice">
              {editingMembership.status === "ACTIVE" ? (
                <p>
                  保存后将重置该员工在本企业的绑定，请重新发送成员邀请；使用小程序时需重新验证手机号。
                </p>
              ) : (
                <p>网页成员通过专属邀请加入；小程序成员可用正确手机号重新验证。</p>
              )}
              <p>其他企业的绑定不受影响，历史记录保留，旧通知不会补发。</p>
            </div>
            <button
              className="primaryButton block drawerSubmit"
              disabled={
                busyId === "correct-phone" ||
                phoneCorrectionForm.phone.trim() === editingMembership.phone ||
                !phoneCorrectionForm.reason.trim()
              }
              type="submit"
            >
              {busyId === "correct-phone" ? "正在保存…" : "保存正确手机号"}
            </button>
          </form>
        ) : null}
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="参与状态只影响以后创建的活动，不会取消已经生成、审核或开放的员工任务。员工启用状态仍需单独管理。"
        onClose={() => {
          setDrawerMode(null);
          setParticipationMembership(null);
        }}
        open={drawerMode === "PARTICIPATION" || drawerMode === "BULK_PARTICIPATION"}
        title={participationMembership ? "设置员工参与状态" : "批量设置参与状态"}
      >
        <form
          className="drawerForm participationForm"
          onSubmit={(event) => void saveParticipation(event)}
        >
          <div className="recordContextCard">
            <span>{participationMembership ? "当前员工" : "当前选择"}</span>
            <strong>
              {participationMembership
                ? participationMembership.name
                : `${selectedMembershipIds.length} 名员工`}
            </strong>
            <small>
              {participationMembership
                ? "任务参与状态可在此独立管理"
                : "任一员工不符合权限或集团锁定规则时，整批不会生效"}
            </small>
          </div>
          <label className="field">
            <span>后续活动参与状态</span>
            <select
              onChange={(event) => {
                const status = event.target.value as ParticipationStatus;
                setParticipationForm({
                  ...participationForm,
                  effectiveUntil: status === "PAUSED" ? participationForm.effectiveUntil : "",
                  reason: participationDefaultReason(status),
                  status,
                });
              }}
              value={participationForm.status}
            >
              <option value="PENDING_REVIEW">待确认</option>
              <option value="PARTICIPATING">正常参与</option>
              <option value="PAUSED">暂停参与</option>
              <option value="EXEMPT">长期免参与</option>
            </select>
          </label>
          {participationForm.status === "PAUSED" ? (
            <label className="field">
              <span>自动恢复时间</span>
              <input
                min={toDateTimeLocal(new Date().toISOString())}
                onChange={(event) =>
                  setParticipationForm({
                    ...participationForm,
                    effectiveUntil: event.target.value,
                  })
                }
                required
                type="datetime-local"
                value={participationForm.effectiveUntil}
              />
              <small>到期后系统自动恢复为正常参与，并写入审计记录。</small>
            </label>
          ) : null}
          {canTenantLockParticipation ? (
            <label className="checkboxRow">
              <input
                checked={participationForm.lockedByTenant}
                onChange={(event) =>
                  setParticipationForm({
                    ...participationForm,
                    lockedByTenant: event.target.checked,
                  })
                }
                type="checkbox"
              />
              <span>
                <strong>由集团锁定此状态</strong>
                <small>锁定后企业管理员只能查看，不能覆盖；暂停到期仍会按时恢复。</small>
              </span>
            </label>
          ) : null}
          <label className="field">
            <span>调整原因</span>
            <textarea
              onChange={(event) =>
                setParticipationForm({ ...participationForm, reason: event.target.value })
              }
              required
              rows={3}
              value={participationForm.reason}
            />
          </label>
          <div className="bulkImpactCard">
            <strong>本次调整的影响</strong>
            <p>{participationImpact(participationForm.status)}</p>
            <small>已创建活动的参与名单不会自动更改。</small>
          </div>
          <button
            className="primaryButton block drawerSubmit"
            disabled={busyId === "participation"}
            type="submit"
          >
            {busyId === "participation" ? "正在保存…" : "确认参与状态"}
          </button>
        </form>
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description={
          bulkAction
            ? `${bulkActionLabel(bulkAction)}会同时处理当前选择的 ${selectedMembershipIds.length} 名员工，任一员工不符合条件时整批不生效。`
            : "选择员工后执行整批人资操作。"
        }
        onClose={() => {
          setDrawerMode(null);
          setBulkAction(null);
        }}
        open={drawerMode === "BULK"}
        title={bulkAction ? bulkActionLabel(bulkAction) : "批量处理员工"}
      >
        {bulkAction ? (
          <form className="drawerForm" onSubmit={(event) => void executeBulkAction(event)}>
            <div className={`bulkImpactCard ${bulkAction === "LEAVE" ? "danger" : ""}`}>
              <strong>{selectedMembershipIds.length} 名员工将被处理</strong>
              <p>{bulkActionImpact(bulkAction)}</p>
              <small>
                {selectedMemberships
                  .slice(0, 5)
                  .map(({ name }) => name)
                  .join("、")}
                {selectedMemberships.length > 5 ? ` 等 ${selectedMemberships.length} 人` : ""}
              </small>
            </div>
            {bulkAction === "TRANSFER" ? (
              <label className="field">
                <span>接收部门</span>
                <select
                  required
                  value={bulkForm.departmentId}
                  onChange={(event) =>
                    setBulkForm({ ...bulkForm, departmentId: event.target.value })
                  }
                >
                  <option value="">请选择接收部门</option>
                  {activeDepartments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              <span>操作说明</span>
              <textarea
                required
                rows={3}
                value={bulkForm.reason}
                onChange={(event) => setBulkForm({ ...bulkForm, reason: event.target.value })}
              />
            </label>
            <button
              className={bulkAction === "LEAVE" ? "dangerButton block" : "primaryButton block"}
              disabled={busyId === "bulk-membership"}
              type="submit"
            >
              {busyId === "bulk-membership" ? "正在处理…" : `确认${bulkActionLabel(bulkAction)}`}
            </button>
          </form>
        ) : null}
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="每次预检都会保存记录，包括未通过的错误批次，便于追踪名单来源并避免重复整理。"
        onClose={() => setDrawerMode(null)}
        open={drawerMode === "IMPORT_HISTORY"}
        title="员工导入记录"
      >
        <div className="importHistoryList">
          {importBatches.map((batch) => (
            <article key={batch.id}>
              <div>
                <StatusBadge tone={importBatchTone(batch.status)}>
                  {importBatchStatusLabel(batch.status)}
                </StatusBadge>
                <time dateTime={batch.createdAt}>{formatDateTime(batch.createdAt)}</time>
              </div>
              <strong>
                {batch.fileName ?? (batch.source === "CSV" ? "未命名 CSV" : "单人录入")}
              </strong>
              <p>
                共 {batch.rowCount} 行 · 新增 {batch.createCount} · 更新 {batch.updateCount} · 错误{" "}
                {batch.errorCount}
              </p>
              {batch.status === "PREVIEW_FAILED" ? (
                <small>该批次没有写入员工档案，请修正原文件后重新预检。</small>
              ) : batch.status === "PREVIEW_READY" ? (
                <small>已预检但尚未确认导入，可重新选择原文件继续。</small>
              ) : (
                <small>已完整导入，可在员工列表查看当前任务资格和绑定状态。</small>
              )}
            </article>
          ))}
          {importBatches.length === 0 ? (
            <div className="emptyState compact">
              <strong>还没有导入记录</strong>
              <p>选择 CSV 文件预检后，这里会自动保留成功和失败批次。</p>
            </div>
          ) : null}
        </div>
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="先下载模板并整理员工名单。系统会先预检全部数据，发现错误时不会写入任何一行。"
        onClose={() => setDrawerMode(null)}
        open={drawerMode === "CSV"}
        title="批量导入员工"
      >
        <div className="drawerSection csvDrawerIntro">
          <button className="ghostButton" onClick={downloadCsvTemplate} type="button">
            下载 CSV 模板
          </button>
          <p>
            支持 UTF-8 / GB18030，单次最多 500
            人；姓名和手机号为必填项。新员工默认启用任务资格，已有员工保留原状态。
          </p>
        </div>
        <div className="drawerSection">
          <div className="csvImportToolbar">
            <label className="csvFilePicker">
              <input
                accept=".csv,text/csv"
                disabled={busyId === "csv-preview" || busyId === "csv-import"}
                key={csvInputKey}
                onChange={(event) => void previewCsv(event)}
                type="file"
              />
              <span>{busyId === "csv-preview" ? "正在预检…" : "选择 CSV 文件"}</span>
            </label>
            <div>
              <strong>{csvFileName ?? "尚未选择文件"}</strong>
              <small>选择文件后只做预检，不会立即导入</small>
            </div>
            {csvPreview?.summary.errorCount || csvPreview?.fileErrors.length ? (
              <button
                className="ghostButton"
                onClick={() => downloadCsvErrorReport(csvFileName, csvPreview)}
                type="button"
              >
                下载错误报告
              </button>
            ) : null}
          </div>
        </div>
        {csvPreview ? (
          <div className="csvPreview drawerSection">
            <div className="csvPreviewSummary">
              <span>
                总计 <strong>{csvPreview.summary.totalCount}</strong>
              </span>
              <span>
                新增 <strong>{csvPreview.summary.createCount}</strong>
              </span>
              <span>
                更新 <strong>{csvPreview.summary.updateCount}</strong>
              </span>
              <span className={csvPreview.summary.errorCount ? "hasError" : ""}>
                错误 <strong>{csvPreview.summary.errorCount}</strong>
              </span>
            </div>
            {csvPreview.fileErrors.length > 0 ? (
              <div className="inlineError">
                {csvPreview.fileErrors.map((item) => (
                  <p key={`${item.code}-${item.message}`}>{item.message}</p>
                ))}
              </div>
            ) : null}
            <div className="csvPreviewTable">
              <div className="csvPreviewTableHead">
                <span>行号</span>
                <span>结果</span>
                <span>员工</span>
                <span>工号 / 部门</span>
                <span>说明</span>
              </div>
              {csvPreview.rows.map((row) => (
                <article key={`${row.rowNumber}-${row.normalized.maskedPhone}`}>
                  <span>{row.rowNumber}</span>
                  <StatusBadge tone={importActionTone(row.action)}>
                    {importActionLabel(row.action)}
                  </StatusBadge>
                  <div>
                    <strong>{row.normalized.name || "未填写姓名"}</strong>
                    <small>{row.normalized.maskedPhone}</small>
                  </div>
                  <div>
                    <strong>{row.normalized.employeeNo ?? "未设工号"}</strong>
                    <small>{row.normalized.departmentCode ?? "未分组"}</small>
                  </div>
                  <span>
                    {row.errors.length > 0
                      ? row.errors.map(({ message }) => message).join("；")
                      : row.action === "CREATE"
                        ? "将新增员工并启用任务资格"
                        : "将更新同手机号员工资料"}
                  </span>
                </article>
              ))}
            </div>
            <div className="csvConfirmBar">
              <p>
                {csvPreview.canImport
                  ? "预检通过。确认后会再次校验，全部通过才会写入。"
                  : "请修正 CSV 后重新选择文件，当前批次不能导入。"}
              </p>
              <button
                className="primaryButton"
                disabled={!csvPreview.canImport || busyId === "csv-import"}
                onClick={() => void confirmCsvImport()}
                type="button"
              >
                {busyId === "csv-import" ? "正在导入…" : "确认整批导入"}
              </button>
            </div>
          </div>
        ) : null}
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="部门用于筛选员工和组织活动受众。创建时自动生成部门代码，供导入名单使用。"
        onClose={() => {
          setDrawerMode(null);
          setEditingDepartment(null);
          setDepartmentForm({ code: "", name: "" });
          setPendingDepartmentDisable(null);
          setDepartmentDisableConfirmOpen(false);
        }}
        open={drawerMode === "DEPARTMENT"}
        title="管理部门"
      >
        <section className="drawerSection">
          <h3>现有部门</h3>
          <div className="departmentList">
            {departments.map((department) => (
              <div key={department.id}>
                <div>
                  <strong>{department.name}</strong>
                  <span>{department.code}</span>
                </div>
                <div className="departmentActions">
                  <StatusBadge tone={department.status === "ACTIVE" ? "success" : "neutral"}>
                    {department.status === "ACTIVE" ? "使用中" : "已停用"}
                  </StatusBadge>
                  {department.status === "ACTIVE" ? (
                    <>
                      <button onClick={() => editDepartment(department)} type="button">
                        编辑
                      </button>
                      <button
                        className="dangerText"
                        disabled={busyId === `department-impact-${department.id}`}
                        onClick={() => void inspectDepartmentDisable(department)}
                        type="button"
                      >
                        {busyId === `department-impact-${department.id}` ? "检查中…" : "停用"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
            {departments.length === 0 ? <p className="emptyHint">尚未建立部门。</p> : null}
          </div>
        </section>
        {pendingDepartmentDisable ? (
          <section className="drawerSection departmentImpactPanel">
            <h3>停用前影响检查</h3>
            <p>
              {pendingDepartmentDisable.department.name} 当前有{" "}
              <strong>{pendingDepartmentDisable.impact.memberCount}</strong> 名在职员工、{" "}
              <strong>{pendingDepartmentDisable.impact.enabledSeatCount}</strong> 名已启用员工。
            </p>
            {pendingDepartmentDisable.impact.sampleMemberNames.length > 0 ? (
              <small>
                涉及员工示例：{pendingDepartmentDisable.impact.sampleMemberNames.join("、")}
              </small>
            ) : null}
            {pendingDepartmentDisable.impact.memberCount > 0 ? (
              <label className="field">
                <span>员工接收部门</span>
                <select
                  value={pendingDepartmentDisable.transferDepartmentId ?? ""}
                  onChange={(event) =>
                    setPendingDepartmentDisable({
                      ...pendingDepartmentDisable,
                      transferDepartmentId: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">请选择接收部门</option>
                  {activeDepartments
                    .filter(({ id }) => id !== pendingDepartmentDisable.department.id)
                    .map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <button
              className="dangerButton block"
              disabled={
                pendingDepartmentDisable.impact.memberCount > 0 &&
                !pendingDepartmentDisable.transferDepartmentId
              }
              onClick={() => {
                setDepartmentDisableConfirmOpen(true);
              }}
              type="button"
            >
              继续确认停用
            </button>
          </section>
        ) : null}
        <form
          className="drawerSection drawerForm"
          onSubmit={(event) => void createDepartment(event)}
        >
          <div className="drawerSectionTitle">
            <h3>{editingDepartment ? "编辑部门" : "新增部门"}</h3>
            {editingDepartment ? (
              <button
                className="ghostButton"
                onClick={() => {
                  setEditingDepartment(null);
                  setDepartmentForm({ code: "", name: "" });
                }}
                type="button"
              >
                取消编辑
              </button>
            ) : null}
          </div>
          <div className={editingDepartment ? "fieldGrid" : "fieldGrid departmentCreateFields"}>
            <label className="field">
              <span>部门名称</span>
              <input
                required
                value={departmentForm.name}
                onChange={(event) =>
                  setDepartmentForm({ ...departmentForm, name: event.target.value })
                }
              />
            </label>
            {editingDepartment ? (
              <label className="field">
                <span>部门代码</span>
                <input
                  required
                  value={departmentForm.code}
                  onChange={(event) =>
                    setDepartmentForm({ ...departmentForm, code: event.target.value.toUpperCase() })
                  }
                />
              </label>
            ) : null}
          </div>
          <button
            className="primaryButton block drawerSubmit"
            disabled={busyId === "department"}
            type="submit"
          >
            {busyId === "department"
              ? "正在保存…"
              : editingDepartment
                ? "保存部门修改"
                : "创建部门"}
          </button>
        </form>
      </WorkspaceDrawer>

      <ActionConfirmDialog
        busy={Boolean(pendingSeatAction && busyId === pendingSeatAction.membership.id)}
        onCancel={() => setPendingSeatAction(null)}
        onConfirm={(reason) => {
          if (pendingSeatAction) {
            void changeSeat(pendingSeatAction.membership, pendingSeatAction.action, reason);
          }
        }}
        state={seatDialogState}
      />
      <ActionConfirmDialog
        busy={Boolean(
          pendingDepartmentDisable &&
            busyId === `department-disable-${pendingDepartmentDisable.department.id}`,
        )}
        onCancel={() => setDepartmentDisableConfirmOpen(false)}
        onConfirm={(reason) => void disableDepartment(reason)}
        state={departmentDialogState}
      />
    </SaasShell>
  );
}

async function parseMembershipCsv(
  file: File,
): Promise<Readonly<{ headers: string[]; members: CsvMember[] }>> {
  if (file.size > 2 * 1024 * 1024) {
    throw new Error("CSV 文件不能超过 2 MB");
  }
  const bytes = await file.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("gb18030").decode(bytes);
  }
  const records = parseCsvRecords(text).filter(({ cells }) =>
    cells.some((cell) => cell.trim().length > 0),
  );
  const headerRecord = records[0];
  if (!headerRecord) throw new Error("CSV 文件为空");
  const headers = headerRecord.cells.map((cell, index) =>
    (index === 0 ? cell.replace(/^\uFEFF/u, "") : cell).trim(),
  );
  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) throw new Error("CSV 没有员工数据行");
  if (dataRecords.length > 500) throw new Error("单次最多导入 500 名员工");
  const headerIndexes = new Map<string, number>();
  headers.forEach((header, index) => {
    if (!headerIndexes.has(header)) headerIndexes.set(header, index);
  });
  const valueAt = (cells: readonly string[], header: string): string => {
    const index = headerIndexes.get(header);
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };
  const members = dataRecords.map(({ cells, rowNumber }) => {
    const employeeNo = valueAt(cells, "工号");
    const departmentCode = valueAt(cells, "部门代码");
    return {
      departmentCode: departmentCode || undefined,
      employeeNo: employeeNo || undefined,
      name: valueAt(cells, "姓名"),
      phone: valueAt(cells, "手机号"),
      rowNumber,
    };
  });
  return { headers, members };
}

function parseCsvRecords(text: string): Array<{ cells: string[]; rowNumber: number }> {
  const records: Array<{ cells: string[]; rowNumber: number }> = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let lineNumber = 1;
  let recordStartLine = 1;

  const pushRecord = () => {
    cells.push(field);
    records.push({ cells, rowNumber: recordStartLine });
    cells = [];
    field = "";
    afterQuote = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) continue;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        field += "\n";
        lineNumber += 1;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field.length > 0 || afterQuote) throw new Error(`CSV 第 ${lineNumber} 行引号格式错误`);
      inQuotes = true;
    } else if (character === ",") {
      cells.push(field);
      field = "";
      afterQuote = false;
    } else if (character === "\r" || character === "\n") {
      pushRecord();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      lineNumber += 1;
      recordStartLine = lineNumber;
    } else if (afterQuote) {
      if (!/\s/u.test(character)) {
        throw new Error(`CSV 第 ${lineNumber} 行结束引号后包含无效字符`);
      }
    } else {
      field += character;
    }
  }
  if (inQuotes) throw new Error(`CSV 第 ${recordStartLine} 行存在未闭合引号`);
  if (field.length > 0 || cells.length > 0) pushRecord();
  return records;
}

function downloadCsvTemplate(): void {
  downloadCsv("员工批量导入模板.csv", [
    ["姓名", "手机号", "工号", "部门代码"],
    ["张三", "13800138000", "A001", "OPS"],
  ]);
}

function downloadCsvErrorReport(fileName: string | null, preview: ImportPreview): void {
  const rows: string[][] = [["行号", "姓名", "手机号", "工号", "部门代码", "错误代码", "错误说明"]];
  for (const error of preview.fileErrors) {
    rows.push(["文件", "", "", "", "", error.code, error.message]);
  }
  for (const row of preview.rows) {
    if (row.errors.length === 0) continue;
    rows.push([
      String(row.rowNumber),
      row.normalized.name,
      row.normalized.maskedPhone,
      row.normalized.employeeNo ?? "",
      row.normalized.departmentCode ?? "",
      row.errors.map(({ code }) => code).join(" | "),
      row.errors.map(({ message }) => message).join("；"),
    ]);
  }
  const reportName = `${(fileName ?? "员工导入").replace(/\.csv$/iu, "")}-错误报告.csv`;
  downloadCsv(reportName, rows);
}

function downloadCsv(fileName: string, rows: readonly (readonly string[])[]): void {
  const content = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function importActionLabel(action: ImportPreview["rows"][number]["action"]): string {
  return action === "CREATE" ? "新增" : action === "UPDATE" ? "更新" : "错误";
}

function importActionTone(
  action: ImportPreview["rows"][number]["action"],
): "danger" | "info" | "success" {
  return action === "CREATE" ? "success" : action === "UPDATE" ? "info" : "danger";
}

function bulkActionLabel(action: BulkAction): string {
  if (action === "ENABLE") return "批量启用员工";
  if (action === "DISABLE") return "批量停用员工";
  if (action === "TRANSFER") return "批量转部门";
  return "批量标记离职";
}

function bulkActionDefaultReason(action: BulkAction): string {
  if (action === "ENABLE") return "本批员工开始参与企业内容活动";
  if (action === "DISABLE") return "本批员工暂停参与后续内容活动";
  if (action === "TRANSFER") return "企业组织关系调整";
  return "本批员工已完成离职手续";
}

function bulkActionImpact(action: BulkAction): string {
  if (action === "ENABLE") {
    return "每名启用员工都可进入符合条件的新活动；员工人数本身不产生费用。";
  }
  if (action === "DISABLE") {
    return "员工不再进入后续活动受众，历史活动和提交记录保留；再次启用后可重新参与。";
  }
  if (action === "TRANSFER") {
    return "只调整组织归属，不改变手机号绑定、员工启用状态、历史活动或内容消耗。";
  }
  return "员工不再参与后续活动，任务资格同步停用；历史记录保留，恢复需要单独的人资流程。";
}

function importBatchStatusLabel(status: ImportBatch["status"]): string {
  if (status === "IMPORTED") return "已导入";
  if (status === "PREVIEW_READY") return "待确认";
  return "预检未通过";
}

function importBatchTone(status: ImportBatch["status"]): "danger" | "success" | "warning" {
  if (status === "IMPORTED") return "success";
  if (status === "PREVIEW_READY") return "warning";
  return "danger";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function employeeViewTitle(view: EmployeeView): string {
  if (view === "PENDING_BIND") return "等待员工绑定账号";
  if (view === "NO_SEAT") return "尚未启用任务资格的员工";
  if (view === "LEFT") return "已离职员工";
  return "全部员工";
}

function membershipStatusLabel(status: Membership["status"]): string {
  if (status === "ACTIVE") return "已绑定";
  if (status === "LEFT") return "已离职";
  if (status === "PENDING_BIND") return "待绑定";
  return "未绑定";
}

function membershipStatusTone(status: Membership["status"]): "neutral" | "success" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "PENDING_BIND") return "warning";
  return "neutral";
}

function smsNotificationStatusLabel(status: SmsNotificationStatus | undefined): string {
  if (status === "NORMAL") return "正常";
  if (status === "NEEDS_REVIEW") return "请核实号码";
  return "待验证";
}

function smsNotificationStatusTone(
  status: SmsNotificationStatus | undefined,
): "neutral" | "success" | "warning" {
  if (status === "NORMAL") return "success";
  if (status === "NEEDS_REVIEW") return "warning";
  return "neutral";
}

function effectiveParticipationStatus(membership: Membership): ParticipationStatus {
  const participation = membership.participation;
  if (!participation) return "PARTICIPATING";
  if (
    participation.status === "PAUSED" &&
    participation.effectiveUntil &&
    new Date(participation.effectiveUntil) <= new Date()
  ) {
    return "PARTICIPATING";
  }
  return participation.status;
}

function participationStatusLabel(status: ParticipationStatus): string {
  return {
    EXEMPT: "长期免参与",
    PARTICIPATING: "正常参与",
    PAUSED: "暂停参与",
    PENDING_REVIEW: "待确认",
  }[status];
}

function participationStatusTone(
  status: ParticipationStatus,
): "info" | "neutral" | "success" | "warning" {
  if (status === "PARTICIPATING") return "success";
  if (status === "PENDING_REVIEW") return "warning";
  if (status === "PAUSED") return "info";
  return "neutral";
}

function participationDefaultReason(status: ParticipationStatus): string {
  return {
    EXEMPT: "岗位安排无需参与后续内容任务",
    PARTICIPATING: "确认员工正常参与后续内容任务",
    PAUSED: "员工临时请假或暂不参与",
    PENDING_REVIEW: "等待企业确认员工是否参与内容任务",
  }[status];
}

function participationImpact(status: ParticipationStatus): string {
  return {
    EXEMPT: "员工不会进入以后创建的活动，适用于管理岗位或长期无需参与的人员。",
    PARTICIPATING: "员工启用后可以进入以后创建的活动受众。",
    PAUSED: "员工在恢复时间前不会进入新活动，到期后系统自动恢复。",
    PENDING_REVIEW: "员工暂不进入新活动，等待企业或集团管理员确认。",
  }[status];
}

function toDateTimeLocal(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function Metric({
  detail,
  label,
  tone,
  value,
}: Readonly<{ detail: string; label: string; tone?: string; value: number }>) {
  return (
    <article className={`metricCard ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
function maskPhone(value: string): string {
  return value.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}
function EmployeesLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          员工管理
        </span>
        <h1 suppressHydrationWarning>正在读取员工与任务资格…</h1>
      </section>
    </main>
  );
}
