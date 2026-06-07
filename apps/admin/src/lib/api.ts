// Authed fetch client for @agora/api. Prefixes the multi-tenant base (/v7/:projectId), attaches the
// Bearer access token, and transparently rotates it on a 401 (single-flight) using the refresh token
// — mirroring the SDK's auto-refresh contract (MANIFEST §1). Errors surface as typed ApiError.
import type { ErrorEnvelope } from "@agora-server/contract";
import { API_BASE, ENV_PROJECT_ID } from "../config";
import { getSession, patchTokens, setSession } from "../auth/session";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Override the project id (used pre-session, e.g. sign-in). Falls back to session → env. */
  projectId?: string;
  /** Send the Bearer token (default true). Set false for public/auth-bootstrap calls. */
  auth?: boolean;
  /** Override the service base (default API_BASE). Used to target the @agora/moderator service,
   *  reusing this client's Bearer + single-flight refresh. Token refresh always uses API_BASE. */
  base?: string;
  signal?: AbortSignal;
}

// Single-flight refresh: concurrent 401s share one rotation round-trip.
let refreshing: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const s = getSession();
  if (!s?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/${s.projectId}/auth/request-new-access-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; refreshToken: string; user?: any };
      patchTokens(data.accessToken, data.refreshToken, data.user);
      return true;
    } catch {
      return false;
    }
  })();
  const ok = await refreshing;
  refreshing = null;
  return ok;
}

function buildUrl(projectId: string, path: string, query?: ApiOptions["query"], base: string = API_BASE): string {
  const url = new URL(`${base}/${projectId}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const env = (data ?? {}) as Partial<ErrorEnvelope>;
    throw new ApiError(res.status, env.code ?? `http/${res.status}`, env.error ?? res.statusText, env.field);
  }
  return data as T;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, query, auth = true, base, signal } = opts;
  const session = getSession();
  const projectId = opts.projectId ?? session?.projectId ?? ENV_PROJECT_ID;
  if (!projectId) throw new ApiError(0, "config/no-project", "No project id configured");

  const send = async (token?: string): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    return fetch(buildUrl(projectId, path, query, base), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  };

  let res = await send(auth ? session?.accessToken : undefined);

  // Rotate once on 401, then retry with the fresh token.
  if (res.status === 401 && auth && session?.refreshToken) {
    if (await refreshAccessToken()) {
      res = await send(getSession()?.accessToken);
    } else {
      setSession(null); // refresh failed → force re-login
    }
  }

  return parse<T>(res);
}
