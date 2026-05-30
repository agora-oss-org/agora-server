import {
  Activity, ArrowUpFromLine, Boxes, Database, Download, Flag, Gauge, HardDrive, MessageSquare,
  Users, UsersRound, Zap, type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";

interface Stat {
  label: string;
  value: string;
  description: string;
  icon: LucideIcon;
}

// ── Our counters: live from the Agora Postgres DB (one scoped aggregate query, role-aware). ──
const PROJECT_STATS: Stat[] = [
  { label: "Open reports", value: "—", description: "Unresolved reports awaiting moderation", icon: Flag },
  { label: "Members", value: "—", description: "Profiles in your project", icon: UsersRound },
  { label: "Spaces", value: "—", description: "Communities and sub-spaces", icon: Boxes },
  { label: "Entities", value: "—", description: "Total entities created or modified", icon: Activity },
  { label: "Comments", value: "—", description: "User comments and interactions", icon: MessageSquare },
  { label: "Monthly Active Users", value: "—", description: "Profiles active this month", icon: Users },
  { label: "Storage Used", value: "—", description: "App files stored (files table)", icon: Database },
];

// ── App metering: request-level metrics our own Hono middleware must collect (neither in our DB
//    nor visible to Supabase, since app traffic terminates at our server). Not yet instrumented. ──
const APP_STATS: Stat[] = [
  { label: "API Calls", value: "—", description: "Total API requests processed this month", icon: Zap },
  { label: "Client Egress", value: "—", description: "Outbound transfer to clients this month", icon: ArrowUpFromLine },
  { label: "Avg Response Time", value: "—", description: "Mean request latency this month", icon: Gauge },
];

// ── Supabase counters: account/project billing usage (Management API; not our request traffic). ──
const SUPABASE_STATS: Stat[] = [
  { label: "Storage", value: "—", description: "Database + object storage", icon: HardDrive },
  { label: "Egress", value: "—", description: "Outbound data transfer this month", icon: Download },
  { label: "Monthly Active Users", value: "—", description: "Supabase Auth monthly active users", icon: Users },
];

export function DashboardPage() {
  const { user, isOperator } = useAuth();
  const name = user?.name || user?.username || "there";
  const period = new Date().toLocaleString(undefined, { month: "long", year: "numeric" });

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

      <Section title="Project metrics" hint="Live from your Agora database">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PROJECT_STATS.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>
      </Section>

      <Section
        title="App metering"
        hint="Request-level metrics from our API"
        badge={<Badge variant="warning">Planned</Badge>}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {APP_STATS.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>
      </Section>

      <Section
        title="Supabase usage"
        hint="Account / project billing usage"
        badge={<Badge variant="muted">Management API</Badge>}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SUPABASE_STATS.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>
      </Section>

      <Card className="p-5">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold text-fg">Usage summary</h2>
          <p className="text-sm text-muted">Key insights for {period}</p>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <SummaryPanel label="Activity Level" text="— monthly active users across — spaces." />
          <SummaryPanel label="Resource Usage" text="— of app storage; Supabase reports — egress this month." />
        </div>
      </Card>
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

function SummaryPanel({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1.5 text-sm text-faint">{text}</p>
    </div>
  );
}
