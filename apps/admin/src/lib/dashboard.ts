// Dashboard metrics: one role-scoped aggregate (project counts + app metering + the one Supabase
// figure we can authoritatively read) from GET /admin/dashboard/metrics. Egress + Auth MAU are NOT
// here — the Supabase Management API doesn't expose them, so those cards are gone, not faked.
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
  supabaseMetrics: {
    // Whole-instance Postgres size. null for non-operators (instance-wide infra figure) or if the
    // query failed. Egress + Auth MAU are deliberately omitted — not exposed by the Management API.
    databaseSizeBytes: number | null;
  };
}

export function getDashboardMetrics(signal?: AbortSignal): Promise<DashboardMetrics> {
  return api<DashboardMetrics>("/admin/dashboard/metrics", { signal });
}
