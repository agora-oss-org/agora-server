// Operator-only Umami analytics. Reads a shaped overview back from the API proxy (which holds the
// secret API key) for one of two sites — product usage (server-side events) or the admin app itself —
// and renders summary stats, a daily pageviews series, and the top custom events. Degrades gracefully
// when Umami reporting isn't configured (the proxy answers admin/umami-disabled).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, BarChart3, Eye, Layers, MousePointerClick, Users } from "lucide-react";
import { PageHeader } from "../components/ui/PageHeader";
import { StatCard } from "../components/ui/StatCard";
import { Card } from "../components/ui/Card";
import { LoadingPanel } from "../components/ui/Spinner";
import { cn } from "../lib/cn";
import { ApiError } from "../lib/api";
import { getUmamiOverview, umamiOverviewKey, type UmamiSite } from "../lib/analytics-data";

const SITES: { value: UmamiSite; label: string }[] = [
  { value: "product", label: "Agora server" },
  { value: "admin", label: "Admin app" },
];
const RANGES: { value: number; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
];

const fmtNum = (n: number) => n.toLocaleString();

export function AnalyticsPage() {
  const [site, setSite] = useState<UmamiSite>("product");
  const [days, setDays] = useState(7);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: umamiOverviewKey(site, days),
    queryFn: ({ signal }) => getUmamiOverview(site, days, signal),
    staleTime: 60_000,
    retry: false,
  });

  const disabled = isError && error instanceof ApiError && error.code === "admin/umami-disabled";

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Usage analytics from Umami — server events and the admin app, over your selected window."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented options={SITES} value={site} onChange={setSite} />
        <Segmented options={RANGES} value={days} onChange={setDays} />
      </div>

      {isLoading ? (
        <LoadingPanel label="Loading analytics…" />
      ) : disabled ? (
        <Card className="p-5">
          <p className="text-sm text-muted">
            Umami reporting isn’t configured. Set <code className="text-fg">AGORA_UMAMI_URL</code> and{" "}
            <code className="text-fg">AGORA_UMAMI_API_KEY</code> on the API to enable this page.
          </p>
        </Card>
      ) : isError ? (
        <Card className="p-5">
          <p className="text-sm text-danger">
            Couldn’t load analytics: {(error as Error)?.message ?? "unknown error"}
          </p>
        </Card>
      ) : !data!.configured ? (
        <Card className="p-5">
          <p className="text-sm text-muted">
            No Umami website id is configured for the <strong>{site === "admin" ? "admin app" : "product"}</strong> site
            (<code className="text-fg">{site === "admin" ? "AGORA_UMAMI_ADMIN_ID" : "AGORA_UMAMI_SERVER_ID"}</code>).
          </p>
        </Card>
      ) : site === "product" ? (
        // The Agora server site is events-only (no pageviews/visitors/visits) — show event analytics.
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Total events" value={fmtNum(data!.totalEvents)} description={`Server events in the last ${days} days`} icon={Activity} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <EventsChart series={data!.eventSeries} />
            <TopEvents events={data!.topEvents} />
          </div>
          {data!.properties.length > 0 ? <PropertyBreakdowns properties={data!.properties} /> : null}
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Pageviews" value={fmtNum(data!.stats.pageviews)} description={`Over the last ${days} days`} icon={Eye} />
            <StatCard label="Visitors" value={fmtNum(data!.stats.visitors)} description="Unique visitors in window" icon={Users} />
            <StatCard label="Visits" value={fmtNum(data!.stats.visits)} description="Sessions in window" icon={MousePointerClick} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <SeriesChart series={data!.series} />
            <TopEvents events={data!.topEvents} />
          </div>
        </>
      )}
    </>
  );
}

function Segmented<T extends string | number>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
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

function SeriesChart({ series }: { series: { date: string; pageviews: number; sessions: number }[] }) {
  const max = Math.max(1, ...series.map((d) => d.pageviews));
  const label = (d: string) => {
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? d.slice(5, 10) : `${t.getMonth() + 1}/${t.getDate()}`;
  };
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5">
        <BarChart3 className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-fg">Pageviews over time</h3>
      </div>
      {series.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No data in this window.</p>
      ) : (
        <div className="mt-4 flex h-40 items-end gap-1">
          {series.map((d, i) => (
            <div key={i} className="group flex min-w-0 flex-1 flex-col items-center justify-end">
              <div
                className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                style={{ height: `${(d.pageviews / max) * 100}%` }}
                title={`${label(d.date)}: ${d.pageviews} pageviews · ${d.sessions} sessions`}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EventsChart({ series }: { series: { date: string; count: number }[] }) {
  const max = Math.max(1, ...series.map((d) => d.count));
  const label = (d: string) => {
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? d.slice(5, 10) : `${t.getMonth() + 1}/${t.getDate()}`;
  };
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5">
        <BarChart3 className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-fg">Events over time</h3>
      </div>
      {series.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No events in this window.</p>
      ) : (
        <div className="mt-4 flex h-40 items-end gap-1">
          {series.map((d, i) => (
            <div key={i} className="group flex min-w-0 flex-1 flex-col items-center justify-end">
              <div
                className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                style={{ height: `${(d.count / max) * 100}%` }}
                title={`${label(d.date)}: ${d.count} events`}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PropertyBreakdowns({ properties }: { properties: { name: string; values: { value: string; count: number }[] }[] }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5">
        <Layers className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-fg">Event properties</h3>
      </div>
      <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {properties.map((p) => {
          const max = Math.max(1, ...p.values.map((v) => v.count));
          return (
            <div key={p.name} className="space-y-2">
              <p className="font-mono text-xs font-medium text-muted">{p.name}</p>
              <ul className="space-y-1.5">
                {p.values.map((v) => (
                  <li key={v.value} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-xs text-fg">{v.value}</span>
                      <span className="shrink-0 text-muted">{fmtNum(v.count)}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${(v.count / max) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TopEvents({ events }: { events: { name: string; count: number }[] }) {
  const max = Math.max(1, ...events.map((e) => e.count));
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5">
        <MousePointerClick className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-fg">Top events</h3>
      </div>
      {events.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No custom events tracked in this window.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {events.map((e) => (
            <li key={e.name} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate font-mono text-xs text-fg">{e.name}</span>
                <span className="shrink-0 text-muted">{fmtNum(e.count)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-primary/70" style={{ width: `${(e.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
