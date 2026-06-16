// Operator-only social-analytics dashboards (corporate tier) — the admin UI for the PR-6 reports.
// One tabbed page over GET /admin/social/{influence,silos,engagement}; each tab owns its query and a
// per-report "Recompute" button that POSTs /admin/social/recompute and seeds the cache with the fresh
// snapshot. Reports serve the LATEST weekly snapshot (no range param); `asOf:null` is the not-yet-
// materialized sentinel. State matrix per tab: loading → corporate-tier-required (400 *-disabled) →
// graph-unavailable (503) → error → no-snapshot (EmptyState + recompute) → data. Unlike the member
// Garden these NAME real people — the operator is the accountable employer (docs/AGORA-CORP.md §4).
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Activity, Crown, Inbox, Network, RefreshCw, Share2, TrendingUp, Users } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/ui/PageHeader";
import { Card } from "../components/ui/Card";
import { Badge, type BadgeProps } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingPanel, Spinner } from "../components/ui/Spinner";
import { Table, THead, TBody, Tr, Th, Td } from "../components/ui/Table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/Tabs";
import { useToast } from "../components/ui/Toast";
import { ApiError } from "../lib/api";
import {
  getInfluence, getSilos, getEngagement, recomputeAnalytics,
  socialInfluenceKey, socialSilosKey, socialEngagementKey,
  type SocialInfluence, type SocialSilos, type SocialEngagement,
  type InfluenceMember, type Silo, type EngagementMember,
  type ChurnRiskBand, type SocialAnalyticsReport,
} from "../lib/social-analytics";

// Per-report display metadata + its query key (used by the recompute mutation to seed the cache).
const REPORT_META: Record<SocialAnalyticsReport, { label: string; flag: string; key: readonly unknown[] }> = {
  influence: { label: "Influence scores", flag: "influence scores", key: socialInfluenceKey },
  silos: { label: "Silo detection", flag: "silo detection", key: socialSilosKey },
  engagement: { label: "Engagement scores", flag: "engagement scores", key: socialEngagementKey },
};

export function SocialAnalyticsPage() {
  const { isOperator } = useAuth();

  return (
    <>
      <PageHeader
        title="Social analytics"
        description="Operator-only network analytics — informal leaders, silos, and engagement. Corporate tier only; these reports name real people and are disclosed to members via the transparency endpoint."
      />

      {!isOperator ? (
        <Card className="p-5">
          <p className="text-sm text-muted">Operator access is required to view social analytics.</p>
        </Card>
      ) : (
        <Tabs defaultValue="influence" className="space-y-4">
          <TabsList>
            <TabsTrigger value="influence"><TrendingUp className="size-4" /> Influence</TabsTrigger>
            <TabsTrigger value="silos"><Network className="size-4" /> Silos</TabsTrigger>
            <TabsTrigger value="engagement"><Activity className="size-4" /> Engagement</TabsTrigger>
          </TabsList>
          <TabsContent value="influence"><InfluenceTab /></TabsContent>
          <TabsContent value="silos"><SilosTab /></TabsContent>
          <TabsContent value="engagement"><EngagementTab /></TabsContent>
        </Tabs>
      )}
    </>
  );
}

// ── Tabs: each owns its query (operator-gated, no retry, 1-min stale) and delegates state to ReportShell ──
function InfluenceTab() {
  const { isOperator } = useAuth();
  const query = useQuery({
    queryKey: socialInfluenceKey,
    queryFn: ({ signal }) => getInfluence(signal),
    staleTime: 60_000, retry: false, enabled: isOperator,
  });
  return (
    <ReportShell report="influence" query={query} isEmpty={(d) => d.leaders.length === 0 && d.bridges.length === 0}>
      {(d) => <InfluenceReport data={d} />}
    </ReportShell>
  );
}

function SilosTab() {
  const { isOperator } = useAuth();
  const query = useQuery({
    queryKey: socialSilosKey,
    queryFn: ({ signal }) => getSilos(signal),
    staleTime: 60_000, retry: false, enabled: isOperator,
  });
  return (
    <ReportShell report="silos" query={query} isEmpty={(d) => d.silos.length === 0}>
      {(d) => <SilosReport data={d} />}
    </ReportShell>
  );
}

function EngagementTab() {
  const { isOperator } = useAuth();
  const query = useQuery({
    queryKey: socialEngagementKey,
    queryFn: ({ signal }) => getEngagement(signal),
    staleTime: 60_000, retry: false, enabled: isOperator,
  });
  return (
    <ReportShell report="engagement" query={query} isEmpty={(d) => d.members.length === 0}>
      {(d) => <EngagementReport data={d} />}
    </ReportShell>
  );
}

// ── Shared state matrix: loading / disabled / unavailable / error / empty / data ──
function ReportShell<T extends { asOf: string | null }>({
  report, query, isEmpty, children,
}: {
  report: SocialAnalyticsReport;
  query: UseQueryResult<T>;
  isEmpty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  const { data, isLoading, isError, error } = query;

  if (isLoading) return <LoadingPanel label={`Loading ${REPORT_META[report].label.toLowerCase()}…`} />;
  if (isError) return <ReportError error={error} report={report} />;

  const d = data!;
  if (d.asOf === null || isEmpty(d)) {
    return (
      <EmptyState
        icon={Inbox}
        title="No snapshot yet"
        description="These analytics materialize weekly — or recompute now to build them on demand. The first run can take a while on a large graph."
        action={<RecomputeButton report={report} />}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-faint">As of {fmtDateTime(d.asOf)}</span>
        <RecomputeButton report={report} />
      </div>
      {children(d)}
    </div>
  );
}

function ReportError({ error, report }: { error: unknown; report: SocialAnalyticsReport }) {
  const code = error instanceof ApiError ? error.code : "";

  // Corporate-tier gate (400 social/<report>-disabled): a deliberate config choice, not a failure.
  if (code.endsWith("-disabled")) {
    const meta = REPORT_META[report];
    return (
      <Card className="p-6">
        <div className="flex flex-col items-start gap-3">
          <Badge variant="warning">Corporate tier required</Badge>
          <p className="max-w-prose text-sm text-muted">
            {meta.label} are a corporate-tier analytic. Switch this project to the corporate privacy tier
            and enable <span className="text-fg">{meta.flag}</span> to populate this report.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings">Open Settings → Social graph</Link>
          </Button>
        </div>
      </Card>
    );
  }

  // Graph backend absent (503): also a legitimate deployment state, rendered as a quiet note.
  if (code === "social/graph-unavailable") {
    return (
      <Card className="p-5">
        <p className="text-sm text-muted">
          The social graph backend (Neo4j) isn’t configured for this deployment, so analytics can’t be computed.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <p className="text-sm text-danger">
        Couldn’t load this report: {(error as Error)?.message ?? "unknown error"}
      </p>
    </Card>
  );
}

// Operator-forced synchronous recompute of a single report; seeds the cache from the fresh response.
function RecomputeButton({ report }: { report: SocialAnalyticsReport }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => recomputeAnalytics(report),
    onSuccess: (res) => {
      const fresh = res[report];
      if (fresh) qc.setQueryData(REPORT_META[report].key, fresh);
      toast({ title: `${REPORT_META[report].label} recomputed`, variant: "success" });
    },
    onError: (e) =>
      toast({
        title: "Recompute failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });
  return (
    <Button variant="outline" size="sm" disabled={m.isPending} onClick={() => m.mutate()}>
      {m.isPending ? <Spinner /> : <RefreshCw />}
      {m.isPending ? "Recomputing… (this can take a while)" : "Recompute"}
    </Button>
  );
}

// ── Influence: informal leaders (PageRank) + bridge people (betweenness), side by side. ──
function InfluenceReport({ data }: { data: SocialInfluence }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <RankList
        title="Informal leaders" hint="Highest PageRank — who actually drives the network, regardless of title"
        icon={Crown} rows={data.leaders} primary={(m) => m.pageRank} secondary={(m) => m.betweenness} secondaryLabel="betw"
      />
      <RankList
        title="Bridge people" hint="Highest betweenness — who connects otherwise-separate clusters (and is a single point of failure)"
        icon={Share2} rows={data.bridges} primary={(m) => m.betweenness} secondary={(m) => m.pageRank} secondaryLabel="rank"
      />
    </div>
  );
}

function RankList({
  title, hint, icon: Icon, rows, primary, secondary, secondaryLabel,
}: {
  title: string;
  hint: string;
  icon: typeof Crown;
  rows: InfluenceMember[];
  primary: (m: InfluenceMember) => number;
  secondary: (m: InfluenceMember) => number;
  secondaryLabel: string;
}) {
  const max = Math.max(1e-9, ...rows.map(primary));
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
      </div>
      <p className="mt-0.5 text-xs text-faint">{hint}</p>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No members in this report.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((m, i) => (
            <li key={m.userId} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-faint">{i + 1}</span>
                <Avatar user={m} />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{userLabel(m)}</span>
                <span className="shrink-0 text-xs text-faint">{secondaryLabel} {fmtScore(secondary(m))}</span>
                <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted">{fmtScore(primary(m))}</span>
              </div>
              <div className="ml-6 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-primary/70" style={{ width: `${(primary(m) / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Silos: named Louvain clusters with exact size, dominant spaces, and member roster (operator view, no k-anon). ──
function SilosReport({ data }: { data: SocialSilos }) {
  return (
    <div className="space-y-4">
      {data.silos.map((s, i) => <SiloCard key={s.id} silo={s} index={i} />)}
    </div>
  );
}

function SiloCard({ silo, index }: { silo: Silo; index: number }) {
  const shown = silo.members.slice(0, 8);
  const extra = silo.members.length - shown.length;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          <h3 className="text-sm font-semibold text-fg">Silo {index + 1}</h3>
          <Badge variant="muted">{silo.size} member{silo.size === 1 ? "" : "s"}</Badge>
        </div>
        {silo.spaces.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {silo.spaces.map((sp) => (
              <Badge key={sp.spaceId} variant="info">{sp.name || "Unnamed space"} · {sp.memberCount}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-faint">No dominant space</span>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {shown.map((m) => (
          <span key={m.userId} className="flex items-center gap-1.5">
            <Avatar user={m} />
            <span className="text-sm text-fg">{userLabel(m)}</span>
          </span>
        ))}
        {extra > 0 ? <span className="text-sm text-faint">+{extra} more</span> : null}
      </div>
    </Card>
  );
}

// ── Engagement: per-person warmth received (S_p) + trailing trend + churn-risk band. ──
const CHURN_ORDER: Record<ChurnRiskBand, number> = { "at-risk": 0, watch: 1, none: 2 };
const CHURN_BADGE: Record<ChurnRiskBand, { variant: BadgeProps["variant"]; label: string }> = {
  "at-risk": { variant: "danger", label: "At risk" },
  watch: { variant: "warning", label: "Watch" },
  none: { variant: "muted", label: "Stable" },
};

function EngagementReport({ data }: { data: SocialEngagement }) {
  // Most-concerning first: at-risk → watch → none, then steepest decline (most-negative delta) first.
  const members = [...data.members].sort(
    (a, b) => CHURN_ORDER[a.churnRisk] - CHURN_ORDER[b.churnRisk] || a.delta - b.delta,
  );
  return (
    <Table>
      <THead>
        <Tr>
          <Th>Member</Th>
          <Th className="text-right">Warmth (Sₚ)</Th>
          <Th>Trend</Th>
          <Th className="text-right">Δ</Th>
          <Th>Churn risk</Th>
        </Tr>
      </THead>
      <TBody>
        {members.map((m) => {
          const c = CHURN_BADGE[m.churnRisk];
          return (
            <Tr key={m.userId}>
              <Td>
                <span className="flex items-center gap-2">
                  <Avatar user={m} />
                  <span className="truncate text-sm text-fg">{userLabel(m)}</span>
                </span>
              </Td>
              <Td className="text-right tabular-nums">{Math.round(m.sP * 100)}%</Td>
              <Td><Sparkline series={m.trend} /></Td>
              <Td className="text-right"><DeltaPts n={m.delta} /></Td>
              <Td><Badge variant={c.variant}>{c.label}</Badge></Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

function Sparkline({ series }: { series: number[] }) {
  if (series.length === 0) return <span className="text-xs text-faint">—</span>;
  const max = Math.max(1e-9, ...series);
  return (
    <span
      className="inline-flex h-8 items-end gap-0.5"
      title={series.map((v) => `${Math.round(v * 100)}%`).join(" → ")}
    >
      {series.map((v, i) => (
        <span key={i} className="w-1 rounded-sm bg-primary/60" style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />
      ))}
    </span>
  );
}

// ── small shared pieces (mirrors CommunityPage idioms; typed to the Named subset the reports carry) ──
interface Named { username: string | null; name: string | null; avatar: string | null }

function userLabel(u: Named): string {
  return u.username ? `@${u.username}` : u.name || "—";
}

function Avatar({ user }: { user: Named }) {
  const initial = (user.username || user.name || "?").charAt(0).toUpperCase();
  if (user.avatar) {
    return <img src={user.avatar} alt="" className="size-6 shrink-0 rounded-full object-cover" />;
  }
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-muted">
      {initial}
    </span>
  );
}

function DeltaPts({ n }: { n: number }) {
  const pts = Math.round(n * 100);
  if (pts === 0) return <span className="text-faint">±0</span>;
  return pts > 0
    ? <span className="text-success">▲ +{pts}</span>
    : <span className="text-danger">▼ −{Math.abs(pts)}</span>;
}

function fmtScore(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) >= 100) return Math.round(n).toLocaleString();
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function fmtDateTime(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}
