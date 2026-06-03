// Umami reporting client — reads analytics BACK from Umami for the admin's operator-only Analytics
// page (the counterpart to lib/umami.ts, which only SENDS events). Authenticates with the secret
// AGORA_UMAMI_API_KEY (x-umami-api-key), so this must only ever run server-side behind the operator
// gate — the key must never reach the browser. Returns a shaped overview; throws ApiError on failure.
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
}

// The reporting API lives at AGORA_UMAMI_API_URL when set, else AGORA_UMAMI_URL (the tracker host).
const reportingBase = (): string | undefined => env.AGORA_UMAMI_API_URL ?? env.AGORA_UMAMI_URL;

/** True when the reporting API can be called (a reporting base URL + the secret key are both set). */
export function umamiReportingEnabled(): boolean {
  return !!(reportingBase() && env.AGORA_UMAMI_API_KEY);
}

/** The Umami website id for a logical site, or undefined when that site isn't configured. */
function websiteId(site: UmamiSite): string | undefined {
  return site === "admin" ? env.AGORA_UMAMI_ADMIN_ID : env.AGORA_UMAMI_SERVER_ID;
}

// Umami may return summary metrics as `{ value, prev }` (v2) or a bare number (older) — normalize both.
const num = (v: unknown): number =>
  typeof v === "number" ? v : Number((v as { value?: unknown } | null)?.value ?? 0) || 0;

async function umamiGet(path: string, params: Record<string, string | number>): Promise<unknown> {
  // Concatenate (not `new URL(absolutePath, base)`) so a path-prefixed base (e.g. https://host/umami)
  // is preserved — an absolute path would reset to the host root and drop the /umami mount.
  const base = reportingBase()!.replace(/\/+$/, "");
  const url = new URL(`${base}/api/websites/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { "x-umami-api-key": env.AGORA_UMAMI_API_KEY!, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    logger.warn({ status: res.status, path }, "umami-reporting: upstream error");
    if (res.status === 401 || res.status === 403)
      throw Errors.badRequest("admin/umami-auth", "Umami rejected the API key — check AGORA_UMAMI_API_KEY and that the instance supports API keys");
    throw Errors.badRequest("admin/umami-upstream", `Umami reporting request failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * Fetch a shaped analytics overview for one site over the trailing `days` window: summary stats, the
 * top custom events, and a daily pageviews/sessions series. Operator-gated by the caller.
 */
export async function getOverview(site: UmamiSite, days: number): Promise<UmamiOverview> {
  const id = websiteId(site);
  const empty: UmamiOverview = {
    site, days, configured: !!id,
    stats: { pageviews: 0, visitors: 0, visits: 0 },
    topEvents: [], series: [],
  };
  if (!id) return empty; // that site has no website id configured → render an empty, clearly-unconfigured view

  const endAt = Date.now();
  const startAt = endAt - days * 86_400_000;
  const unit = days <= 2 ? "hour" : "day";
  const range = { startAt, endAt };

  const [stats, events, pageviews] = await Promise.all([
    umamiGet(`${id}/stats`, range) as Promise<Record<string, unknown>>,
    umamiGet(`${id}/metrics`, { ...range, type: "event", limit: 10 }) as Promise<{ x: string; y: number }[]>,
    umamiGet(`${id}/pageviews`, { ...range, unit, timezone: "UTC" }) as Promise<{
      pageviews: { x: string; y: number }[];
      sessions: { x: string; y: number }[];
    }>,
  ]);

  const sessionsByX = new Map((pageviews.sessions ?? []).map((p) => [p.x, p.y]));
  return {
    site, days, configured: true,
    stats: { pageviews: num(stats.pageviews), visitors: num(stats.visitors), visits: num(stats.visits) },
    topEvents: (events ?? []).map((e) => ({ name: e.x, count: e.y })),
    series: (pageviews.pageviews ?? []).map((p) => ({ date: p.x, pageviews: p.y, sessions: sessionsByX.get(p.x) ?? 0 })),
  };
}
