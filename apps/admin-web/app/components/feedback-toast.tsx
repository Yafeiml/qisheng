"use client";

import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ActionIcon } from "./action-icon";

type FeedbackTone = "error" | "success" | "warning";
type FeedbackField = HTMLElement | RefObject<HTMLElement | null> | null;
type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type FeedbackNotification = Readonly<{
  tone: FeedbackTone;
  content: ReactNode;
  id?: string;
  field?: FeedbackField;
}>;
type Toast = FeedbackNotification & { id: string; signature: string };
type FeedbackApi = {
  notify: (notification: FeedbackNotification) => string;
  dismiss: (id?: string) => void;
  markFieldError: (field: FeedbackField, message?: string) => void;
  clearFieldError: (field: FeedbackField) => void;
  present: (toast: Toast) => void;
  update: (id: string, content: ReactNode) => void;
  remove: (id: string, release?: boolean) => void;
};

const FeedbackContext = createContext<FeedbackApi | null>(null);

function feedbackText(content: ReactNode): string {
  return Children.toArray(content)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child))
        return feedbackText(child.props.children);
      return "";
    })
    .join(" ")
    .trim();
}

function fieldElement(field: FeedbackField): HTMLElement | null {
  return field && "current" in field ? field.current : field;
}

function isFormControl(element: EventTarget | null): element is FormControl {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

function validationMessage(element: FormControl) {
  const label = element.labels?.[0]?.textContent?.trim();
  return `${label ? `${label}：` : ""}${element.validationMessage}`;
}

export function FeedbackToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const signatures = useRef(new Map<string, string>());
  const dismissed = useRef(new Map<string, string>());
  const descriptionPrefix = useId();
  const descriptionCount = useRef(0);
  const validationField = useRef<FormControl | null>(null);
  const markedFields = useRef(
    new Map<
      HTMLElement,
      {
        invalid: string | null;
        describedBy: string | null;
        description?: HTMLSpanElement;
      }
    >(),
  );

  const markFieldError = useCallback(
    (field: FeedbackField, message?: string) => {
      const element = fieldElement(field);
      if (!element) return;
      if (!markedFields.current.has(element)) {
        markedFields.current.set(element, {
          invalid: element.getAttribute("aria-invalid"),
          describedBy: element.getAttribute("aria-describedby"),
        });
      }
      const state = markedFields.current.get(element);
      if (message && state) {
        if (!state.description) {
          state.description = document.createElement("span");
          state.description.hidden = true;
          state.description.id = `${descriptionPrefix}-field-${++descriptionCount.current}`;
          document.body.append(state.description);
          element.setAttribute(
            "aria-describedby",
            [state.describedBy, state.description.id].filter(Boolean).join(" "),
          );
        }
        state.description.textContent = message;
      }
      element.classList.add("feedbackFieldError");
      element.setAttribute("aria-invalid", "true");
    },
    [descriptionPrefix],
  );

  const clearFieldError = useCallback((field: FeedbackField) => {
    const element = fieldElement(field);
    if (!element || !markedFields.current.has(element)) return;
    const previous = markedFields.current.get(element);
    element.classList.remove("feedbackFieldError");
    if (previous?.invalid == null) element.removeAttribute("aria-invalid");
    else element.setAttribute("aria-invalid", previous.invalid);
    if (previous?.description) {
      previous.description.remove();
      if (previous.describedBy == null) element.removeAttribute("aria-describedby");
      else element.setAttribute("aria-describedby", previous.describedBy);
    }
    markedFields.current.delete(element);
  }, []);

  const remove = useCallback((id: string, release = false) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    signatures.current.delete(id);
    if (release) dismissed.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismiss = useCallback(
    (id?: string) => {
      const ids = id ? [id] : [...signatures.current.keys()];
      for (const toastId of ids) {
        dismissed.current.set(toastId, signatures.current.get(toastId) ?? "");
        remove(toastId);
      }
    },
    [remove],
  );

  const present = useCallback(
    (toast: Toast) => {
      if (dismissed.current.get(toast.id) === toast.signature) return;
      dismissed.current.delete(toast.id);
      if (toast.tone === "error") markFieldError(toast.field ?? null, feedbackText(toast.content));
      const changed = signatures.current.get(toast.id) !== toast.signature;
      signatures.current.set(toast.id, toast.signature);
      if (changed) {
        clearTimeout(timers.current.get(toast.id));
        timers.current.set(
          toast.id,
          setTimeout(() => dismiss(toast.id), 3000),
        );
      }
      setToasts((current) => {
        const remaining = current.filter(
          (item) => item.id !== toast.id && item.signature !== toast.signature,
        );
        return [...remaining, toast].slice(-3);
      });
    },
    [dismiss, markFieldError],
  );

  const notify = useCallback(
    (notification: FeedbackNotification) => {
      const signature = `${notification.tone}:${feedbackText(notification.content)}`;
      const id = notification.id ?? signature;
      dismissed.current.delete(id);
      present({ ...notification, id, signature });
      if (notification.field) fieldElement(notification.field)?.focus();
      return id;
    },
    [present],
  );

  const update = useCallback((id: string, content: ReactNode) => {
    setToasts((current) =>
      current.map((toast) =>
        toast.id === id && toast.content !== content ? { ...toast, content } : toast,
      ),
    );
  }, []);

  const closeNewest = useEffectEvent((event: KeyboardEvent) => {
    const latest = toasts.at(-1);
    if (event.key !== "Escape" || event.isComposing || !latest) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismiss(latest.id);
  });

  useEffect(() => {
    setReady(true);
    let firstInvalid: FormControl | null = null;
    const invalid = (event: Event) => {
      const element = event.target;
      if (!isFormControl(element)) return;
      event.preventDefault();
      markFieldError(element);
      if (firstInvalid) return;
      firstInvalid = element;
      queueMicrotask(() => {
        if (!firstInvalid?.isConnected) {
          firstInvalid = null;
          return;
        }
        validationField.current = firstInvalid;
        notify({
          id: "form-validation",
          tone: "error",
          content: validationMessage(firstInvalid),
          field: firstInvalid,
        });
        firstInvalid = null;
      });
    };
    const edited = (event: Event) => {
      const element = event.target;
      if (!isFormControl(element)) return;
      if (element.validity.valid) clearFieldError(element);
      if (element instanceof HTMLInputElement && element.type === "radio") {
        for (const marked of markedFields.current.keys()) {
          if (
            marked instanceof HTMLInputElement &&
            marked.type === "radio" &&
            marked.name === element.name &&
            marked.form === element.form &&
            marked.validity.valid
          )
            clearFieldError(marked);
        }
      }
      if (validationField.current?.validity.valid) {
        const next = [...markedFields.current.keys()].find(
          (marked): marked is FormControl =>
            isFormControl(marked) &&
            marked.isConnected &&
            marked.form === element.form &&
            !marked.validity.valid,
        );
        validationField.current = next ?? null;
        if (next) {
          const content = validationMessage(next);
          markFieldError(next, content);
          notify({ id: "form-validation", tone: "error", content });
        } else dismiss("form-validation");
      }
    };
    const observer = new MutationObserver(() => {
      for (const field of markedFields.current.keys()) {
        if (!field.isConnected) clearFieldError(field);
      }
      if (validationField.current && !validationField.current.isConnected) {
        validationField.current = null;
        dismiss("form-validation");
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("invalid", invalid, true);
    document.addEventListener("input", edited, true);
    document.addEventListener("change", edited, true);
    document.addEventListener("keydown", closeNewest, true);
    return () => {
      document.removeEventListener("invalid", invalid, true);
      document.removeEventListener("input", edited, true);
      document.removeEventListener("change", edited, true);
      document.removeEventListener("keydown", closeNewest, true);
      observer.disconnect();
      for (const timer of timers.current.values()) clearTimeout(timer);
      for (const state of markedFields.current.values()) state.description?.remove();
    };
  }, [clearFieldError, dismiss, markFieldError, notify]);

  const api = useMemo(
    () => ({ notify, dismiss, markFieldError, clearFieldError, present, update, remove }),
    [notify, dismiss, markFieldError, clearFieldError, present, update, remove],
  );

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      {ready && toasts.length
        ? createPortal(
            <div className="feedbackToastStack">
              {toasts.map((toast) => (
                <div
                  className="feedbackToast"
                  data-tone={toast.tone}
                  key={toast.id}
                  role={toast.tone === "error" ? "alert" : "status"}
                  aria-atomic="true"
                >
                  <span className="feedbackToastIcon" aria-hidden="true">
                    <ActionIcon
                      name={
                        toast.tone === "success"
                          ? "check"
                          : toast.tone === "error"
                            ? "ban"
                            : "clock-alert"
                      }
                    />
                  </span>
                  <div className="feedbackToastContent">{toast.content}</div>
                  <button
                    aria-label="关闭提示"
                    className="feedbackToastDismiss"
                    type="button"
                    onClick={() => dismiss(toast.id)}
                  >
                    <ActionIcon name="x" />
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </FeedbackContext.Provider>
  );
}

export function useFeedbackToast() {
  const api = useContext(FeedbackContext);
  if (!api) throw new Error("FeedbackToastProvider is required");
  return api;
}

export function FeedbackMessage({
  tone,
  children,
  field,
  descriptionId,
}: Readonly<{
  tone: FeedbackTone;
  children: ReactNode;
  field?: FeedbackField;
  descriptionId?: string;
}>) {
  const id = useId();
  const { present, update, remove, markFieldError, clearFieldError } = useFeedbackToast();
  const text = feedbackText(children);
  const signature = `${tone}:${text}`;
  const display = useEffectEvent((nextSignature: string) =>
    present({ id, tone, content: children, signature: nextSignature, field }),
  );

  useEffect(() => {
    display(signature);
  }, [signature]);

  useEffect(() => {
    update(id, children);
  }, [children, id, update]);

  useEffect(() => {
    if (tone === "error" && field) markFieldError(field, text);
    return () => {
      if (field) clearFieldError(field);
    };
  }, [clearFieldError, field, markFieldError, tone, text]);

  useEffect(() => () => remove(id, true), [id, remove]);

  return (
    <span hidden id={descriptionId} data-feedback-source={id}>
      {text}
    </span>
  );
}
