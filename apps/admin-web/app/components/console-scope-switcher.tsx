"use client";

import { adminEnterpriseContexts, type MvpSession, selectAdminEnterprise } from "../lib/mvp-client";

export function ConsoleScopeSwitcher({
  onChange,
  session,
}: Readonly<{
  onChange: (session: MvpSession) => void;
  session: MvpSession;
}>) {
  const contexts = adminEnterpriseContexts(session);
  if (contexts.length < 2) return null;
  const selected = contexts.find(({ enterpriseId }) => enterpriseId === session.enterpriseId);
  const tenants = [
    ...new Map(
      contexts.map((context) => [
        context.tenantId,
        { id: context.tenantId, name: context.tenantName },
      ]),
    ).values(),
  ];

  return (
    <label className="scopeSwitcher">
      <span>当前集团 / 企业</span>
      <select
        aria-label="切换当前企业"
        disabled={contexts.length < 2}
        onChange={(event) => onChange(selectAdminEnterprise(session, event.target.value))}
        value={session.enterpriseId}
      >
        {tenants.map((tenant) => (
          <optgroup key={tenant.id} label={tenant.name}>
            {contexts
              .filter(({ tenantId }) => tenantId === tenant.id)
              .map((context) => (
                <option key={context.enterpriseId} value={context.enterpriseId}>
                  {context.enterpriseName}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <small>{selected?.roleName ?? "后台管理员"}</small>
    </label>
  );
}
