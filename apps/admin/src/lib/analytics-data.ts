// Operator-only Umami analytics read-back, fetched from the API proxy (GET /admin/umami/overview).
// The proxy holds the secret API key server-side; the browser only ever sees this shaped result.
import { api } from "./api";

export type UmamiSite = "product" | "admin";

export interface UmamiOverview {
  site: UmamiSite;
  days: number;
  configured: boolean;
  stats: { pageviews: number; visitors: number; visits: number };
  topEvents: { name: string; count: number }[];
  series: { date: string; pageviews: number; sessions: number }[];
}

export const umamiOverviewKey = (site: UmamiSite, days: number) => ["umami-overview", site, days] as const;

export function getUmamiOverview(site: UmamiSite, days: number, signal?: AbortSignal): Promise<UmamiOverview> {
  return api<UmamiOverview>("/admin/umami/overview", { query: { site, days }, signal });
}
