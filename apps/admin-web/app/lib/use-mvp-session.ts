"use client";

import {
  createContext,
  createElement,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  bootstrapMvp,
  clearMvpSession,
  loadMvpSession,
  logoutFormalAdmin,
  type MvpSession,
  refreshMvpSession,
  registerUnauthorizedRecovery,
} from "./mvp-client";

type MvpSessionState = ReturnType<typeof useMvpSessionState>;

const MvpSessionContext = createContext<MvpSessionState | null>(null);

function useMvpSessionState() {
  const [session, setSessionState] = useState<MvpSession | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<MvpSession | null | undefined>(undefined);
  const renewalRef = useRef<Promise<MvpSession | null> | null>(null);
  const sessionInvalidationRef = useRef(0);
  const tokenReplacementsRef = useRef(new Map<string, string>());

  const setSession = useCallback<Dispatch<SetStateAction<MvpSession | null | undefined>>>(
    (value) => {
      setSessionState((current) => {
        const next = typeof value === "function" ? value(current) : value;
        sessionRef.current = next;
        return next;
      });
    },
    [],
  );

  const renewSession = useCallback(async (): Promise<MvpSession | null> => {
    if (renewalRef.current) return renewalRef.current;
    const current = sessionRef.current;
    if (!current) return null;
    const invalidation = sessionInvalidationRef.current;
    const renewal = refreshMvpSession(current)
      .then((next) => {
        if (sessionInvalidationRef.current !== invalidation) return null;
        rememberTokenReplacements(tokenReplacementsRef.current, current, next);
        setError(null);
        setSession(next);
        return next;
      })
      .catch((reason: unknown) => {
        if (sessionInvalidationRef.current !== invalidation) return null;
        clearMvpSession();
        tokenReplacementsRef.current.clear();
        setError(sessionRecoveryMessage(reason));
        setSession(null);
        return null;
      })
      .finally(() => {
        if (renewalRef.current === renewal) renewalRef.current = null;
      });
    renewalRef.current = renewal;
    return renewal;
  }, [setSession]);

  useEffect(() => {
    const stored = loadMvpSession();
    if (!stored) {
      setSession(null);
      return;
    }
    sessionRef.current = stored;
    void renewSession();
  }, [renewSession, setSession]);

  useEffect(
    () =>
      registerUnauthorizedRecovery(async (expiredToken) => {
        const remembered = tokenReplacementsRef.current.get(expiredToken);
        if (remembered) return remembered;
        const current = sessionRef.current;
        if (!current) return null;
        const tokenField = sessionTokenField(current, expiredToken);
        if (!tokenField) return null;
        const renewed = await renewSession();
        return renewed?.[tokenField] ?? tokenReplacementsRef.current.get(expiredToken) ?? null;
      }),
    [renewSession],
  );

  useEffect(() => {
    if (!session?.accessTokenExpiresAt) return;
    const refreshAt = Date.parse(session.accessTokenExpiresAt) - 60_000;
    const timeout = window.setTimeout(
      () => {
        void renewSession();
      },
      Math.max(1_000, refreshAt - Date.now()),
    );
    const renewWhenReturning = () => {
      const current = sessionRef.current;
      if (!current?.accessTokenExpiresAt) return;
      if (Date.parse(current.accessTokenExpiresAt) <= Date.now() + 60_000) {
        void renewSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") renewWhenReturning();
    };
    window.addEventListener("focus", renewWhenReturning);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("focus", renewWhenReturning);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [renewSession, session?.accessTokenExpiresAt]);

  const initialize = useCallback(async () => {
    sessionInvalidationRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      setSession(await bootstrapMvp());
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }, [setSession]);

  const reset = useCallback(() => {
    const current = sessionRef.current;
    const formal = current?.mode === "FORMAL";
    sessionInvalidationRef.current += 1;
    clearMvpSession();
    tokenReplacementsRef.current.clear();
    setSession(null);
    if (formal) {
      void logoutFormalAdmin().catch((reason: unknown) => setError(messageOf(reason)));
    }
  }, [setSession]);

  return { busy, error, initialize, reset, session, setSession };
}

export function MvpSessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const value = useMvpSessionState();
  return createElement(MvpSessionContext.Provider, { value }, children);
}

export function useMvpSession(): MvpSessionState {
  const value = useContext(MvpSessionContext);
  if (!value) throw new Error("useMvpSession must be used inside MvpSessionProvider");
  return value;
}

export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : "发生未知错误";
}

type SessionTokenField = "adminToken" | "employeeToken" | "platformToken";

function sessionTokenField(session: MvpSession, token: string): SessionTokenField | null {
  if (session.adminToken === token) return "adminToken";
  if (session.platformToken === token) return "platformToken";
  if (session.employeeToken === token) return "employeeToken";
  return null;
}

function rememberTokenReplacements(
  replacements: Map<string, string>,
  previous: MvpSession,
  next: MvpSession,
): void {
  for (const field of ["adminToken", "platformToken", "employeeToken"] as const) {
    const expired = previous[field];
    const replacement = next[field];
    if (expired && replacement && expired !== replacement) replacements.set(expired, replacement);
  }
  while (replacements.size > 12) {
    const oldest = replacements.keys().next().value;
    if (typeof oldest !== "string") break;
    replacements.delete(oldest);
  }
}

function sessionRecoveryMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.status === 401) {
    return "登录状态已失效，请重新登录";
  }
  return `无法恢复登录状态：${messageOf(reason)}`;
}
