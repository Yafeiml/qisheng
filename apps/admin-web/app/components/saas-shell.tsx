"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { adminWorkRole } from "../lib/business-language";
import {
  consoleNavigationPermissions,
  platformNavigationPermissions,
  selectedAdminRoleName,
} from "../lib/mvp-client";
import { useMvpSession } from "../lib/use-mvp-session";
import { ConsoleScopeSwitcher } from "./console-scope-switcher";
import { GenerationServiceNotice } from "./generation-service-notice";
import { PlatformLogo, PlatformName } from "./platform-branding";
import { SessionExitButton } from "./session-exit-button";

type ShellMode = "console" | "platform";

type NavigationIconName =
  | "analytics"
  | "badge-check"
  | "bell"
  | "briefcase"
  | "building"
  | "campaign"
  | "dashboard"
  | "database"
  | "factory"
  | "image"
  | "key"
  | "layers"
  | "list-checks"
  | "lock"
  | "map-pin"
  | "network"
  | "package"
  | "plus-circle"
  | "route"
  | "search"
  | "settings"
  | "shield"
  | "shield-check"
  | "sliders"
  | "sparkles"
  | "users";

type NavigationItem = Readonly<{
  href: string;
  icon: NavigationIconName;
  key: string;
  label: string;
  permissions?: readonly string[];
}>;

type NavigationGroup = Readonly<{
  collapsible?: boolean;
  icon: NavigationIconName;
  items: readonly NavigationItem[];
  key: string;
  label: string;
}>;

const consoleNavigation: readonly NavigationGroup[] = [
  {
    collapsible: false,
    icon: "dashboard",
    items: [{ href: "/console", icon: "dashboard", key: "overview", label: "运营工作台" }],
    key: "workspace",
    label: "工作台",
  },
  {
    icon: "campaign",
    items: [
      {
        href: "/console/campaigns",
        icon: "campaign",
        key: "campaigns",
        label: "营销活动",
        permissions: ["campaign.read"],
      },
      {
        href: "/console/campaigns/new",
        icon: "plus-circle",
        key: "campaign-new",
        label: "创建活动",
        permissions: ["campaign.manage"],
      },
      {
        href: "/console/publications",
        icon: "badge-check",
        key: "publications",
        label: "发布验真",
        permissions: ["campaign.read"],
      },
    ],
    key: "content-operations",
    label: "内容运营",
  },
  {
    icon: "layers",
    items: [
      {
        href: "/console/materials",
        icon: "image",
        key: "materials",
        label: "素材中心",
        permissions: ["material.read", "material.manage"],
      },
      {
        href: "/console/geo",
        icon: "map-pin",
        key: "geo",
        label: "内容覆盖",
        permissions: ["geo.read"],
      },
    ],
    key: "content-assets",
    label: "内容资产",
  },
  {
    icon: "briefcase",
    items: [
      {
        href: "/console/enterprises",
        icon: "building",
        key: "enterprises",
        label: "集团与企业",
        permissions: ["tenant.enterprise.read", "tenant.enterprise.manage"],
      },
      {
        href: "/console/employees",
        icon: "users",
        key: "employees",
        label: "员工与参与",
        permissions: ["enterprise.membership.read", "enterprise.membership.manage"],
      },
    ],
    key: "organization",
    label: "组织管理",
  },
  {
    icon: "analytics",
    items: [
      {
        href: "/console/analytics",
        icon: "analytics",
        key: "analytics",
        label: "数据分析",
        permissions: ["tenant.dashboard.read", "dashboard.read"],
      },
    ],
    key: "business",
    label: "经营管理",
  },
  {
    icon: "shield",
    items: [
      {
        href: "/console/access",
        icon: "users",
        key: "access",
        label: "后台用户",
        permissions: ["tenant.role.manage", "enterprise.role.manage"],
      },
      {
        href: "/console/audit",
        icon: "list-checks",
        key: "audit",
        label: "审计日志",
        permissions: ["audit.read"],
      },
    ],
    key: "governance",
    label: "系统治理",
  },
];

const platformNavigation: readonly NavigationGroup[] = [
  {
    collapsible: false,
    icon: "dashboard",
    items: [
      {
        href: "/platform",
        icon: "dashboard",
        key: "overview",
        label: "系统总览",
        permissions: ["platform.monitor.read"],
      },
    ],
    key: "platform-overview",
    label: "系统总览",
  },
  {
    icon: "briefcase",
    items: [
      {
        href: "/platform/industries",
        icon: "factory",
        key: "industries",
        label: "行业管理",
        permissions: ["platform.tenant.manage"],
      },
    ],
    key: "organization-management",
    label: "基础资料",
  },
  {
    icon: "sparkles",
    items: [
      {
        href: "/platform/operations",
        icon: "list-checks",
        key: "operations",
        label: "任务中心",
        permissions: ["platform.monitor.read"],
      },
      {
        href: "/platform/processing-issues",
        icon: "bell",
        key: "processing-issues",
        label: "处理异常",
        permissions: ["platform.monitor.read"],
      },
      {
        href: "/platform/gates",
        icon: "shield-check",
        key: "gates",
        label: "门禁状态",
        permissions: ["platform.monitor.read"],
      },
      {
        href: "/platform/readback",
        icon: "badge-check",
        key: "readback",
        label: "发布回读",
        permissions: ["platform.monitor.read"],
      },
      {
        href: "/platform/models",
        icon: "route",
        key: "models",
        label: "模型配置",
        permissions: ["platform.model.manage"],
      },
      {
        href: "/platform/generation-lab",
        icon: "sparkles",
        key: "generation-lab",
        label: "生成测试台",
        permissions: ["platform.model.manage"],
      },
    ],
    key: "runtime-and-ai",
    label: "运行与 AI",
  },
  {
    icon: "shield",
    items: [
      {
        href: "/platform/access",
        icon: "users",
        key: "access",
        label: "平台用户",
        permissions: ["platform.access.manage"],
      },
    ],
    key: "platform-governance",
    label: "平台治理",
  },
  {
    items: (
      [
        {
          href: "/setup",
          icon: "settings",
          key: "installation",
          label: "安装引导",
        },
        {
          href: "/platform/settings/general",
          icon: "sliders",
          key: "settings-general",
          label: "常用设置",
        },
        {
          href: "/platform/settings/generation",
          icon: "sparkles",
          key: "settings-generation",
          label: "生成设置",
        },
        {
          href: "/platform/settings/content-style",
          icon: "sparkles",
          key: "settings-content-style",
          label: "生成风格",
        },
        {
          href: "/platform/settings/retrieval",
          icon: "search",
          key: "settings-retrieval",
          label: "检索设置",
        },
        {
          href: "/platform/settings/worker",
          icon: "settings",
          key: "settings-worker",
          label: "Worker 设置",
        },
        {
          href: "/platform/settings/storage",
          icon: "database",
          key: "settings-storage",
          label: "存储设置",
        },
        {
          href: "/platform/settings/content-safety",
          icon: "shield-check",
          key: "settings-content-safety",
          label: "内容安全",
        },
        {
          href: "/platform/settings/security",
          icon: "lock",
          key: "settings-security",
          label: "安全设置",
        },
        {
          href: "/platform/settings/notification",
          icon: "bell",
          key: "settings-notification",
          label: "通知设置",
        },
        {
          href: "/platform/settings/miniapp",
          icon: "settings",
          key: "settings-miniapp",
          label: "小程序设置",
        },
      ] as const
    ).map((item) => ({ ...item, permissions: ["platform.settings.manage"] })),
    key: "platform-settings",
    label: "参数设置",
    icon: "settings",
  },
];

const roleNavigation: Record<
  ReturnType<typeof adminWorkRole>,
  Readonly<{ keys: readonly string[]; labels: Readonly<Record<string, string>> }>
> = {
  ADMIN: {
    keys: [
      "overview",
      "enterprises",
      "employees",
      "campaigns",
      "campaign-new",
      "publications",
      "materials",
      "geo",
      "analytics",
      "access",
      "audit",
    ],
    labels: {
      analytics: "经营分析",
      campaigns: "活动管理",
      employees: "员工管理",
      enterprises: "企业管理",
      materials: "品牌资料",
      overview: "管理总览",
      publications: "发布核实",
    },
  },
  ANALYST: {
    keys: ["overview", "campaigns", "geo", "analytics"],
    labels: {
      analytics: "数据分析",
      campaigns: "活动效果",
      geo: "内容分析",
      overview: "经营概览",
    },
  },
  OPERATOR: {
    keys: [
      "overview",
      "campaigns",
      "campaign-new",
      "publications",
      "materials",
      "geo",
      "analytics",
    ],
    labels: {
      analytics: "数据复盘",
      campaigns: "活动",
      materials: "品牌资料",
      overview: "我的工作",
      publications: "发布核实",
    },
  },
  REVIEWER: {
    keys: ["overview", "campaigns", "publications", "audit"],
    labels: {
      audit: "审核记录",
      campaigns: "活动审核",
      overview: "审核工作台",
      publications: "发布复核",
    },
  },
};

const PersistentShellContext = createContext(false);

export function SaasRouteLayout({
  children,
  mode,
}: Readonly<{ children: ReactNode; mode: ShellMode }>) {
  const auth = useMvpSession();
  const pathname = usePathname();
  const router = useRouter();
  const needsEnterprise =
    mode === "console" &&
    auth.session &&
    !auth.session.enterpriseId &&
    !["/console/enterprises", "/console/access", "/console/audit"].includes(pathname);
  useEffect(() => {
    if (needsEnterprise) router.replace("/console/enterprises");
  }, [needsEnterprise, router]);
  if (needsEnterprise)
    return (
      <main className="setupScreen">
        <section className="setupCard">
          <h1>正在打开企业管理…</h1>
        </section>
      </main>
    );
  if (!auth.session) return children;

  const isPlatform = mode === "platform";
  const roleLabel = isPlatform ? "系统管理员" : selectedAdminRoleName(auth.session);
  const scopeControl = isPlatform ? undefined : (
    <ConsoleScopeSwitcher onChange={auth.setSession} session={auth.session} />
  );
  const scopeName = isPlatform
    ? "系统管理"
    : `${auth.session.tenantName} · ${auth.session.enterpriseName}`;
  const navigationPermissions = isPlatform
    ? platformNavigationPermissions(auth.session)
    : consoleNavigationPermissions(auth.session);
  const accountHref = isPlatform ? "/platform/account" : "/console/account";
  const accountProfile = isPlatform ? auth.session.platformAccess : auth.session.adminAccess;

  return (
    <main className="appShell">
      <SaasSidebar
        mode={mode}
        navigationPermissions={navigationPermissions}
        pathname={pathname}
        roleLabel={roleLabel}
        scopeControl={scopeControl}
        scopeName={scopeName}
      />
      <div className="appWorkspaceColumn">
        <Link className="mobileAccountLink" href={accountHref}>
          <span>{accountProfile.name?.trim().slice(0, 1) || accountProfile.phone?.slice(-2)}</span>
          <strong>{accountProfile.name ?? "个人中心"}</strong>
          <small>个人中心</small>
        </Link>
        {scopeControl ? <div className="mobileScopeControl">{scopeControl}</div> : null}
        {!isPlatform ? <GenerationServiceNotice session={auth.session} /> : null}
        <PersistentShellContext.Provider value={true}>{children}</PersistentShellContext.Provider>
      </div>
    </main>
  );
}

export function SaasShell({
  active,
  activeSub,
  children,
  description,
  mode,
  navigationPermissions,
  roleLabel,
  scopeControl,
  scopeName,
  title,
  toolbar,
}: Readonly<{
  active: string;
  activeSub?: string;
  children: ReactNode;
  description: string;
  mode: ShellMode;
  navigationPermissions?: readonly string[];
  roleLabel?: string;
  scopeControl?: ReactNode;
  scopeName?: string;
  title: string;
  toolbar?: ReactNode;
}>) {
  const pathname = usePathname();
  const insidePersistentLayout = useContext(PersistentShellContext);
  const workspace = (
    <section className="appWorkspace pageEnter" key={pathname}>
      <header className="appHeader">
        <div>
          <span className="appEyebrow" suppressHydrationWarning>
            {mode === "platform" ? "系统设置" : (roleLabel ?? "企业后台")}
          </span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {toolbar ? <div className="toolbar">{toolbar}</div> : null}
      </header>
      {children}
    </section>
  );

  if (insidePersistentLayout) return workspace;

  const activeKey = active === "settings" && activeSub ? `settings-${activeSub}` : active;
  return (
    <main className="appShell">
      <SaasSidebar
        activeKey={activeKey}
        mode={mode}
        navigationPermissions={navigationPermissions ?? []}
        pathname={pathname}
        roleLabel={roleLabel}
        scopeControl={scopeControl}
        scopeName={scopeName}
      />
      <div className="appWorkspaceColumn">
        {scopeControl ? <div className="mobileScopeControl">{scopeControl}</div> : null}
        {workspace}
      </div>
    </main>
  );
}

function SaasSidebar({
  activeKey,
  mode,
  navigationPermissions,
  pathname,
  roleLabel,
  scopeControl,
  scopeName,
}: Readonly<{
  activeKey?: string;
  mode: ShellMode;
  navigationPermissions: readonly string[];
  pathname: string;
  roleLabel?: string;
  scopeControl?: ReactNode;
  scopeName?: string;
}>) {
  const auth = useMvpSession();
  const isPlatform = mode === "platform";
  const groups = visibleNavigation(mode, navigationPermissions, roleLabel);
  const selectedKey = activeKey ?? activeNavigationKey(groups, pathname);
  const accountProfile = isPlatform ? auth.session?.platformAccess : auth.session?.adminAccess;
  const accountHref = isPlatform ? "/platform/account" : "/console/account";

  return (
    <aside className="appSidebar">
      <Link className="appBrand" href={isPlatform ? "/platform" : "/console"}>
        <PlatformLogo />
        <strong>
          <PlatformName />
        </strong>
        <small>{isPlatform ? "系统设置" : "企业全员内容营销"}</small>
      </Link>

      <div className="appNavScroll">
        <nav className="appNav" aria-label={isPlatform ? "平台导航" : "企业控制台导航"}>
          {groups.map((group) => (
            <NavigationSection activeKey={selectedKey} group={group} key={group.key} />
          ))}
        </nav>
      </div>

      <div className="appSidebarBottom">
        {isPlatform ? (
          <Link className="ghostButton" href="/console">
            进入工作空间
          </Link>
        ) : auth.session && platformNavigationPermissions(auth.session).length > 0 ? (
          <Link className="ghostButton" href="/platform">
            系统设置
          </Link>
        ) : null}
        <Link className="ghostButton" href="/employee">
          员工发布入口
        </Link>
        <Link
          aria-current={pathname === accountHref ? "page" : undefined}
          className={`sidebarAccountCard ${pathname === accountHref ? "active" : ""}`}
          href={accountHref}
        >
          <span className="sidebarAccountAvatar">
            {accountProfile?.name?.trim().slice(0, 1) || accountProfile?.phone?.slice(-2) || "我"}
          </span>
          <span>
            <strong>{accountProfile?.name ?? "当前账号"}</strong>
            <small>{accountProfile?.phone ?? "查看个人资料"}</small>
          </span>
          <b aria-hidden="true">›</b>
        </Link>
        <div className="scopeCard">
          <span>{isPlatform ? "平台管理范围" : "当前集团 / 企业"}</span>
          <strong>{scopeName ?? (isPlatform ? "系统管理" : "尚未选择企业")}</strong>
          <small>{roleLabel ?? (isPlatform ? "平台管理员" : "后台管理员")}</small>
          {scopeControl}
        </div>
        <div className="appSidebarFoot">
          <SessionExitButton />
          {auth.session?.mode !== "FORMAL" ? (
            <details className="developmentInfo">
              <summary>开发环境信息</summary>
              <p>本机开发数据 · 不影响正式客户</p>
            </details>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function NavigationSection({
  activeKey,
  group,
}: Readonly<{ activeKey?: string; group: NavigationGroup }>) {
  const containsActive = group.items.some((item) => item.key === activeKey);
  const [open, setOpen] = useState(containsActive);

  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);

  if (group.collapsible === false) {
    const item = group.items[0];
    if (!item) return null;
    return <NavigationLink active={item.key === activeKey} item={item} standalone />;
  }

  return (
    <section className={`appNavSection ${containsActive ? "active" : ""}`}>
      <button
        aria-expanded={open}
        className="appNavSectionToggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="appNavSectionIcon">
          <NavigationIcon name={group.icon} />
        </span>
        <span>
          <strong>{group.label}</strong>
          <small>{group.items.length} 项功能</small>
        </span>
        <b aria-hidden="true" className={open ? "open" : ""} />
      </button>
      <div className="appNavItems" hidden={!open}>
        {group.items.map((item) => (
          <NavigationLink active={item.key === activeKey} item={item} key={item.key} />
        ))}
      </div>
    </section>
  );
}

function NavigationLink({
  active,
  item,
  standalone = false,
}: Readonly<{ active: boolean; item: NavigationItem; standalone?: boolean }>) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`${active ? "active" : ""} ${standalone ? "appNavStandalone" : ""}`}
      href={item.href}
    >
      <span aria-hidden="true" className="appNavLinkIcon">
        <NavigationIcon name={item.icon} />
      </span>
      <span>{item.label}</span>
    </Link>
  );
}

function NavigationIcon({ name }: Readonly<{ name: NavigationIconName }>) {
  const icon = (() => {
    switch (name) {
      case "analytics":
        return (
          <>
            <path d="M4 19V10" />
            <path d="M10 19V5" />
            <path d="M16 19v-7" />
            <path d="M22 19V3" />
          </>
        );
      case "badge-check":
        return (
          <>
            <path d="m12 3 2.2 1.5 2.7-.1 1.3 2.3 2.3 1.3-.1 2.7L21.8 13l-1.5 2.2.1 2.7-2.3 1.3-1.3 2.3-2.7-.1L12 22l-2.2-1.5-2.7.1-1.3-2.3-2.3-1.3.1-2.7L2.2 12l1.5-2.2-.1-2.7 2.3-1.3 1.3-2.3 2.7.1L12 3Z" />
            <path d="m8.3 12 2.3 2.3 5-5" />
          </>
        );
      case "bell":
        return (
          <>
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </>
        );
      case "briefcase":
        return (
          <>
            <rect width="18" height="13" x="3" y="7" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M3 12h18" />
            <path d="M10 12v2h4v-2" />
          </>
        );
      case "building":
        return (
          <>
            <rect width="14" height="18" x="5" y="3" rx="1" />
            <path d="M9 21v-4h6v4M9 7h1M14 7h1M9 11h1M14 11h1" />
          </>
        );
      case "campaign":
        return (
          <>
            <path d="m3 11 16-6v14L3 13v-2Z" />
            <path d="M11.5 16.2 10 20H6.5l1.5-5" />
            <path d="M19 9.5 22 8" />
            <path d="M19 14.5 22 16" />
          </>
        );
      case "dashboard":
        return (
          <>
            <rect width="7" height="7" x="3" y="3" rx="1" />
            <rect width="7" height="7" x="14" y="3" rx="1" />
            <rect width="7" height="7" x="3" y="14" rx="1" />
            <rect width="7" height="7" x="14" y="14" rx="1" />
          </>
        );
      case "database":
        return (
          <>
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
            <path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
          </>
        );
      case "factory":
        return (
          <>
            <path d="M3 21V9l6 4V9l6 4V3h4v18H3Z" />
            <path d="M7 21v-4h2v4M15 17h1M15 13h1" />
          </>
        );
      case "image":
        return (
          <>
            <rect width="18" height="16" x="3" y="4" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="m4 18 5-5 3.5 3.5 2.5-2.5 5 4" />
          </>
        );
      case "key":
        return (
          <>
            <circle cx="8" cy="15" r="4" />
            <path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-2 2" />
          </>
        );
      case "layers":
        return (
          <>
            <path d="m12 3 9 5-9 5-9-5 9-5Z" />
            <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
          </>
        );
      case "list-checks":
        return (
          <>
            <path d="m3 6 1.5 1.5L7 5" />
            <path d="M10 6h11M10 12h11M10 18h11" />
            <path d="m3 12 1.5 1.5L7 11M3 18l1.5 1.5L7 17" />
          </>
        );
      case "lock":
        return (
          <>
            <rect width="16" height="11" x="4" y="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
          </>
        );
      case "map-pin":
        return (
          <>
            <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
            <circle cx="12" cy="10" r="2.5" />
          </>
        );
      case "network":
        return (
          <>
            <rect width="6" height="5" x="9" y="3" rx="1" />
            <rect width="6" height="5" x="3" y="16" rx="1" />
            <rect width="6" height="5" x="15" y="16" rx="1" />
            <path d="M12 8v4M6 16v-2h12v2" />
          </>
        );
      case "package":
        return (
          <>
            <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
            <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
            <path d="m8 5.2 8 4.5" />
          </>
        );
      case "plus-circle":
        return (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8M8 12h8" />
          </>
        );
      case "route":
        return (
          <>
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="6" r="2" />
            <path d="M8 18c5 0 1-9 8-9M8 18h8" />
          </>
        );
      case "search":
        return (
          <>
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </>
        );
      case "settings":
        return (
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.5-1H5.3v-3h.2A1.7 1.7 0 0 0 7 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.5 1Z" />
          </>
        );
      case "shield":
        return <path d="M12 3 20 6v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-3Z" />;
      case "shield-check":
        return (
          <>
            <path d="M12 3 20 6v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-3Z" />
            <path d="m8.5 12 2.2 2.2 4.8-4.8" />
          </>
        );
      case "sliders":
        return (
          <>
            <path d="M4 6h16M4 12h16M4 18h16" />
            <circle cx="9" cy="6" r="2" />
            <circle cx="15" cy="12" r="2" />
            <circle cx="11" cy="18" r="2" />
          </>
        );
      case "sparkles":
        return (
          <>
            <path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" />
            <path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" />
          </>
        );
      case "users":
        return (
          <>
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20v-1.5a4.5 4.5 0 0 1 4.5-4.5h3A4.5 4.5 0 0 1 15 18.5V20" />
            <path d="M17 5.2a3 3 0 0 1 0 5.6M18 14a4.5 4.5 0 0 1 3 4.2V20" />
          </>
        );
    }
  })();

  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {icon}
    </svg>
  );
}

function visibleNavigation(
  mode: ShellMode,
  navigationPermissions: readonly string[],
  roleLabel?: string,
): readonly NavigationGroup[] {
  const permissionSet = new Set(navigationPermissions);
  const workRole = adminWorkRole(roleLabel ?? "后台管理员");
  const roleDefinition = roleNavigation[workRole];
  return (mode === "platform" ? platformNavigation : consoleNavigation)
    .map((group) => ({
      ...group,
      items: group.items
        .filter(
          (item) =>
            (mode === "platform" || roleDefinition.keys.includes(item.key)) &&
            (!item.permissions ||
              item.permissions.some((permission) => permissionSet.has(permission))),
        )
        .map((item) =>
          mode === "platform"
            ? item
            : { ...item, label: roleDefinition.labels[item.key] ?? item.label },
        ),
    }))
    .filter((group) => group.items.length > 0);
}

function activeNavigationKey(
  groups: readonly NavigationGroup[],
  pathname: string,
): string | undefined {
  return groups
    .flatMap(({ items }) => items)
    .filter((item) => routeMatches(item.href, pathname))
    .sort((left, right) => right.href.length - left.href.length)[0]?.key;
}

function routeMatches(href: string, pathname: string): boolean {
  if (href === "/console" || href === "/platform") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function StatusBadge({
  children,
  tone = "neutral",
}: Readonly<{
  children: ReactNode;
  tone?: "danger" | "info" | "neutral" | "success" | "warning";
}>) {
  return <span className={`statusBadge ${tone}`}>{children}</span>;
}
