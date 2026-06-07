// Reactive session store — the single source of truth for the signed-in operator/moderator. Backed
// by localStorage (survives reload) and exposed to React via useSyncExternalStore (auth/AuthContext).
// The API client (lib/api.ts) reads tokens from here and writes rotated ones back after a refresh.
import type { AuthUser } from "@agora-server/contract";

export interface Session {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  projectId: string;
}

const KEY = "agora.admin.session";

function load(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

let current: Session | null = load();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getSession(): Session | null {
  return current;
}

export function setSession(next: Session | null): void {
  current = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode / quota — keep the in-memory session */
  }
  emit();
}

/** Replace just the tokens (and optionally the user) after a refresh, preserving project/user. */
export function patchTokens(accessToken: string, refreshToken: string, user?: AuthUser): void {
  if (!current) return;
  setSession({ ...current, accessToken, refreshToken, ...(user ? { user } : {}) });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Cross-tab sync: another tab signing in/out updates this one.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      current = load();
      emit();
    }
  });
}
