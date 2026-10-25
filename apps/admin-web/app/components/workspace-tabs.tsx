"use client";

export type WorkspaceTab<Key extends string> = Readonly<{
  count?: number;
  key: Key;
  label: string;
}>;

export function WorkspaceTabs<Key extends string>({
  active,
  ariaLabel,
  onChange,
  onPreload,
  tabs,
}: Readonly<{
  active: Key;
  ariaLabel: string;
  onChange: (key: Key) => void;
  onPreload?: (key: Key) => void;
  tabs: readonly WorkspaceTab<Key>[];
}>) {
  const preload = (key: Key) => {
    if (key !== active) onPreload?.(key);
  };

  return (
    <div aria-label={ariaLabel} className="workspaceTabs" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={active === tab.key}
          className={active === tab.key ? "active" : ""}
          key={tab.key}
          onFocus={() => preload(tab.key)}
          onClick={() => onChange(tab.key)}
          onPointerDown={() => preload(tab.key)}
          onPointerEnter={() => preload(tab.key)}
          role="tab"
          type="button"
        >
          <span>{tab.label}</span>
          {tab.count === undefined ? null : <b>{tab.count}</b>}
        </button>
      ))}
    </div>
  );
}
