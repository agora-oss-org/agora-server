// Dashboard metrics: one role-scoped aggregate (project counts + app metering) from GET
// /admin/dashboard/metrics. Supabase billing figures are NOT here — they come from the
// Management API and stay placeholders for now.
import { api } from "./api";

export interface DashboardMetrics {
  scope: "operator" | "moderator";
  projectMetrics: {
    openReports: number;
    members: number;
    spaces: number;
    entities: number;
    comments: number;
    monthlyActiveUsers: number;
    storageUsedBytes: number;
  };
  appMetrics: {
    apiCalls: number;
    clientEgressBytes: number;
    avgLatencyMs: number;
  };
}

export function getDashboardMetrics(signal?: AbortSignal): Promise<DashboardMetrics> {
  return api<DashboardMetrics>("/admin/dashboard/metrics", { signal });
}
