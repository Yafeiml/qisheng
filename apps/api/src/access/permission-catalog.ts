export type PermissionDefinition = Readonly<{
  code: string;
  name: string;
  description: string;
}>;

export const permissionCatalog = [
  {
    code: "platform.tenant.read",
    description: "查看平台客户、集团和企业开通信息",
    name: "查看平台租户",
  },
  {
    code: "platform.tenant.manage",
    description: "创建和维护平台客户、集团及其企业",
    name: "管理平台租户",
  },
  {
    code: "platform.model.manage",
    description: "维护模型 Provider、模型目录和路由策略",
    name: "管理平台模型",
  },
  {
    code: "platform.monitor.read",
    description: "查看平台运行状态、队列和模型健康信息",
    name: "查看平台监控",
  },
  {
    code: "platform.monitor.manage",
    description: "恢复异常生成任务并执行平台运行干预",
    name: "管理平台运行",
  },
  {
    code: "platform.settings.manage",
    description: "维护平台业务参数、存储、安全和通知设置",
    name: "管理平台参数",
  },
  {
    code: "platform.access.manage",
    description: "治理平台管理员账号、角色绑定和管理会话",
    name: "管理平台管理员",
  },
  {
    code: "tenant.enterprise.read",
    description: "查看当前集团租户下的企业",
    name: "查看集团企业",
  },
  {
    code: "tenant.enterprise.manage",
    description: "创建和维护当前集团租户下的企业",
    name: "管理集团企业",
  },
  {
    code: "tenant.shared-material.manage",
    description: "管理租户公共素材、规则和 GEO 规范",
    name: "管理集团公共内容",
  },
  {
    code: "tenant.dashboard.read",
    description: "查看租户企业对比和授权范围内的数据看板",
    name: "查看集团看板",
  },
  {
    code: "tenant.role.manage",
    description: "管理租户及其企业范围的后台角色绑定",
    name: "管理集团角色",
  },
  {
    code: "tenant.membership.policy.manage",
    description: "设置集团旗下企业的任务参与和员工启用管理下放策略",
    name: "管理集团人员策略",
  },
  {
    code: "enterprise.settings.manage",
    description: "维护企业基础设置",
    name: "管理企业设置",
  },
  {
    code: "enterprise.membership.read",
    description: "查看当前企业员工成员身份",
    name: "查看企业员工",
  },
  {
    code: "enterprise.membership.manage",
    description: "导入、绑定、启用、禁用和维护企业员工",
    name: "管理企业员工",
  },
  {
    code: "enterprise.role.manage",
    description: "管理当前企业的后台角色绑定",
    name: "管理企业角色",
  },
  {
    code: "enterprise.membership.participation.manage",
    description: "按集团下放策略管理本企业员工任务参与状态",
    name: "管理员工任务参与",
  },
  {
    code: "material.read",
    description: "查看授权范围内的素材和结构化事实",
    name: "查看素材",
  },
  {
    code: "material.manage",
    description: "维护授权范围内的素材和敏感词规则",
    name: "管理素材",
  },
  {
    code: "geo.read",
    description: "查看 GEO 实体、主题和问题库",
    name: "查看 GEO",
  },
  {
    code: "geo.manage",
    description: "维护 GEO 实体、主题和问题库",
    name: "管理 GEO",
  },
  {
    code: "campaign.read",
    description: "查看授权范围内的活动和生成结果",
    name: "查看活动",
  },
  {
    code: "campaign.manage",
    description: "创建活动、发起生成和处理失败项",
    name: "管理活动",
  },
  {
    code: "campaign.approve",
    description: "执行活动合规审核和正式批准",
    name: "批准活动",
  },
  {
    code: "dashboard.read",
    description: "查看授权企业范围内的执行看板和排名",
    name: "查看企业看板",
  },
  {
    code: "audit.read",
    description: "查看授权范围内的审计记录",
    name: "查看审计记录",
  },
] as const satisfies readonly PermissionDefinition[];

export type PermissionCode = (typeof permissionCatalog)[number]["code"];
export type DefaultRoleScope = "PLATFORM" | "TENANT" | "ENTERPRISE";

export type DefaultRoleDefinition = Readonly<{
  code: string;
  name: string;
  description: string;
  scopeType: DefaultRoleScope;
  permissions: readonly PermissionCode[];
}>;

const platformPermissions = permissionCatalog
  .map(({ code }) => code)
  .filter((code): code is PermissionCode => code.startsWith("platform."));

const tenantAdminPermissions = permissionCatalog
  .map(({ code }) => code)
  .filter((code): code is PermissionCode => !code.startsWith("platform."));

const enterpriseAdminPermissions = [
  "enterprise.settings.manage",
  "enterprise.membership.read",
  "enterprise.membership.manage",
  "enterprise.role.manage",
  "enterprise.membership.participation.manage",
  "material.read",
  "material.manage",
  "geo.read",
  "geo.manage",
  "campaign.read",
  "campaign.manage",
  "campaign.approve",
  "dashboard.read",
  "audit.read",
] as const satisfies readonly PermissionCode[];

const tenantContentOperatorPermissions = [
  "tenant.enterprise.read",
  "tenant.shared-material.manage",
  "enterprise.membership.read",
  "material.read",
  "material.manage",
  "geo.read",
  "geo.manage",
  "campaign.read",
  "campaign.manage",
  "dashboard.read",
] as const satisfies readonly PermissionCode[];

const enterpriseContentOperatorPermissions = [
  "enterprise.membership.read",
  "material.read",
  "material.manage",
  "geo.read",
  "geo.manage",
  "campaign.read",
  "campaign.manage",
  "dashboard.read",
] as const satisfies readonly PermissionCode[];

const tenantHrAdminPermissions = [
  "tenant.enterprise.read",
  "tenant.membership.policy.manage",
  "enterprise.membership.read",
  "enterprise.membership.manage",
  "enterprise.membership.participation.manage",
  "audit.read",
] as const satisfies readonly PermissionCode[];

const enterpriseHrAdminPermissions = [
  "enterprise.membership.read",
  "enterprise.membership.manage",
  "enterprise.membership.participation.manage",
  "audit.read",
] as const satisfies readonly PermissionCode[];

const complianceReviewerPermissions = [
  "material.read",
  "campaign.read",
  "campaign.approve",
  "dashboard.read",
  "audit.read",
] as const satisfies readonly PermissionCode[];

const tenantDataViewerPermissions = [
  "tenant.enterprise.read",
  "tenant.dashboard.read",
  "enterprise.membership.read",
  "material.read",
  "geo.read",
  "campaign.read",
  "dashboard.read",
] as const satisfies readonly PermissionCode[];

const enterpriseDataViewerPermissions = [
  "enterprise.membership.read",
  "material.read",
  "geo.read",
  "campaign.read",
  "dashboard.read",
] as const satisfies readonly PermissionCode[];

export const defaultRoleCatalog = [
  {
    code: "PLATFORM_ADMIN",
    description: "SaaS 平台租户、模型和运行管理",
    name: "平台管理员",
    permissions: platformPermissions,
    scopeType: "PLATFORM",
  },
  {
    code: "TENANT_ADMIN",
    description: "集团唯一主管理员，负责旗下企业、后台授权和全部业务治理",
    name: "集团主管理员",
    permissions: tenantAdminPermissions,
    scopeType: "TENANT",
  },
  {
    code: "ENTERPRISE_ADMIN",
    description: "单一企业范围内的组织、内容、角色和数据管理",
    name: "企业管理员",
    permissions: enterpriseAdminPermissions,
    scopeType: "ENTERPRISE",
  },
  {
    code: "CONTENT_OPERATOR_TENANT",
    description: "集团范围的素材、GEO 和活动运营",
    name: "集团内容运营",
    permissions: tenantContentOperatorPermissions,
    scopeType: "TENANT",
  },
  {
    code: "CONTENT_OPERATOR_ENTERPRISE",
    description: "企业范围的素材、GEO 和活动运营",
    name: "企业内容运营",
    permissions: enterpriseContentOperatorPermissions,
    scopeType: "ENTERPRISE",
  },
  {
    code: "HR_ADMIN_TENANT",
    description: "集团范围的员工档案和任务参与策略管理",
    name: "集团人资管理员",
    permissions: tenantHrAdminPermissions,
    scopeType: "TENANT",
  },
  {
    code: "HR_ADMIN_ENTERPRISE",
    description: "企业范围的部门、员工档案和任务参与管理",
    name: "企业人资管理员",
    permissions: enterpriseHrAdminPermissions,
    scopeType: "ENTERPRISE",
  },
  {
    code: "COMPLIANCE_REVIEWER_TENANT",
    description: "集团范围的合规检查和活动批准",
    name: "集团合规审核员",
    permissions: complianceReviewerPermissions,
    scopeType: "TENANT",
  },
  {
    code: "COMPLIANCE_REVIEWER_ENTERPRISE",
    description: "企业范围的合规检查和活动批准",
    name: "企业合规审核员",
    permissions: complianceReviewerPermissions,
    scopeType: "ENTERPRISE",
  },
  {
    code: "DATA_VIEWER_TENANT",
    description: "集团范围的数据只读访问",
    name: "集团数据查看员",
    permissions: tenantDataViewerPermissions,
    scopeType: "TENANT",
  },
  {
    code: "DATA_VIEWER_ENTERPRISE",
    description: "企业范围的数据只读访问",
    name: "企业数据查看员",
    permissions: enterpriseDataViewerPermissions,
    scopeType: "ENTERPRISE",
  },
] as const satisfies readonly DefaultRoleDefinition[];
