"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function WorkspaceDrawer({
  children,
  description,
  footer,
  onClose,
  open,
  title,
  wide = false,
}: Readonly<{
  children: ReactNode;
  description?: string;
  footer?: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
  wide?: boolean;
}>) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="workspaceDrawerBackdrop">
      <button
        aria-hidden="true"
        className="workspaceDrawerDismiss"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={wide ? "workspaceDrawer workspaceDrawerWide" : "workspaceDrawer"}
        ref={drawerRef}
        role="dialog"
      >
        <header className="workspaceDrawerHeader">
          <div>
            <span>辅助操作</span>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button
            aria-label={`关闭${title}`}
            className="workspaceDrawerClose"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="workspaceDrawerBody">{children}</div>
        {footer ? <footer className="workspaceDrawerFooter">{footer}</footer> : null}
      </section>
    </div>,
    document.body,
  );
}
