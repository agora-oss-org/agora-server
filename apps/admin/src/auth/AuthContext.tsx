// Auth context: exposes the reactive session (via useSyncExternalStore over the session store) plus
// sign-in / sign-out. `isOperator` drives the role-aware UI (operator god-view vs space-scoped).
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { AuthUser } from "@agora-server/contract";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { getSession, setSession, subscribe, type Session } from "./session";
import type { OAuthCallbackTokens, OAuthProvider } from "./oauth";

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
  /** Start a social sign-in: navigates the browser to the provider (never returns normally). */
  signInWithOAuth: (provider: OAuthProvider, projectId: string) => Promise<void>;
  /** Finish one: trade the callback's refresh token for a session (and the user object). */
  completeOAuth: (tokens: OAuthCallbackTokens, projectId: string) => Promise<void>;
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
        track("admin-login", { operator: !!data.user.isOperator });
      },
      async signInWithOAuth(provider, projectId) {
        const { authorizationUrl } = await api<{ authorizationUrl: string }>("/oauth/authorize", {
          method: "POST",
          // Come back to this screen: LoginPage completes the flow from the URL on mount. The server
          // allowlists this origin (OAUTH_REDIRECT_ALLOWED_ORIGINS / PUBLIC_BASE_URL).
          body: { provider, redirectAfterAuth: `${window.location.origin}/login` },
          projectId,
          auth: false,
        });
        track("admin-oauth-start", { provider });
        window.location.assign(authorizationUrl);
      },
      async completeOAuth({ refreshToken }, projectId) {
        // The callback also puts an access token in the fragment, but we deliberately redeem the
        // refresh token instead: it rotates the pair (invalidating the one that just travelled
        // through the URL) and is the only response that carries the shaped AuthUser.
        const data = await api<{ accessToken: string; refreshToken: string; user?: AuthUser }>(
          "/auth/request-new-access-token",
          { method: "POST", body: { refreshToken }, projectId, auth: false },
        );
        if (!data.user) throw new Error("Signed in, but the account could not be loaded.");
        setSession({ user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken, projectId });
        track("admin-login", { operator: !!data.user.isOperator, oauth: true });
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
        track("admin-logout");
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
