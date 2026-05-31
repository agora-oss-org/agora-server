import {
  Activity, Boxes, Database, Download, Flag, Gauge, HardDrive, MessageSquare,
  Users, UsersRound, Zap, type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { LoadingPanel } from "../components/ui/Spinner";
import { getDashboardMetrics, type DashboardMetrics } from "../lib/dashboard";

interface Stat {
  label: string;
  value: string;
  description: string;
  icon: LucideIcon;
}

// Human-readable bytes (B → PB). Used for storage + egress cards.
function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const fmtNum = (n: number) => n.toLocaleString();

// ── Our counters: live from the Agora Postgres DB (one scoped aggregate query, role-aware). ──
function projectStats(m: DashboardMetrics["projectMetrics"]): Stat[] {
  return [
    { label: "Open reports", value: fmtNum(m.openReports), description: "Unresolved reports awaiting moderation", icon: Flag },
    { label: "Members", value: fmtNum(m.members), description: "Profiles in your project", icon: UsersRound },
    { label: "Spaces", value: fmtNum(m.spaces), description: "Communities and sub-spaces", icon: Boxes },
    { label: "Entities", value: fmtNum(m.entities), description: "Total entities created or modified", icon: Activity },
    { label: "Comments", value: fmtNum(m.comments), description: "User comments and interactions", icon: MessageSquare },
    { label: "Monthly Active Users", value: fmtNum(m.monthlyActiveUsers), description: "Profiles active this month", icon: Users },
    { label: "Storage Used", value: fmtBytes(m.storageUsedBytes), description: "App files stored (files table)", icon: Database },
  ];
}

// ── App metering: request-level metrics our Hono middleware collects (api_usage). ──
function appStats(m: DashboardMetrics["appMetrics"]): Stat[] {
  return [
    { label: "API Calls", value: fmtNum(m.apiCalls), description: "Total API requests processed this month", icon: Zap },
    { label: "Client Egress", value: fmtBytes(m.clientEgressBytes), description: "Outbound transfer to clients this month", icon: Download },
    { label: "Avg Response Time", value: `${Math.round(m.avgLatencyMs)} ms`, description: "Mean request latency this month", icon: Gauge },
  ];
}

// ── Supabase/infra: the one billing-ish figure the Management API actually exposes is nil, so we
// read whole-instance Postgres size directly. Operator-only (instance-wide, not per-project). Egress
// + Auth MAU are deliberately absent — the Management API doesn't expose them, so we don't fake them.
function supabaseStats(m: DashboardMetrics["supabaseMetrics"]): Stat[] {
  return [
    {
      label: "Database size",
      value: m.databaseSizeBytes == null ? "—" : fmtBytes(m.databaseSizeBytes),
      description: "Total Postgres size across the instance",
      icon: HardDrive,
    },
  ];
}

export function DashboardPage() {
  const { user, isOperator } = useAuth();
  const name = user?.name || user?.username || "there";

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dashboard", "metrics"],
    queryFn: ({ signal }) => getDashboardMetrics(signal),
    staleTime: 30_000,
  });

  return (
    <>
      <PageHeader
        title={`Welcome back, ${name}`}
        description={
          isOperator
            ? "Project-wide overview — you can see and act across the whole deployment."
            : "Overview of the spaces you own or moderate."
        }
      />

      {isLoading ? (
        <LoadingPanel label="Loading metrics…" />
      ) : isError ? (
        <Card className="p-5">
          <p className="text-sm text-danger">Couldn’t load metrics: {(error as Error)?.message ?? "unknown error"}</p>
        </Card>
      ) : (
        <>
          <Section title="Project metrics" hint="Live from your Agora database">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projectStats(data!.projectMetrics).map((s) => (
                <StatCard key={s.label} {...s} />
              ))}
            </div>
          </Section>

          <Section
            title="App metering"
            hint="Request-level metrics from our API"
            badge={<Badge variant="success">Live</Badge>}
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {appStats(data!.appMetrics).map((s) => (
                <StatCard key={s.label} {...s} />
              ))}
            </div>
          </Section>

          {isOperator ? (
            <Section
              title="Supabase usage"
              hint="Read directly from Postgres"
              badge={<Badge variant="success">Live</Badge>}
            >
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {supabaseStats(data!.supabaseMetrics).map((s) => (
                  <StatCard key={s.label} {...s} />
                ))}
              </div>
            </Section>
          ) : null}
        </>
      )}
    </>
  );
}

function Section({ title, hint, badge, children }: { title: string; hint?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {badge}
        {hint ? <span className="text-xs text-faint">· {hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

