// Auth context: exposes the reactive session (via useSyncExternalStore over the session store) plus
// sign-in / sign-out. `isOperator` drives the role-aware UI (operator god-view vs space-scoped).
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { AuthUser } from "@agora-server/contract";
import { api } from "../lib/api";
import { getSession, setSession, subscribe, type Session } from "./session";

interface SignInResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

interface AuthValue {
  session: Session | null;
  user: AuthUser | null;
  isOperator: boolean;
  isSteward: boolean;
  isProjectOwner: boolean;
  isProjectAdmin: boolean;
  signIn: (email: string, password: string, projectId: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribe, getSession, getSession);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isOperator: !!session?.user?.isOperator,
      // Operators are stewards implicitly (they hold the project-wide god-view).
      isSteward: !!session?.user?.isSteward || !!session?.user?.isOperator,
      // Hierarchy: operator ⊇ project-owner ⊇ project-admin. Fold the higher tiers in so an operator
      // (and an owner) always satisfies an admin-gated UI check.
      isProjectOwner: !!session?.user?.isProjectOwner || !!session?.user?.isOperator,
      isProjectAdmin:
        !!session?.user?.isProjectAdmin || !!session?.user?.isProjectOwner || !!session?.user?.isOperator,
      async signIn(email, password, projectId) {
        const data = await api<SignInResponse>("/auth/sign-in", {
          method: "POST",
          body: { email, password },
          projectId,
          auth: false,
        });
        setSession({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken, projectId });
      },
      async signOut() {
        const s = getSession();
        if (s) {
          try {
            await api("/auth/sign-out", { method: "POST", body: { refreshToken: s.refreshToken } });
          } catch {
            /* sign-out is best-effort; clear locally regardless */
          }
        }
        setSession(null);
      },
    }),
    [session],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
