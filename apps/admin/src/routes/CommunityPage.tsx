// Project-admin community-health pulse. Reads the hourly rollup (GET /admin/community/overview) and
// renders: pulse cards (all-time totals + 24h deltas), per-day growth charts (the hourly series
// bucketed by day), leaderboards (top posters/commenters/reactors by activity volume in the window,
// reputation shown alongside), top posts (ranked by reactions+replies, deep-linked into the demo app),
// and moderation pressure (reports opened vs resolved + the live open count). Degrades to a friendly
// empty state until the first rollup cron has run.
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, BarChart3, FileText, Flag, Heart, Inbox, MessageSquare, PenLine, RefreshCw, ThumbsUp,
  TrendingUp, Trophy, UserPlus, Users, type LucideIcon,
} from "lucide-react";
import type { User } from "@agora-server/contract";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/ui/PageHeader";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingPanel, Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { DEMO_URL, SOCIAL_GRAPH_ENABLED } from "../config";
import {
  getCommunityOverview, communityOverviewKey, recomputeCommunityStats,
  getSocialWeather, socialWeatherKey,
  type CommunityOverview, type CommunityLeader, type CommunitySeriesPoint,
  type SocialWeather, type WeatherBand,
} from "../lib/community";

const RANGES = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
];

const fmtNum = (n: number) => n.toLocaleString();

export function CommunityPage() {
  const { isProjectAdmin } = useAuth();
  const [days, setDays] = useState(30);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: communityOverviewKey(days),
    queryFn: ({ signal }) => getCommunityOverview(days, signal),
    staleTime: 60_000,
    retry: false,
    enabled: isProjectAdmin,
  });

  return (
    <>
      <PageHeader
        title="Community"
        description="The pulse of your community — growth, who's driving it, and what's resonating, over your selected window."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented options={RANGES} value={days} onChange={setDays} />
        {data?.snapshotAt ? (
          <span className="text-xs text-faint">Leaderboards as of {fmtDateTime(data.snapshotAt)}</span>
        ) : null}
      </div>

      {!isProjectAdmin ? (
        <Card className="p-5"><p className="text-sm text-muted">Project admin access is required to view community analytics.</p></Card>
      ) : isLoading ? (
        <LoadingPanel label="Loading community pulse…" />
      ) : isError ? (
        <Card className="p-5"><p className="text-sm text-danger">Couldn’t load community pulse: {(error as Error)?.message ?? "unknown error"}</p></Card>
      ) : !data!.configured ? (
        <EmptyState
          icon={Inbox}
          title="No community stats yet"
          description="They're normally built hourly by the community-stats rollup — compute them now to see the pulse right away."
          action={<RecomputeCommunityButton days={days} />}
        />
      ) : (
        <CommunityBody data={data!} days={days} />
      )}
    </>
  );
}

// Project-admin-forced synchronous rollup of this project's community stats (POST
// /admin/community/recompute), then refetches the overview so the page populates immediately.
function RecomputeCommunityButton({ days }: { days: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: recomputeCommunityStats,
    onSuccess: async () => {
      toast({ title: "Community stats computed", variant: "success" });
      await qc.invalidateQueries({ queryKey: communityOverviewKey(days) });
    },
    onError: (e) =>
      toast({
        title: "Compute failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });
  return (
    <Button variant="outline" size="sm" disabled={m.isPending} onClick={() => m.mutate()}>
      {m.isPending ? <Spinner /> : <RefreshCw />}
      {m.isPending ? "Computing…" : "Compute now"}
    </Button>
  );
}

function CommunityBody({ data, days }: { data: CommunityOverview; days: number }) {
  const d = data.deltas24h;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <PulseCard label="Members" value={data.totals.users} delta={d?.users ?? null} icon={Users} />
        <PulseCard label="Posts" value={data.totals.posts} delta={d?.posts ?? null} icon={FileText} />
        <PulseCard label="Comments" value={data.totals.comments} delta={d?.comments ?? null} icon={MessageSquare} />
        <PulseCard label="Reactions" value={data.totals.reactions} delta={d?.reactions ?? null} icon={Heart} />
      </div>

      {SOCIAL_GRAPH_ENABLED && <WeatherSection />}

      <Section title="Growth" hint={`Per day, over the last ${days} days`}>
        <div className="grid gap-4 lg:grid-cols-2">
          <BarSeries title="New posts" icon={TrendingUp} series={data.series} pick={(p) => p.newPosts} unit="posts" />
          <BarSeries title="New comments" icon={MessageSquare} series={data.series} pick={(p) => p.newComments} unit="comments" />
          <BarSeries title="New reactions" icon={Heart} series={data.series} pick={(p) => p.newReactions} unit="reactions" />
          <BarSeries title="New members" icon={UserPlus} series={data.series} pick={(p) => p.newUsers} unit="members" />
        </div>
      </Section>

      <Section title="Leaderboards" hint="Top contributors by activity in the window">
        <div className="grid gap-4 lg:grid-cols-3">
          <Leaderboard title="Top posters" icon={Trophy} rows={data.leaderboards.posters} unit="posts" />
          <Leaderboard title="Top commenters" icon={PenLine} rows={data.leaderboards.commenters} unit="comments" />
          <Leaderboard title="Top reactors" icon={ThumbsUp} rows={data.leaderboards.reactors} unit="reactions" />
        </div>
      </Section>

      <Section title="Top posts" hint="Ranked by reactions + replies in the window">
        <TopPosts posts={data.topPosts} />
      </Section>

      <Section
        title="Moderation pressure"
        hint="Reports opened vs resolved, per day"
        badge={<Badge variant={data.moderation.openNow > 0 ? "warning" : "success"}>{fmtNum(data.moderation.openNow)} open</Badge>}
      >
        <ModerationChart series={data.moderation.series} days={days} />
      </Section>
    </>
  );
}

// ── Pulse card: an all-time total with its trailing-24h delta. ──
function PulseCard({ label, value, delta, icon: Icon }: { label: string; value: number; delta: number | null; icon: LucideIcon }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        <Icon className="size-4 shrink-0 text-faint" />
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-fg">{fmtNum(value)}</p>
      <p className="mt-1 text-sm">
        <Delta n={delta} /> <span className="text-faint">last 24h</span>
      </p>
    </Card>
  );
}

function Delta({ n }: { n: number | null }) {
  if (n == null) return <span className="text-faint">—</span>;
  if (n === 0) return <span className="text-faint">±0</span>;
  const up = n > 0;
  return <span className={up ? "text-success" : "text-danger"}>{up ? "▲ +" : "▼ "}{fmtNum(n)}</span>;
}

// ── Daily bar chart: buckets the hourly series by calendar day and plots one bar per day. ──
function BarSeries({
  title, icon: Icon, series, pick, unit,
}: { title: string; icon: LucideIcon; series: CommunitySeriesPoint[]; pick: (p: CommunitySeriesPoint) => number; unit: string }) {
  const data = bucketByDay(series, pick);
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
        </div>
        <span className="text-xs text-faint">{fmtNum(total)} total</span>
      </div>
      {data.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No activity in this window.</p>
      ) : (
        <div className="mt-4 flex h-40 items-end gap-1">
          {data.map((d) => (
            <div key={d.date} className="group flex min-w-0 flex-1 flex-col items-center justify-end">
              <div
                className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                style={{ height: `${(d.value / max) * 100}%` }}
                title={`${dayLabel(d.date)}: ${d.value} ${unit}`}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Leaderboard: avatar + name, a volume bar, and the contributor's all-time reputation. ──
function Leaderboard({ title, icon: Icon, rows, unit }: { title: string; icon: LucideIcon; rows: CommunityLeader[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No activity in this window.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((r, i) => (
            <li key={r.user.id} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-faint">{i + 1}</span>
                <Avatar user={r.user} />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{userLabel(r.user)}</span>
                <span className="shrink-0 text-xs text-faint">{fmtNum(r.user.reputation)} rep</span>
                <span className="w-10 shrink-0 text-right text-sm tabular-nums text-muted">{fmtNum(r.count)}</span>
              </div>
              <div className="ml-6 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-primary/70" style={{ width: `${(r.count / max) * 100}%` }} title={`${r.count} ${unit}`} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TopPosts({ posts }: { posts: CommunityOverview["topPosts"] }) {
  if (posts.length === 0) return <Card className="p-5"><p className="text-sm text-faint">No posts in this window.</p></Card>;
  return (
    <Card className="divide-y divide-border p-0">
      {posts.map((p, i) => {
        const link = demoEntityLink(p.entity.id);
        const title = p.entity.title?.trim() || "Untitled post";
        return (
          <div key={p.entity.id} className="flex items-center gap-3 px-5 py-3">
            <span className="w-5 shrink-0 text-right text-sm tabular-nums text-faint">{i + 1}</span>
            <div className="min-w-0 flex-1">
              {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="truncate text-sm font-medium text-fg hover:text-primary hover:underline">
                  {title}
                </a>
              ) : (
                <span className="truncate text-sm font-medium text-fg">{title}</span>
              )}
              <p className="text-xs text-faint">{fmtDate(p.entity.createdAt)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
              <span className="inline-flex items-center gap-1"><Heart className="size-3.5" />{fmtNum(p.reactions)}</span>
              <span className="inline-flex items-center gap-1"><MessageSquare className="size-3.5" />{fmtNum(p.replies)}</span>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// ── Moderation pressure: opened (primary) vs resolved (faint) bars per day. ──
function ModerationChart({ series, days }: { series: { hour: string; opened: number; resolved: number }[]; days: number }) {
  const opened = bucketByDay(series, (p) => p.opened);
  const resolved = bucketByDay(series, (p) => p.resolved);
  const resolvedByDate = new Map(resolved.map((d) => [d.date, d.value]));
  const max = Math.max(1, ...opened.map((d) => d.value), ...resolved.map((d) => d.value));
  const totalOpened = opened.reduce((s, d) => s + d.value, 0);
  const totalResolved = resolved.reduce((s, d) => s + d.value, 0);
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Flag className="size-4 text-primary" />
          <h3 className="text-sm font-semibold text-fg">Reports per day</h3>
        </div>
        <span className="text-xs text-faint">{fmtNum(totalOpened)} opened · {fmtNum(totalResolved)} resolved over {days}d</span>
      </div>
      {opened.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No reports in this window.</p>
      ) : (
        <>
          <div className="mt-4 flex h-32 items-end gap-1">
            {opened.map((d) => (
              <div key={d.date} className="group flex min-w-0 flex-1 items-end justify-center gap-0.5">
                <div className="w-1/2 rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                  style={{ height: `${(d.value / max) * 100}%` }} title={`${dayLabel(d.date)}: ${d.value} opened`} />
                <div className="w-1/2 rounded-t bg-faint/50 transition-colors group-hover:bg-faint"
                  style={{ height: `${((resolvedByDate.get(d.date) ?? 0) / max) * 100}%` }} title={`${dayLabel(d.date)}: ${resolvedByDate.get(d.date) ?? 0} resolved`} />
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-faint">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary/70" /> Opened</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-faint/50" /> Resolved</span>
          </div>
        </>
      )}
    </Card>
  );
}

// ── Community Weather: the social graph's aggregate warmth (GET /social/weather). Disabled config
// surfaces as a 400 and an unconfigured graph as a 503 — both render as a quiet muted note rather
// than an error state, since either is a legitimate deployment choice. ──
const BAND_META: Record<WeatherBand, { emoji: string; label: string }> = {
  sunny: { emoji: "☀️", label: "Sunny" },
  fine: { emoji: "🌤️", label: "Fine" },
  overcast: { emoji: "☁️", label: "Overcast" },
  stormy: { emoji: "⛈️", label: "Stormy" },
  quiet: { emoji: "🌫️", label: "Quiet" },
};

function WeatherSection() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: socialWeatherKey,
    queryFn: ({ signal }) => getSocialWeather(signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <Section title="Community Weather" hint="Aggregate warmth from the social graph — decayed, anonymous, k-safe by construction">
      <Card className="p-5">
        {isLoading ? (
          <p className="text-sm text-faint">Reading the sky…</p>
        ) : isError ? (
          <p className="text-sm text-muted">{(error as Error)?.message ?? "Weather unavailable"}</p>
        ) : (
          <WeatherReading w={data!} />
        )}
      </Card>
    </Section>
  );
}

function WeatherReading({ w }: { w: SocialWeather }) {
  const meta = BAND_META[w.band];
  return (
    <div className="flex items-center gap-4">
      <span className="text-4xl" role="img" aria-label={meta.label}>{meta.emoji}</span>
      <div>
        <p className="text-2xl font-semibold tracking-tight text-fg">
          {meta.label}
          {w.value != null ? <span className="ml-2 text-base font-normal text-muted">warmth {Math.round(w.value * 100)}%</span> : null}
        </p>
        <p className="mt-0.5 text-sm">
          {w.value == null ? (
            <span className="text-faint">No interactions in the graph yet.</span>
          ) : (
            <><TrendDelta n={w.trend} /> <span className="text-faint">vs last week · as of {fmtDateTime(w.asOf)}</span></>
          )}
        </p>
      </div>
    </div>
  );
}

function TrendDelta({ n }: { n: number | null }) {
  if (n == null) return <span className="text-faint">—</span>;
  const pts = Math.round(Math.abs(n) * 100);
  if (pts === 0) return <span className="text-faint">steady</span>;
  return n > 0
    ? <span className="text-success">▲ +{pts} pts</span>
    : <span className="text-danger">▼ −{pts} pts</span>;
}

// ── small shared pieces ──────────────────────────────────────────────────────
function Avatar({ user }: { user: User }) {
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

function Segmented<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            o.value === value ? "bg-primary/15 text-primary" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
// Bucket the hourly series into calendar-day totals (UTC). Keeps charts legible across long windows.
function bucketByDay(series: { hour: string }[], pick: (p: any) => number): { date: string; value: number }[] {
  const m = new Map<string, number>();
  for (const p of series) {
    const date = p.hour.slice(0, 10); // YYYY-MM-DD
    m.set(date, (m.get(date) ?? 0) + pick(p));
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

function userLabel(u: User): string {
  if (u.username) return `@${u.username}`;
  return u.name || "—";
}

function demoEntityLink(entityId: string): string | null {
  try {
    const u = new URL(DEMO_URL);
    u.searchParams.set("entity", entityId);
    return u.toString();
  } catch {
    return null;
  }
}

function dayLabel(date: string): string {
  const t = new Date(date);
  return Number.isNaN(t.getTime()) ? date : `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
}
function fmtDate(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleDateString();
}
function fmtDateTime(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}
