// Umami reporting client — reads analytics BACK from Umami for the admin's operator-only Analytics
// page (the counterpart to lib/umami.ts, which only SENDS events). Self-hosted Umami authenticates via
// POST /api/auth/login → Bearer token (AGORA_UMAMI_USERNAME/PASSWORD); `x-umami-api-key` is a Umami
// **Cloud**-only fallback. Runs server-side behind the operator gate only — credentials must never
// reach the browser. Returns a shaped overview; throws ApiError on failure.
import { env } from "./env.js";
import { Errors } from "../http/errors.js";
import { logger } from "./logger.js";

export type UmamiSite = "product" | "admin";

export interface UmamiOverview {
  site: UmamiSite;
  days: number;
  configured: boolean;
  stats: { pageviews: number; visitors: number; visits: number };
  topEvents: { name: string; count: number }[];
  series: { date: string; pageviews: number; sessions: number }[];
  // Event-centric analytics (the meaningful view for the server site, which has no pageviews):
  totalEvents: number;                                                  // total events in window
  eventSeries: { date: string; count: number }[];                       // all events per time bucket
  properties: { name: string; values: { value: string; count: number }[] }[]; // breakdowns of our event `data`
}

// The reporting API lives at AGORA_UMAMI_API_URL when set, else AGORA_UMAMI_URL (the tracker host).
// Paths are joined by concatenation (not `new URL(absolutePath, base)`) so a path-prefixed base
// (e.g. https://host/umami) is preserved — an absolute path would reset to the host root.
const reportingBase = (): string | undefined => env.AGORA_UMAMI_API_URL ?? env.AGORA_UMAMI_URL;
const apiUrl = (path: string): string => `${reportingBase()!.replace(/\/+$/, "")}${path}`;

// Self-hosted Umami authenticates via POST /api/auth/login → Bearer token; `x-umami-api-key` only
// works on Umami Cloud. Prefer the login flow when username/password are set, else fall back to the key.
const usePasswordAuth = (): boolean => !!(env.AGORA_UMAMI_USERNAME && env.AGORA_UMAMI_PASSWORD);

/** True when the reporting API can be called: a base URL + a credential (login creds OR a Cloud key). */
export function umamiReportingEnabled(): boolean {
  return !!(reportingBase() && (usePasswordAuth() || env.AGORA_UMAMI_API_KEY));
}

/** The Umami website id for a logical site, or undefined when that site isn't configured. */
function websiteId(site: UmamiSite): string | undefined {
  return site === "admin" ? env.AGORA_UMAMI_ADMIN_ID : env.AGORA_UMAMI_SERVER_ID;
}

// Umami may return summary metrics as `{ value, prev }` (v2) or a bare number (older) — normalize both.
const num = (v: unknown): number =>
  typeof v === "number" ? v : Number((v as { value?: unknown } | null)?.value ?? 0) || 0;

// Cached self-hosted Bearer token — cleared + re-fetched on a 401 (expiry), so no fixed TTL needed.
let tokenCache: string | null = null;

async function login(): Promise<string> {
  const res = await fetch(apiUrl("/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ username: env.AGORA_UMAMI_USERNAME, password: env.AGORA_UMAMI_PASSWORD }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    logger.warn({ status: res.status }, "umami-reporting: login failed");
    throw Errors.badRequest("admin/umami-auth", "Umami login failed — check AGORA_UMAMI_USERNAME / AGORA_UMAMI_PASSWORD");
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw Errors.badRequest("admin/umami-auth", "Umami login returned no token");
  return data.token;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (usePasswordAuth()) {
    tokenCache ??= await login();
    return { authorization: `Bearer ${tokenCache}` };
  }
  return { "x-umami-api-key": env.AGORA_UMAMI_API_KEY! };
}

async function umamiGet(path: string, params: Record<string, string | number>, retried = false): Promise<unknown> {
  const url = new URL(apiUrl(`/api/websites/${path}`));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { ...(await authHeaders()), accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  // A Bearer token likely just expired → drop it, re-login once, retry.
  if (res.status === 401 && usePasswordAuth() && !retried) {
    tokenCache = null;
    return umamiGet(path, params, true);
  }
  if (!res.ok) {
    logger.warn({ status: res.status, path }, "umami-reporting: upstream error");
    if (res.status === 401 || res.status === 403)
      throw Errors.badRequest("admin/umami-auth", "Umami rejected the reporting credentials — self-hosted needs AGORA_UMAMI_USERNAME/PASSWORD (x-umami-api-key is Umami-Cloud only)");
    throw Errors.badRequest("admin/umami-upstream", `Umami reporting request failed (HTTP ${res.status})`);
  }
  return res.json();
}

/** Best-effort GET for supplementary endpoints (older Umami may lack event-data) — null on any failure. */
async function umamiGetSafe(path: string, params: Record<string, string | number>): Promise<unknown> {
  try {
    return await umamiGet(path, params);
  } catch {
    return null;
  }
}

/**
 * Fetch a shaped analytics overview for one site over the trailing `days` window: summary stats +
 * pageviews series (browser sites) and the event-centric view (top events, total, per-bucket series,
 * and breakdowns of the custom event `data`) — the latter is what the server site has. Operator-gated.
 */
export async function getOverview(site: UmamiSite, days: number): Promise<UmamiOverview> {
  const id = websiteId(site);
  const empty: UmamiOverview = {
    site, days, configured: !!id,
    stats: { pageviews: 0, visitors: 0, visits: 0 },
    topEvents: [], series: [], totalEvents: 0, eventSeries: [], properties: [],
  };
  if (!id) return empty; // that site has no website id configured → render an empty, clearly-unconfigured view

  const endAt = Date.now();
  const startAt = endAt - days * 86_400_000;
  const unit = days <= 2 ? "hour" : "day";
  const range = { startAt, endAt };

  const [stats, events, pageviews, edStats, evSeries, edFields] = await Promise.all([
    umamiGet(`${id}/stats`, range) as Promise<Record<string, unknown>>,
    umamiGet(`${id}/metrics`, { ...range, type: "event", limit: 10 }) as Promise<{ x: string; y: number }[]>,
    umamiGet(`${id}/pageviews`, { ...range, unit, timezone: "UTC" }) as Promise<{
      pageviews: { x: string; y: number }[];
      sessions: { x: string; y: number }[];
    }>,
    // Event-centric extras (best-effort — Umami v2 event-data endpoints):
    umamiGetSafe(`${id}/event-data/stats`, range) as Promise<{ events?: number } | null>,
    umamiGetSafe(`${id}/events/series`, { ...range, unit, timezone: "UTC" }) as Promise<{ x: string; t: string; y: number }[] | null>,
    umamiGetSafe(`${id}/event-data/fields`, range) as Promise<{ propertyName: string; value: unknown; total: number }[] | null>,
  ]);

  const sessionsByX = new Map((pageviews.sessions ?? []).map((p) => [p.x, p.y]));

  // events/series gives per-(eventName, bucket) rows — sum across event names per time bucket.
  const seriesByBucket = new Map<string, number>();
  for (const r of evSeries ?? []) seriesByBucket.set(r.t, (seriesByBucket.get(r.t) ?? 0) + r.y);
  const eventSeries = [...seriesByBucket.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, count]) => ({ date, count }));

  // Group event-data fields by property; drop identifier-ish props (…Id — high-cardinality, not a
  // useful breakdown) and cap the values shown per property / properties shown.
  const byProp = new Map<string, { value: string; count: number }[]>();
  for (const f of edFields ?? []) {
    if (/id$/i.test(f.propertyName)) continue;
    const list = byProp.get(f.propertyName) ?? [];
    list.push({ value: String(f.value), count: f.total });
    byProp.set(f.propertyName, list);
  }
  const properties = [...byProp.entries()]
    .map(([name, values]) => ({ name, values: values.sort((a, b) => b.count - a.count).slice(0, 8) }))
    .sort((a, b) => total(b.values) - total(a.values))
    .slice(0, 8);

  return {
    site, days, configured: true,
    stats: { pageviews: num(stats.pageviews), visitors: num(stats.visitors), visits: num(stats.visits) },
    topEvents: (events ?? []).map((e) => ({ name: e.x, count: e.y })),
    series: (pageviews.pageviews ?? []).map((p) => ({ date: p.x, pageviews: p.y, sessions: sessionsByX.get(p.x) ?? 0 })),
    totalEvents: Number(edStats?.events ?? 0) || 0,
    eventSeries,
    properties,
  };
}

const total = (values: { count: number }[]): number => values.reduce((s, v) => s + v.count, 0);
