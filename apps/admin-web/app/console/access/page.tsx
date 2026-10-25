"use client";

import type { components } from "@xhs-agentic/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionConfirmDialog,
  type ConfirmDialogState,
} from "../../components/action-confirm-dialog";
import { ActionIcon } from "../../components/action-icon";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import { FeedbackMessage, useFeedbackToast } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import {
  adminEnterpriseContexts,
  apiRequest,
  consoleNavigationPermissions,
  hasApiErrorCode,
  selectedAdminRoleName,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type AdminUser = components["schemas"]["AdminUserDto"] & { username?: string | null };
type AdminScope = components["schemas"]["AdminUserScopeDto"];
type Role = components["schemas"]["RoleResponseDto"];
type TargetScope = "TENANT" | "ENTERPRISE";

type UserForm = {
  department: string;
  email: string;
  enterpriseId: string;
  jobTitle: string;
  name: string;
  username: string;
  password: string;
  roleCodes: string[];
  scopeType: TargetScope;
};

type RevokeTarget = Readonly<{
  bindingId: string;
  roleName: string;
  scope: AdminScope;
  user: AdminUser;
}>;

const emptyForm: UserForm = {
  department: "",
  email: "",
  enterpriseId: "",
  jobTitle: "",
  name: "",
  username: "",
  password: "",
  roleCodes: [],
  scopeType: "ENTERPRISE",
};

export default function AccessPage() {
  const auth = useMvpSession();
  const feedback = useFeedbackToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [scopeFilter, setScopeFilter] = useState<"ALL" | TargetScope>("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [drawer, setDrawer] = useState<"ADD" | "EDIT" | null>(null);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [selectedScopeKey, setSelectedScopeKey] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const enterpriseOptions = useMemo(
    () =>
      auth.session
        ? adminEnterpriseContexts(auth.session).filter(
            ({ tenantId }) => tenantId === auth.session?.tenantId,
          )
        : [],
    [auth.session],
  );
  const canManageTenant = Boolean(
    auth.session?.adminAccess.scopes.some(
      (scope) =>
        scope.scopeType === "TENANT" &&
        scope.tenant?.id === auth.session?.tenantId &&
        scope.permissions.includes("tenant.role.manage"),
    ),
  );

  useEffect(() => {
    if (!auth.session) return;
    setForm((current) => ({
      ...current,
      enterpriseId: current.enterpriseId || auth.session?.enterpriseId || "",
      scopeType: canManageTenant ? "TENANT" : "ENTERPRISE",
    }));
  }, [auth.session, canManageTenant]);

  const load = useCallback(async () => {
    if (!auth.session) return;
    setError(null);
    try {
      const path = canManageTenant
        ? `/console/tenants/${auth.session.tenantId}/admin-users`
        : `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/admin-users`;
      setUsers(await apiRequest<AdminUser[]>(path, { token: auth.session.adminToken }));
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session, canManageTenant]);

  const loadRoles = useCallback(async () => {
    if (!auth.session || (form.scopeType === "ENTERPRISE" && !form.enterpriseId)) return;
    try {
      const tenantBase = `/console/tenants/${auth.session.tenantId}`;
      const path =
        form.scopeType === "TENANT"
          ? `${tenantBase}/roles`
          : `${tenantBase}/enterprises/${form.enterpriseId}/roles`;
      const rows = await apiRequest<Role[]>(path, { token: auth.session.adminToken });
      setRoles(rows);
      setForm((current) => ({
        ...current,
        roleCodes: current.roleCodes.filter((code) => rows.some((role) => role.code === code)),
      }));
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session, form.enterpriseId, form.scopeType]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (drawer === "ADD") void loadRoles();
  }, [drawer, loadRoles]);

  const roleOptions = useMemo(() => {
    const catalog = new Map<string, string>();
    for (const user of users) {
      for (const scope of user.scopes) {
        for (const role of scope.roles) catalog.set(role.code, role.name);
      }
    }
    return [...catalog.entries()].sort((left, right) => left[1].localeCompare(right[1], "zh-CN"));
  }, [users]);

  const filteredUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return users.filter((user) => {
      const matchesQuery =
        !normalizedQuery ||
        [user.name, user.username, user.phone, user.email]
          .filter(Boolean)
          .some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
      const matchesStatus = statusFilter === "ALL" || user.status === statusFilter;
      const matchesScope =
        scopeFilter === "ALL" || user.scopes.some(({ scopeType }) => scopeType === scopeFilter);
      const matchesRole =
        roleFilter === "ALL" ||
        user.scopes.some(({ roles: userRoles }) =>
          userRoles.some(({ code }) => code === roleFilter),
        );
      return matchesQuery && matchesStatus && matchesScope && matchesRole;
    });
  }, [query, roleFilter, scopeFilter, statusFilter, users]);

  function openAdd() {
    setSelectedUser(null);
    setRoles([]);
    setForm({
      ...emptyForm,
      enterpriseId: auth.session?.enterpriseId ?? "",
      scopeType: canManageTenant ? "TENANT" : "ENTERPRISE",
    });
    setDrawer("ADD");
  }

  function openEdit(user: AdminUser) {
    const scope = user.scopes[0];
    if (!scope) return;
    setSelectedUser(user);
    setSelectedScopeKey(scopeKey(scope));
    setForm({
      department: scope.department ?? "",
      email: user.email ?? "",
      enterpriseId: scope.enterprise?.id ?? "",
      jobTitle: scope.jobTitle ?? "",
      name: user.name ?? "",
      username: user.username ?? user.phone ?? "",
      password: "",
      roleCodes: scope.roles.map(({ code }) => code),
      scopeType: scope.scopeType === "TENANT" ? "TENANT" : "ENTERPRISE",
    });
    setDrawer("EDIT");
  }

  function selectEditScope(scope: AdminScope) {
    if (!selectedUser) return;
    setSelectedScopeKey(scopeKey(scope));
    setForm((current) => ({
      ...current,
      department: scope.department ?? "",
      enterpriseId: scope.enterprise?.id ?? "",
      jobTitle: scope.jobTitle ?? "",
      roleCodes: scope.roles.map(({ code }) => code),
      scopeType: scope.scopeType === "TENANT" ? "TENANT" : "ENTERPRISE",
    }));
  }

  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!auth.session || form.roleCodes.length === 0) return;
    setBusy("ADD");
    setError(null);
    setNotice(null);
    try {
      const path = canManageTenant
        ? `/console/tenants/${auth.session.tenantId}/admin-users`
        : `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/admin-users`;
      await apiRequest(path, {
        body: {
          department: form.department || undefined,
          email: form.email || undefined,
          enterpriseId: form.scopeType === "ENTERPRISE" ? form.enterpriseId : undefined,
          jobTitle: form.jobTitle || undefined,
          name: form.name,
          username: form.username,
          password: form.password || undefined,
          roleCodes: form.roleCodes,
          scopeType: form.scopeType,
        },
        method: "POST",
        token: auth.session.adminToken,
      });
      setDrawer(null);
      setNotice(`${form.name} 已加入后台用户，可使用账号密码登录`);
      await load();
    } catch (reason) {
      setError(messageOf(reason));
      if (hasApiErrorCode(reason, "ADMIN_EMAIL_ALREADY_EXISTS")) {
        const input = formElement.querySelector<HTMLInputElement>('input[type="email"]');
        feedback.markFieldError(input, messageOf(reason));
        input?.focus();
      }
    } finally {
      setBusy(null);
    }
  }

  async function updateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!auth.session || !selectedUser) return;
    setBusy("EDIT");
    setError(null);
    setNotice(null);
    try {
      const path = canManageTenant
        ? `/console/tenants/${auth.session.tenantId}/admin-users/${selectedUser.id}?scopeType=${form.scopeType}${form.scopeType === "ENTERPRISE" ? `&enterpriseId=${encodeURIComponent(form.enterpriseId)}` : ""}`
        : `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/admin-users/${selectedUser.id}`;
      await apiRequest(path, {
        body: {
          department: form.department || undefined,
          email: form.email || undefined,
          jobTitle: form.jobTitle || undefined,
          name: form.name,
        },
        method: "PATCH",
        token: auth.session.adminToken,
      });
      setDrawer(null);
      setNotice("后台用户资料已更新");
      await load();
    } catch (reason) {
      setError(messageOf(reason));
      if (hasApiErrorCode(reason, "ADMIN_EMAIL_ALREADY_EXISTS")) {
        const input = formElement.querySelector<HTMLInputElement>('input[type="email"]');
        feedback.markFieldError(input, messageOf(reason));
        input?.focus();
      }
    } finally {
      setBusy(null);
    }
  }

  async function revokeRole(reason: string) {
    if (!auth.session || !revokeTarget) return;
    if (revokeTarget.user.id === auth.session.adminAccess.userId) {
      setRevokeTarget(null);
      feedback.notify({ tone: "error", content: "当前登录账号不能移除自己的角色" });
      return;
    }
    setBusy("REVOKE");
    setError(null);
    setNotice(null);
    try {
      const { scope } = revokeTarget;
      const path = canManageTenant
        ? `/console/tenants/${auth.session.tenantId}/role-bindings/${revokeTarget.bindingId}`
        : `/console/tenants/${auth.session.tenantId}/enterprises/${auth.session.enterpriseId}/role-bindings/${revokeTarget.bindingId}`;
      await apiRequest(path, {
        body: { reason },
        method: "DELETE",
        token: auth.session.adminToken,
      });
      setRevokeTarget(null);
      setDrawer(null);
      setNotice(`${revokeTarget.roleName}权限已从${scopeLabel(scope)}移除`);
      await load();
    } catch (reasonValue) {
      setError(messageOf(reasonValue));
    } finally {
      setBusy(null);
    }
  }

  if (auth.session === undefined) return <AccessLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  const selectedScope = selectedUser?.scopes.find((scope) => scopeKey(scope) === selectedScopeKey);
  const selectedUserIsSelf = selectedUser?.id === auth.session.adminAccess.userId;
  const confirmation: ConfirmDialogState | null = revokeTarget
    ? {
        confirmLabel: "确认移除角色",
        impacts: [
          `将移除“${revokeTarget.roleName}”`,
          `影响范围：${scopeLabel(revokeTarget.scope)}`,
          "该用户的其他组织身份和员工资料不会受到影响",
        ],
        reasonLabel: "移除原因",
        summary: "角色移除后，对应后台权限会立即失效。",
        title: `移除${revokeTarget.user.name ?? revokeTarget.user.phone}的角色`,
        tone: "danger",
      }
    : null;

  return (
    <SaasShell
      active="access"
      description="添加和管理集团、企业、人资、运营及审核人员；后台账号与员工发布身份独立管理。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="后台用户"
      toolbar={
        <button className="primaryButton createButton" onClick={openAdd} type="button">
          添加后台用户
        </button>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}

      <section className="metricGrid four">
        <Metric detail="可登录管理后台的独立账号" label="后台用户" value={users.length} />
        <Metric
          detail="账号状态正常"
          label="正常使用"
          tone="accent"
          value={users.filter(({ status }) => status === "ACTIVE").length}
        />
        <Metric
          detail="已添加但尚未登录"
          label="待首次登录"
          value={users.filter(({ lastLoginAt }) => !lastLoginAt).length}
        />
        <Metric
          detail="集团或企业管理身份"
          label="组织身份"
          value={users.reduce((sum, user) => sum + user.scopes.length, 0)}
        />
      </section>

      <section className="workspaceActionBar adminUserActionBar">
        <div className="workspaceFilters adminUserFilters">
          <input
            aria-label="搜索后台用户"
            placeholder="搜索姓名、手机号或邮箱"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <option value="ALL">全部角色</option>
            {roleOptions.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          {canManageTenant ? (
            <select
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as "ALL" | TargetScope)}
            >
              <option value="ALL">全部管理范围</option>
              <option value="TENANT">集团范围</option>
              <option value="ENTERPRISE">企业范围</option>
            </select>
          ) : null}
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="ALL">全部状态</option>
            <option value="ACTIVE">正常</option>
            <option value="DISABLED">已停用</option>
          </select>
        </div>
        <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
          刷新
        </button>
      </section>

      <section className="panel adminUserPanel">
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">BACKOFFICE USERS</span>
            <h2>{canManageTenant ? "集团后台用户" : "企业后台用户"}</h2>
            <p>此处为仅为企业管理成员账号，不参与小程序任务发布。</p>
          </div>
          <span className="adminUserResultCount">显示 {filteredUsers.length} 人</span>
        </div>
        <div className="adminUserTable">
          <div className="adminUserTableHead">
            <span>人员</span>
            <span>管理范围</span>
            <span>角色</span>
            <span>状态</span>
            <span>最近登录</span>
            <span>操作</span>
          </div>
          {filteredUsers.map((user) => (
            <div className="adminUserTableRow" key={user.id}>
              <div className="adminUserIdentity">
                <b>{initialOf(user.name, user.phone)}</b>
                <span>
                  <strong>{user.name ?? "未填写姓名"}</strong>
                  <small>{user.username ?? user.phone ?? "未设置账号"}</small>
                  {user.email ? <small>{user.email}</small> : null}
                </span>
              </div>
              <div className="adminUserScopeList">
                {user.scopes.map((scope) => (
                  <span className="scopePill" key={scopeKey(scope)}>
                    {scopeLabel(scope)}
                  </span>
                ))}
              </div>
              <div className="adminUserRoleList">
                {user.scopes.flatMap((scope) =>
                  scope.roles.map((role) => (
                    <span className="rolePill" key={role.bindingId}>
                      {role.name}
                    </span>
                  )),
                )}
              </div>
              <StatusBadge tone={user.status === "ACTIVE" ? "success" : "danger"}>
                {user.status === "ACTIVE" ? "正常" : "已停用"}
              </StatusBadge>
              <span className="adminUserLoginTime">
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "尚未登录"}
              </span>
              <button className="ghostButton" onClick={() => openEdit(user)} type="button">
                管理
              </button>
            </div>
          ))}
          {filteredUsers.length === 0 ? (
            <div className="adminUserEmpty">
              <ActionIcon name="users" />
              <strong>没有符合条件的后台用户</strong>
              <p>调整筛选条件，或者添加新的后台管理人员。</p>
            </div>
          ) : null}
        </div>
      </section>

      <WorkspaceDrawer
        description="后台账号用于管理系统，不会自动加入员工名单或接收发布任务。"
        onClose={() => setDrawer(null)}
        open={drawer === "ADD"}
        title="添加后台用户"
      >
        <form className="drawerForm" onSubmit={(event) => void addUser(event)}>
          <section className="drawerSection">
            <h3>基本信息</h3>
            <p>新账号请设置初始密码；为已有账号增加角色时留空密码，不会更改原密码。</p>
            <div className="fieldGrid">
              <label className="field">
                <span>姓名</span>
                <input
                  maxLength={100}
                  required
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <label className="field">
                <span>登录账号</span>
                <input
                  autoComplete="off"
                  minLength={3}
                  maxLength={64}
                  required
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                />
              </label>
              <label className="field">
                <span>初始密码（仅新账号填写）</span>
                <input
                  autoComplete="new-password"
                  type="password"
                  minLength={12}
                  maxLength={128}
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  disabled={busy === "ADD"}
                />
                <small>12–128 位，含字母和数字；请通过安全方式告知本人。</small>
              </label>
              <label className="field">
                <span>邮箱（选填）</span>
                <input
                  maxLength={254}
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </label>
              <label className="field">
                <span>职位（选填）</span>
                <input
                  maxLength={100}
                  value={form.jobTitle}
                  onChange={(event) => setForm({ ...form, jobTitle: event.target.value })}
                />
              </label>
              <label className="field">
                <span>部门（选填）</span>
                <input
                  maxLength={100}
                  value={form.department}
                  onChange={(event) => setForm({ ...form, department: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="drawerSection">
            <h3>管理范围</h3>
            <p>
              {canManageTenant
                ? "集团主管理员可以把人员安排到集团或任意旗下企业；主管理员本身唯一，不在此处重复授权。"
                : "企业管理员只能添加本企业的运营、人资、审核和数据角色，不能新增同级企业管理员。"}
            </p>
            <div className="fieldGrid">
              {canManageTenant ? (
                <label className="field">
                  <span>授权层级</span>
                  <select
                    value={form.scopeType}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        roleCodes: [],
                        scopeType: event.target.value as TargetScope,
                      })
                    }
                  >
                    <option value="TENANT">当前集团</option>
                    <option value="ENTERPRISE">旗下企业</option>
                  </select>
                </label>
              ) : null}
              {form.scopeType === "ENTERPRISE" ? (
                <label className="field">
                  <span>目标企业</span>
                  <select
                    required
                    value={form.enterpriseId}
                    onChange={(event) =>
                      setForm({ ...form, enterpriseId: event.target.value, roleCodes: [] })
                    }
                  >
                    {enterpriseOptions.map((enterprise) => (
                      <option key={enterprise.enterpriseId} value={enterprise.enterpriseId}>
                        {enterprise.enterpriseName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </section>

          <section className="drawerSection">
            <h3>选择角色</h3>
            <p>可以选择多个职能职责；多个角色权限取并集，但职能角色之间不会自动继承。</p>
            <div className="adminRolePicker">
              {roles.map((role) => {
                const checked = form.roleCodes.includes(role.code);
                return (
                  <label className={checked ? "selected" : ""} key={role.id}>
                    <input
                      checked={checked}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          roleCodes: event.target.checked
                            ? [...form.roleCodes, role.code]
                            : form.roleCodes.filter((code) => code !== role.code),
                        })
                      }
                      type="checkbox"
                    />
                    <span>
                      <strong>{role.name}</strong>
                      <small>{role.description}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
          <button
            className="primaryButton block drawerSubmit"
            disabled={busy === "ADD" || form.roleCodes.length === 0}
            type="submit"
          >
            <ActionIcon name="plus" />
            {busy === "ADD" ? "正在添加…" : "添加后台用户"}
          </button>
        </form>
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="修改后台资料或移除当前组织中的管理角色，不会影响企业员工档案。"
        onClose={() => setDrawer(null)}
        open={drawer === "EDIT" && Boolean(selectedUser)}
        title={selectedUser?.name ?? "后台用户详情"}
      >
        {selectedUser && selectedScope ? (
          <form className="drawerForm" onSubmit={(event) => void updateUser(event)}>
            {selectedUser.scopes.length > 1 ? (
              <section className="drawerSection">
                <h3>选择管理身份</h3>
                <div className="adminScopePicker">
                  {selectedUser.scopes.map((scope) => (
                    <button
                      className={scopeKey(scope) === selectedScopeKey ? "active" : ""}
                      key={scopeKey(scope)}
                      onClick={() => selectEditScope(scope)}
                      type="button"
                    >
                      {scopeLabel(scope)}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="drawerSection">
              <h3>账号资料</h3>
              <div className="fieldGrid">
                <label className="field">
                  <span>姓名</span>
                  <input
                    required
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>登录账号</span>
                  <input disabled value={form.username} />
                </label>
                <label className="field">
                  <span>邮箱</span>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(event) => setForm({ ...form, email: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>职位</span>
                  <input
                    value={form.jobTitle}
                    onChange={(event) => setForm({ ...form, jobTitle: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>部门</span>
                  <input
                    value={form.department}
                    onChange={(event) => setForm({ ...form, department: event.target.value })}
                  />
                </label>
              </div>
              <button
                className="primaryButton block drawerSubmit"
                disabled={busy === "EDIT"}
                type="submit"
              >
                <ActionIcon name="check" />
                {busy === "EDIT" ? "正在保存…" : "保存资料"}
              </button>
            </section>
            <section className="drawerSection">
              <h3>当前角色</h3>
              <p>{scopeLabel(selectedScope)}中的后台职责。</p>
              <div className="adminAssignedRoles">
                {selectedScope.roles.map((role) => (
                  <article key={role.bindingId}>
                    <div>
                      <strong>{role.name}</strong>
                      <small>{role.description}</small>
                    </div>
                    {selectedUserIsSelf ? (
                      <span className="adminSelfRoleGuard" title="当前登录账号不能移除自己的角色">
                        <ActionIcon name="check" />
                        <span>
                          <strong>当前账号</strong>
                          <small>不能移除自己的角色</small>
                        </span>
                      </span>
                    ) : (
                      <button
                        className="dangerButton"
                        onClick={() =>
                          setRevokeTarget({
                            bindingId: role.bindingId,
                            roleName: role.name,
                            scope: selectedScope,
                            user: selectedUser,
                          })
                        }
                        type="button"
                      >
                        <ActionIcon name="x" />
                        移除角色
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section className="drawerSection adminAccountFacts">
              <h3>账号状态</h3>
              <dl>
                <div>
                  <dt>状态</dt>
                  <dd>{selectedUser.status === "ACTIVE" ? "正常" : "已停用"}</dd>
                </div>
                <div>
                  <dt>最近登录</dt>
                  <dd>
                    {selectedUser.lastLoginAt
                      ? formatDateTime(selectedUser.lastLoginAt)
                      : "尚未首次登录"}
                  </dd>
                </div>
                <div>
                  <dt>活跃会话</dt>
                  <dd>{selectedUser.activeSessionCount} 个</dd>
                </div>
              </dl>
            </section>
          </form>
        ) : null}
      </WorkspaceDrawer>

      <ActionConfirmDialog
        busy={busy === "REVOKE"}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={(reason) => void revokeRole(reason)}
        state={confirmation}
      />
    </SaasShell>
  );
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

function scopeKey(scope: AdminScope): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

function scopeLabel(scope: AdminScope): string {
  if (scope.scopeType === "TENANT") return scope.tenant?.name ?? "集团范围";
  if (scope.scopeType === "ENTERPRISE") return scope.enterprise?.name ?? "企业范围";
  return "系统";
}

function initialOf(name: string | null, phone: string | null): string {
  return (name?.trim().slice(0, 1) || phone?.slice(-2) || "我").toUpperCase();
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function AccessLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          BACKOFFICE USERS
        </span>
        <h1 suppressHydrationWarning>正在读取后台用户…</h1>
      </section>
    </main>
  );
}
