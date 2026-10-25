export type ActionIconName =
  | "files"
  | "file-text"
  | "image"
  | "badge-check"
  | "history-check"
  | "ban"
  | "clock-alert"
  | "file-clock"
  | "file-check"
  | "file-search"
  | "file-warning"
  | "link-search"
  | "lock"
  | "send"
  | "archive"
  | "arrow-left"
  | "check"
  | "copy"
  | "download"
  | "plus"
  | "refresh"
  | "restore"
  | "users"
  | "x";

export function ActionIcon({ name }: Readonly<{ name: ActionIconName }>) {
  const paths: Record<ActionIconName, React.ReactNode> = {
    files: (
      <>
        <path d="M8 3h8l4 4v14H8z" />
        <path d="M16 3v5h4M4 7v14" />
      </>
    ),
    "file-text": (
      <>
        <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1.5" />
        <path d="m3 17 5-5 4 4 4-6 5 7" />
      </>
    ),
    "badge-check": (
      <>
        <path d="m12 3 7 3v6c0 4-7 9-7 9s-7-5-7-9V6l7-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    "history-check": (
      <>
        <path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    ban: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m6 6 12 12" />
      </>
    ),
    "clock-alert": (
      <>
        <path d="M12 3a9 9 0 1 0 9 9M12 7v5l-3 2M20 3v4M20 10h.01" />
      </>
    ),
    "file-clock": (
      <>
        <path d="M9 21H4V3h10l4 4v3M14 3v5h4" />
        <circle cx="16" cy="17" r="5" />
        <path d="M16 14v3l2 1" />
      </>
    ),
    "file-check": (
      <>
        <path d="M20 11V7l-4-4H4v18h7M15 3v5h5" />
        <path d="m13 17 3 3 6-7" />
      </>
    ),
    "file-search": (
      <>
        <path d="M10 21H4V3h10l4 4v3M14 3v5h4" />
        <circle cx="15" cy="16" r="4" />
        <path d="m18 19 3 3" />
      </>
    ),
    "file-warning": (
      <>
        <path d="M20 21H4V3h11l5 5v13ZM14 3v6h6M12 12v3M12 18h.01" />
      </>
    ),
    "link-search": (
      <>
        <path d="m10 13 4-4M8 16H6a4 4 0 0 1-3-7l4-4a4 4 0 0 1 6 0M14 3a4 4 0 0 1 7 5l-2 2" />
        <circle cx="16" cy="16" r="4" />
        <path d="m19 19 3 3" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2" />
      </>
    ),
    archive: (
      <>
        <path d="M4 7h16" />
        <path d="M5 4h14l1 3H4l1-3Z" />
        <path d="M6 7v12h12V7" />
        <path d="M9 11h6" />
      </>
    ),
    "arrow-left": (
      <>
        <path d="m15 18-6-6 6-6" />
        <path d="M9 12h11" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    copy: (
      <>
        <rect height="13" rx="2" width="13" x="8" y="8" />
        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    refresh: (
      <>
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 3v6h-6" />
      </>
    ),
    restore: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
        <path d="M16 3.1a4 4 0 0 1 0 7.8" />
      </>
    ),
    x: (
      <>
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="actionIcon"
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
        {paths[name]}
      </g>
    </svg>
  );
}
