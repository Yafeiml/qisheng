"use client";

import type { components } from "@xhs-agentic/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ActionConfirmDialog } from "../../components/action-confirm-dialog";
import { ConsoleScopeSwitcher } from "../../components/console-scope-switcher";
import {
  type IndustryOption,
  IndustrySelect,
  ProvinceCitySelect,
} from "../../components/enterprise-profile-selects";
import { FeedbackMessage } from "../../components/feedback-toast";
import { MvpSetup } from "../../components/mvp-setup";
import { SaasShell, StatusBadge } from "../../components/saas-shell";
import { WorkspaceDrawer } from "../../components/workspace-drawer";
import { WorkspaceTabs } from "../../components/workspace-tabs";
import {
  apiRequest,
  consoleNavigationPermissions,
  selectAdminEnterprise,
  selectedAdminRoleName,
  synchronizeAdminAccess,
} from "../../lib/mvp-client";
import { messageOf, useMvpSession } from "../../lib/use-mvp-session";

type Enterprise = components["schemas"]["EnterpriseOverviewDto"];
type EnterpriseDrawer = "CREATE" | "EDIT";
type EnterpriseFilter = "ALL" | "BLOCKED" | "DISABLED" | "READY";
type EnterpriseWorkspace = "DIRECTORY" | "READINESS" | "SHARED";

type GroupOverview = Readonly<{
  enterprises: readonly Readonly<{
    blockers: readonly string[];
    campaignReady: boolean;
    campaigns: Readonly<Record<string, number>>;
    code: string;
    effectiveMaterials: number;
    enabledSeats: number;
    generation: Readonly<{
      failed: number;
      running: number;
      succeeded: number;
      successRate: number | null;
    }>;
    id: string;
    name: string;
  }>[];
  sharedMaterials: Readonly<{
    effectiveCount: number;
    expiring: readonly Readonly<{
      expiresAt: string;
      id: string;
      title: string;
      version: number;
    }>[];
    usage: readonly Readonly<{
      enterpriseId: string;
      hitCount: number;
      lastHitAt: string | null;
      materialId: string;
      materialTitle: string;
      materialVersion: number;
    }>[];
  }>;
  summary: Readonly<{
    activeEnterprises: number;
    blockedEnterprises: number;
    campaignReadyEnterprises: number;
    enabledSeats: number;
    totalCampaigns: number;
    totalEnterprises: number;
  }>;
}>;

const emptyCreate = {
  brandName: "",
  city: "",
  industry: "",
  name: "",
};

export default function EnterprisesPage() {
  const auth = useMvpSession();
  const [enterprises, setEnterprises] = useState<Enterprise[]>([]);
  const [industries, setIndustries] = useState<IndustryOption[]>([]);
  const [industriesLoading, setIndustriesLoading] = useState(false);
  const [groupOverview, setGroupOverview] = useState<GroupOverview | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [profile, setProfile] = useState({
    brandName: "",
    city: "",
    industry: "",
    name: "",
  });
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [activeWorkspace, setActiveWorkspace] = useState<EnterpriseWorkspace>("DIRECTORY");
  const [drawerMode, setDrawerMode] = useState<EnterpriseDrawer | null>(null);
  const [enterpriseFilter, setEnterpriseFilter] = useState<EnterpriseFilter>("ALL");
  const [pendingDisable, setPendingDisable] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tenantScope = auth.session?.adminAccess.scopes.find(
    (scope) =>
      scope.scopeType === "TENANT" &&
      scope.tenant?.id === auth.session?.tenantId &&
      scope.permissions.includes("tenant.enterprise.read"),
  );
  const canManageGroup = tenantScope?.permissions.includes("tenant.enterprise.manage") ?? false;
  const canReadGroupOverview = tenantScope?.permissions.includes("tenant.dashboard.read") ?? false;

  const load = useCallback(async () => {
    const session = auth.session;
    if (!session) return;
    setError(null);
    try {
      const [rows, overview] = await Promise.all([
        tenantScope
          ? apiRequest<Enterprise[]>(`/console/tenants/${session.tenantId}/enterprises`, {
              token: session.adminToken,
            })
          : apiRequest<Enterprise>(
              `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}`,
              { token: session.adminToken },
            ).then((enterprise) => [enterprise]),
        canReadGroupOverview
          ? apiRequest<GroupOverview>(`/console/tenants/${session.tenantId}/group-overview`, {
              token: session.adminToken,
            })
          : Promise.resolve(null),
      ]);
      setEnterprises(rows);
      setGroupOverview(overview);
      setSelectedId((current) =>
        rows.some(({ id }) => id === current)
          ? current
          : (rows.find(({ id }) => id === session.enterpriseId)?.id ?? rows[0]?.id ?? ""),
      );
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [auth.session, canReadGroupOverview, tenantScope]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadIndustries = useCallback(async () => {
    const session = auth.session;
    if (!session) return;
    setIndustriesLoading(true);
    try {
      const path = tenantScope
        ? `/console/tenants/${session.tenantId}/industries`
        : `/console/tenants/${session.tenantId}/enterprises/${session.enterpriseId}/industries`;
      setIndustries(
        await apiRequest<IndustryOption[]>(path, {
          token: session.adminToken,
        }),
      );
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setIndustriesLoading(false);
    }
  }, [auth.session, tenantScope]);

  useEffect(() => {
    void loadIndustries();
  }, [loadIndustries]);

  const selected = useMemo(
    () => enterprises.find(({ id }) => id === selectedId),
    [enterprises, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    setProfile({
      brandName: selected.brandName ?? "",
      city: selected.city ?? "",
      industry: selected.industry ?? "",
      name: selected.name,
    });
  }, [selected]);

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.session || !selected) return;
    await execute(async () => {
      await apiRequest(
        `/console/tenants/${auth.session?.tenantId}/enterprises/${selected.id}/profile`,
        {
          body: profile,
          method: "POST",
          token: auth.session?.adminToken,
        },
      );
      setNotice("企业资料已更新");
      setDrawerMode(null);
      await load();
    });
  }

  async function createEnterprise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const session = auth.session;
    if (!session || !canManageGroup) return;
    await execute(async () => {
      const enterprise = await apiRequest<Enterprise>(
        `/console/tenants/${session.tenantId}/enterprises`,
        {
          body: createForm,
          method: "POST",
          token: session.adminToken,
        },
      );
      const synchronized = await synchronizeAdminAccess(session);
      auth.setSession(selectAdminEnterprise(synchronized, enterprise.id));
      setCreateForm(emptyCreate);
      setSelectedId(enterprise.id);
      setNotice("企业已创建，当前作用域已切换。请在“后台用户”中新增密码管理员并分配角色。");
      setDrawerMode(null);
      await load();
    });
  }

  async function changeStatus(reason: string) {
    if (!auth.session || !selected || !canManageGroup) return;
    const nextStatus = selected.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    await execute(async () => {
      await apiRequest(
        `/console/tenants/${auth.session?.tenantId}/enterprises/${selected.id}/status`,
        {
          body: { reason, status: nextStatus },
          method: "POST",
          token: auth.session?.adminToken,
        },
      );
      setNotice(
        nextStatus === "ACTIVE"
          ? "企业已恢复运营并重新校验租户企业数量安全上限"
          : "企业已停用；历史活动和数据仍被保留",
      );
      setPendingDisable(false);
      await load();
    });
  }

  async function execute(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  if (auth.session === undefined) return <EnterprisesLoading />;
  if (auth.session === null) {
    return <MvpSetup busy={auth.busy} error={auth.error} initialize={auth.initialize} />;
  }

  const activeCount = enterprises.filter(({ status }) => status === "ACTIVE").length;
  const enabledSeats = enterprises.reduce(
    (sum, enterprise) => sum + (enterprise.seats.ENABLED ?? 0),
    0,
  );
  const campaignCount = enterprises.reduce(
    (sum, enterprise) =>
      sum + Object.values(enterprise.campaigns).reduce((subtotal, count) => subtotal + count, 0),
    0,
  );
  const readyIds = new Set(
    groupOverview?.enterprises.filter(({ campaignReady }) => campaignReady).map(({ id }) => id) ??
      enterprises.filter(({ status }) => status === "ACTIVE").map(({ id }) => id),
  );
  const blockedIds = new Set(
    groupOverview?.enterprises.filter(({ campaignReady }) => !campaignReady).map(({ id }) => id) ??
      [],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filteredEnterprises = enterprises.filter((enterprise) => {
    const matchesFilter =
      enterpriseFilter === "ALL" ||
      (enterpriseFilter === "READY" && readyIds.has(enterprise.id)) ||
      (enterpriseFilter === "BLOCKED" && blockedIds.has(enterprise.id)) ||
      (enterpriseFilter === "DISABLED" && enterprise.status === "DISABLED");
    const matchesSearch =
      !normalizedSearch ||
      [
        enterprise.name,
        enterprise.code,
        enterprise.brandName ?? "",
        enterprise.city ?? "",
        enterprise.industry ?? "",
      ].some((value) => value.toLowerCase().includes(normalizedSearch));
    return matchesFilter && matchesSearch;
  });

  return (
    <SaasShell
      active="enterprises"
      description="管理集团旗下企业资料、运营状态和平台配置的企业数量安全边界；企业管理员只能维护本企业资料。"
      mode="console"
      navigationPermissions={consoleNavigationPermissions(auth.session)}
      roleLabel={selectedAdminRoleName(auth.session)}
      scopeControl={<ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />}
      scopeName={`${auth.session.tenantName} · ${auth.session.enterpriseName}`}
      title="企业管理"
      toolbar={
        <div className="workspaceActionButtons">
          <button className="ghostButton refreshButton" onClick={() => void load()} type="button">
            刷新企业
          </button>
          {canManageGroup ? (
            <button
              className="primaryButton createButton"
              onClick={() => setDrawerMode("CREATE")}
              type="button"
            >
              创建企业
            </button>
          ) : null}
        </div>
      }
    >
      {error ? <FeedbackMessage tone="error">{error}</FeedbackMessage> : null}
      {notice ? <FeedbackMessage tone="success">{notice}</FeedbackMessage> : null}
      <section className="metricGrid four">
        <Metric
          detail="当前账号授权范围"
          label="企业总数"
          value={groupOverview?.summary.totalEnterprises ?? enterprises.length}
        />
        <Metric
          detail={
            groupOverview
              ? `${groupOverview.summary.blockedEnterprises} 家尚未就绪`
              : "可创建活动的企业"
          }
          label="活动就绪"
          value={groupOverview?.summary.campaignReadyEnterprises ?? activeCount}
        />
        <Metric
          detail="按企业统计可参与任务的员工"
          label="已启用员工"
          value={groupOverview?.summary.enabledSeats ?? enabledSeats}
        />
        <Metric detail="保留全部历史活动" label="活动总数" value={campaignCount} />
      </section>

      <section className="workspaceActionBar">
        <WorkspaceTabs
          active={activeWorkspace}
          ariaLabel="企业管理工作视图"
          onChange={setActiveWorkspace}
          tabs={
            groupOverview
              ? [
                  { count: enterprises.length, key: "DIRECTORY", label: "企业目录" },
                  {
                    count: groupOverview.summary.blockedEnterprises,
                    key: "READINESS",
                    label: "运营准备度",
                  },
                  {
                    count: groupOverview.sharedMaterials.effectiveCount,
                    key: "SHARED",
                    label: "集团共享资料",
                  },
                ]
              : [{ count: enterprises.length, key: "DIRECTORY", label: "企业目录" }]
          }
        />
      </section>

      {groupOverview ? (
        <section className="enterpriseWorkspaceArea">
          <article className="panel" hidden={activeWorkspace !== "READINESS"}>
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">运营准备度</span>
                <h2>跨企业运营准备度</h2>
                <p>从员工任务资格和有效素材判断每家企业是否可创建活动。</p>
              </div>
            </div>
            <div className="groupReadinessList">
              {groupOverview.enterprises.map((enterprise) => (
                <div className="groupReadinessRow" key={enterprise.id}>
                  <div>
                    <strong>{enterprise.name}</strong>
                    <small>
                      {enterprise.code} · 已启用员工 {enterprise.enabledSeats} · 有效素材{" "}
                      {enterprise.effectiveMaterials}
                    </small>
                  </div>
                  <div>
                    <StatusBadge tone={enterprise.campaignReady ? "success" : "warning"}>
                      {enterprise.campaignReady ? "可创建活动" : "待补齐"}
                    </StatusBadge>
                    <small>{blockerLabel(enterprise.blockers)}</small>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="panel" hidden={activeWorkspace !== "SHARED"}>
            <div className="panelHeader">
              <div>
                <span className="sectionKicker">集团共享资料</span>
                <h2>集团公共素材效能</h2>
                <p>展示当前可用素材、30 天内到期提醒，以及被企业活动命中的真实次数。</p>
              </div>
              <StatusBadge tone="neutral">
                {groupOverview.sharedMaterials.effectiveCount} 份有效
              </StatusBadge>
            </div>
            <div className="groupSharedSummary">
              <div>
                <span>30 天内到期</span>
                <strong>{groupOverview.sharedMaterials.expiring.length}</strong>
              </div>
              <div>
                <span>活动引用次数</span>
                <strong>
                  {groupOverview.sharedMaterials.usage.reduce((sum, row) => sum + row.hitCount, 0)}
                </strong>
              </div>
            </div>
            <div className="groupSharedList">
              {groupOverview.sharedMaterials.usage.slice(0, 6).map((usage) => (
                <div key={`${usage.enterpriseId}:${usage.materialId}:${usage.materialVersion}`}>
                  <strong>{usage.materialTitle}</strong>
                  <small>
                    {enterpriseName(groupOverview, usage.enterpriseId)} · 命中 {usage.hitCount} 次 ·
                    第 {usage.materialVersion} 版
                  </small>
                </div>
              ))}
              {groupOverview.sharedMaterials.usage.length === 0 ? (
                <div className="emptyState compact">尚无集团公共素材命中记录</div>
              ) : null}
            </div>
          </article>
        </section>
      ) : null}

      <section className="panel enterpriseDirectoryPanel" hidden={activeWorkspace !== "DIRECTORY"}>
        <div className="panelHeader">
          <div>
            <span className="sectionKicker">企业目录</span>
            <h2>集团企业目录</h2>
            <p>查找企业并查看当前运营状态；编辑资料与创建企业按需打开。</p>
          </div>
          {selected ? (
            <button className="ghostButton" onClick={() => setDrawerMode("EDIT")} type="button">
              编辑选中企业
            </button>
          ) : null}
        </div>
        <div className="enterpriseDirectoryToolbar">
          <div className="workspaceFilters">
            <input
              aria-label="搜索企业"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索企业名称、代码、品牌、城市或行业"
              type="search"
              value={search}
            />
          </div>
          <WorkspaceTabs
            active={enterpriseFilter}
            ariaLabel="企业状态筛选"
            onChange={setEnterpriseFilter}
            tabs={[
              { count: enterprises.length, key: "ALL", label: "全部" },
              { count: readyIds.size, key: "READY", label: "可创建活动" },
              { count: blockedIds.size, key: "BLOCKED", label: "尚未就绪" },
              {
                count: enterprises.length - activeCount,
                key: "DISABLED",
                label: "已停用",
              },
            ]}
          />
        </div>
        <div className="enterpriseManagementList">
          {filteredEnterprises.map((enterprise) => (
            <button
              className={enterprise.id === selectedId ? "active" : ""}
              key={enterprise.id}
              onClick={() => setSelectedId(enterprise.id)}
              type="button"
            >
              <span>{enterprise.code.slice(0, 2)}</span>
              <div>
                <strong>{enterprise.name}</strong>
                <small>
                  {enterprise.city ?? "未设城市"} · {enterprise.industry ?? "未设行业"}
                </small>
              </div>
              <div>
                <StatusBadge tone={enterprise.status === "ACTIVE" ? "success" : "neutral"}>
                  {enterprise.status === "ACTIVE" ? "运营中" : "已停用"}
                </StatusBadge>
                <small>已启用员工 {enterprise.seats.ENABLED ?? 0}</small>
              </div>
            </button>
          ))}
          {filteredEnterprises.length === 0 ? (
            <div className="emptyState compact">
              <strong>没有符合条件的企业</strong>
              <p>请调整状态筛选或搜索内容。</p>
            </div>
          ) : null}
        </div>
      </section>

      <WorkspaceDrawer
        description="企业代码保持不变；名称、品牌、行业和城市的修改会进入审计记录。"
        onClose={() => setDrawerMode(null)}
        open={drawerMode === "EDIT"}
        title={selected ? `编辑 ${selected.name}` : "编辑企业"}
      >
        <form className="drawerForm" onSubmit={(event) => void updateProfile(event)}>
          <label className="field">
            <span>企业名称</span>
            <input
              disabled={!selected}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
              required
              value={profile.name}
            />
          </label>
          <label className="field">
            <span>品牌名称</span>
            <input
              disabled={!selected}
              onChange={(event) => setProfile({ ...profile, brandName: event.target.value })}
              value={profile.brandName}
            />
          </label>
          <div className="fieldGrid profileLocationFields">
            <label className="field" htmlFor="enterprise-profile-industry">
              <span>行业</span>
              <IndustrySelect
                disabled={!selected}
                id="enterprise-profile-industry"
                industries={industries}
                loading={industriesLoading}
                onChange={(industry) => setProfile({ ...profile, industry })}
                value={profile.industry}
              />
            </label>
            <ProvinceCitySelect
              city={profile.city}
              disabled={!selected}
              onCityChange={(city) => setProfile({ ...profile, city })}
              resetKey={selected?.id ?? "none"}
            />
          </div>
          <button className="primaryButton block" disabled={busy || !selected} type="submit">
            保存企业资料
          </button>
          {canManageGroup && selected ? (
            <div className="enterpriseStatusControl">
              <button
                className={
                  selected.status === "ACTIVE" ? "dangerButton block" : "ghostButton block"
                }
                disabled={busy}
                onClick={() =>
                  selected.status === "ACTIVE"
                    ? setPendingDisable(true)
                    : void changeStatus("恢复企业正常运营")
                }
                type="button"
              >
                {selected.status === "ACTIVE" ? "停用企业" : "恢复企业"}
              </button>
            </div>
          ) : null}
        </form>
      </WorkspaceDrawer>

      <WorkspaceDrawer
        description="创建企业后，在后台用户中新增账号密码并分配管理角色。"
        onClose={() => setDrawerMode(null)}
        open={drawerMode === "CREATE" && canManageGroup}
        title="创建集团企业"
      >
        <form className="drawerForm" onSubmit={(event) => void createEnterprise(event)}>
          <div className="fieldGrid">
            <label className="field">
              <span>企业名称</span>
              <input
                onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })}
                required
                value={createForm.name}
              />
            </label>
            <p className="formHint generatedEnterpriseCodeHint">
              企业代码由系统自动生成，创建后可在企业列表中查看。
            </p>
          </div>
          <label className="field">
            <span>品牌名称</span>
            <input
              onChange={(event) => setCreateForm({ ...createForm, brandName: event.target.value })}
              value={createForm.brandName}
            />
          </label>
          <div className="fieldGrid profileLocationFields">
            <label className="field" htmlFor="enterprise-create-industry">
              <span>行业</span>
              <IndustrySelect
                id="enterprise-create-industry"
                industries={industries}
                loading={industriesLoading}
                onChange={(industry) => setCreateForm({ ...createForm, industry })}
                value={createForm.industry}
              />
            </label>
            <ProvinceCitySelect
              city={createForm.city}
              onCityChange={(city) => setCreateForm({ ...createForm, city })}
              resetKey={drawerMode === "CREATE" ? "create-open" : "create-closed"}
            />
          </div>
          <p className="formHint">管理员账号统一在后台用户中手动创建，无需手机号注册。</p>
          <button className="primaryButton block" disabled={busy} type="submit">
            创建企业
          </button>
        </form>
      </WorkspaceDrawer>

      <ActionConfirmDialog
        busy={busy}
        onCancel={() => setPendingDisable(false)}
        onConfirm={(reason) => void changeStatus(reason)}
        state={
          pendingDisable && selected
            ? {
                confirmLabel: "确认停用企业",
                defaultReason: "集团组织调整，暂停该企业运营",
                impacts: [
                  "该企业将无法继续创建或推进新的营销活动。",
                  "历史活动、员工、资料和经营数据会继续保留。",
                  "员工启用与任务参与状态不会被改写，恢复企业后可继续使用。",
                ],
                reasonLabel: "停用原因",
                summary: `即将停用“${selected.name}”。`,
                title: "确认停用这家企业？",
                tone: "danger",
              }
            : null
        }
      />
    </SaasShell>
  );
}

function Metric({
  detail,
  label,
  value,
}: Readonly<{ detail: string; label: string; value: number }>) {
  return (
    <article className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function blockerLabel(blockers: readonly string[]): string {
  if (blockers.length === 0) return "所有前置条件已满足";
  const labels: Readonly<Record<string, string>> = {
    ENTERPRISE_DISABLED: "企业已停用",
    NO_EFFECTIVE_MATERIALS: "缺少有效素材",
    NO_ENABLED_SEATS: "缺少已启用员工",
    NO_PARTICIPATING_MEMBERS: "缺少可参与任务的员工",
  };
  return blockers.map((blocker) => labels[blocker] ?? blocker).join("、");
}

function enterpriseName(overview: GroupOverview, enterpriseId: string): string {
  return overview.enterprises.find(({ id }) => id === enterpriseId)?.name ?? "未知企业";
}

function EnterprisesLoading() {
  return (
    <main className="setupScreen">
      <section className="setupCard">
        <span className="appEyebrow" suppressHydrationWarning>
          企业管理
        </span>
        <h1 suppressHydrationWarning>正在读取集团企业…</h1>
      </section>
    </main>
  );
}
