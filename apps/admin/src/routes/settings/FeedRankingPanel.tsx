// Feed-ranking config — the first Settings slice. Reads GET /settings/feed and PATCHes changes.
// Project-admin only on the server (403 otherwise → surfaced as an error card).
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input, Label } from "../../components/ui/Input";
import { LoadingPanel } from "../../components/ui/Spinner";
import { UnsavedBanner } from "../../components/ui/UnsavedBanner";
import { useToast } from "../../components/ui/Toast";
import { SETTINGS_READ_ONLY } from "../../config";
import { ApiError } from "../../lib/api";
import { isDirty } from "../../lib/dirty";
import {
  getFeedConfig, updateFeedConfig, FEED_ALGORITHMS, REACTION_TYPES,
  type FeedConfigView, type FeedConfigPatch,
} from "../../lib/settings";

const selectCls =
  "h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none transition-colors " +
  "hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/30";

// Which algorithm each tunable feeds — shown as a hint so operators know what they're turning.
const TUNABLES = [
  { key: "halfLifeHours", label: "Half-life (hours)", hint: "decay", min: 0.1, max: 8760, step: 0.5 },
  { key: "gravity", label: "Gravity", hint: "gravity", min: 0.1, max: 5, step: 0.1 },
  { key: "z", label: "z-score", hint: "wilson confidence", min: 0, max: 10, step: 0.1 },
  { key: "C", label: "Prior count (C)", hint: "bayesian", min: 0, max: 1_000_000, step: 1 },
  { key: "m", label: "Prior mean (m)", hint: "bayesian", min: 0, max: 1, step: 0.01 },
] as const;

export function FeedRankingPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings", "feed"],
    queryFn: ({ signal }) => getFeedConfig(signal),
    staleTime: 30_000,
  });

  if (isLoading) return <LoadingPanel label="Loading feed settings…" />;
  if (isError) {
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">
          Couldn’t load feed settings: {(error as Error)?.message ?? "unknown error"}
        </p>
        <p className="mt-1 text-xs text-faint">Feed config is project-admin only.</p>
      </Card>
    );
  }
  return <FeedForm initial={data!} />;
}

interface FormState {
  defaultAlgorithm: string;
  decayMode: "stored" | "query-time";
  halfLifeHours: number; gravity: number; z: number; C: number; m: number;
  weights: Record<string, number>;
  diversityEnabled: boolean;
  perAuthorCap: number;
  rerankEnabled: boolean;
  rerankUrl: string;
  rerankSecret: string; // write-only; blank = unchanged
  rerankHasSecret: boolean;
  rerankTimeoutMs: number;
  rerankOverFetch: number;
}

function toState(c: FeedConfigView): FormState {
  return {
    defaultAlgorithm: c.defaultAlgorithm,
    decayMode: c.decayMode,
    halfLifeHours: c.params.halfLifeHours, gravity: c.params.gravity,
    z: c.params.z, C: c.params.C, m: c.params.m,
    weights: Object.fromEntries(REACTION_TYPES.map((r) => [r, c.weights[r] ?? 1])),
    diversityEnabled: !!c.diversity,
    perAuthorCap: c.diversity?.perAuthorCap ?? 3,
    rerankEnabled: !!c.rerankWebhook,
    rerankUrl: c.rerankWebhook?.url ?? "",
    rerankSecret: "",
    rerankHasSecret: !!c.rerankWebhook?.hasSecret,
    rerankTimeoutMs: c.rerankWebhook?.timeoutMs ?? 4000,
    rerankOverFetch: c.rerankWebhook?.overFetch ?? 3,
  };
}

function FeedForm({ initial }: { initial: FeedConfigView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState<FormState>(() => toState(initial));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((p) => ({ ...p, [k]: v }));
  const hadWebhook = !!initial.rerankWebhook;

  // Dirty = current form differs from the saved baseline. `toState` blanks the write-only secret in
  // both, so it only trips when the operator actually re-enters one. onSuccess re-syncs `s` to the
  // server's resolved view, so the banner clears after a save.
  const baseline = useMemo(() => toState(initial), [initial]);
  const dirty = isDirty(s, baseline);

  const mutation = useMutation({
    mutationFn: (patch: FeedConfigPatch) => updateFeedConfig(patch),
    onSuccess: (view) => {
      setS(toState(view)); // re-sync (clears the secret field, reflects server's resolved values)
      qc.setQueryData(["settings", "feed"], view);
      toast({ title: "Feed settings saved", variant: "success" });
    },
    onError: (e) =>
      toast({
        title: "Save failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (SETTINGS_READ_ONLY) return;
    const patch: FeedConfigPatch = {
      defaultAlgorithm: s.defaultAlgorithm,
      decayMode: s.decayMode,
      halfLifeHours: s.halfLifeHours, gravity: s.gravity, z: s.z, C: s.C, m: s.m,
      reactionWeights: s.weights,
      diversity: s.diversityEnabled ? { perAuthorCap: s.perAuthorCap } : null,
    };
    // Re-rank webhook: a PATCH replaces the whole object, so only send it when we have a secret
    // (new or re-entered) — otherwise we'd wipe the stored secret. Disabling sends null.
    if (!s.rerankEnabled) {
      if (hadWebhook) patch.rerankWebhook = null;
    } else if (s.rerankSecret.trim() && s.rerankUrl.trim()) {
      patch.rerankWebhook = {
        url: s.rerankUrl.trim(), secret: s.rerankSecret,
        timeoutMs: s.rerankTimeoutMs, overFetch: s.rerankOverFetch,
      };
    }
    mutation.mutate(patch);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {dirty && !SETTINGS_READ_ONLY && <UnsavedBanner />}
      {/* Ranking */}
      <Card>
        <CardHeader>
          <CardTitle>Ranking</CardTitle>
          <CardDescription>The algorithm used when a feed request omits <code>sortBy</code>.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Default algorithm">
            <select className={selectCls} value={s.defaultAlgorithm} onChange={(e) => set("defaultAlgorithm", e.target.value)}>
              {FEED_ALGORITHMS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Decay mode" hint="query-time = live against now(); stored = cron-snapshotted score">
            <select className={selectCls} value={s.decayMode} onChange={(e) => set("decayMode", e.target.value as FormState["decayMode"])}>
              <option value="query-time">query-time</option>
              <option value="stored">stored</option>
            </select>
          </Field>
        </CardContent>
      </Card>

      {/* Tunables */}
      <Card>
        <CardHeader>
          <CardTitle>Tunables</CardTitle>
          <CardDescription>Numeric knobs per algorithm. Per-request <code>rankParams</code> override these.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TUNABLES.map((t) => (
            <Field key={t.key} label={t.label} hint={`affects: ${t.hint}`}>
              <Input
                type="number" min={t.min} max={t.max} step={t.step}
                value={Number.isFinite(s[t.key]) ? s[t.key] : ""}
                onChange={(e) => set(t.key, Number(e.target.value))}
              />
            </Field>
          ))}
        </CardContent>
      </Card>

      {/* Reaction weights */}
      <Card>
        <CardHeader>
          <CardTitle>Reaction weights</CardTitle>
          <CardDescription>Per-reaction vote weight (0–100) for net-vote algorithms (top, controversial, wilson, bayesian).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 grid-cols-2 sm:grid-cols-4">
          {REACTION_TYPES.map((r) => (
            <Field key={r} label={r}>
              <Input
                type="number" min={0} max={100} step={1}
                value={Number.isFinite(s.weights[r]) ? s.weights[r] : ""}
                onChange={(e) => set("weights", { ...s.weights, [r]: Number(e.target.value) })}
              />
            </Field>
          ))}
        </CardContent>
      </Card>

      {/* Diversity */}
      <Card>
        <CardHeader>
          <CardTitle>Diversity</CardTitle>
          <CardDescription>Cap how many consecutive feed items can share one author.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="size-4 accent-primary" checked={s.diversityEnabled} onChange={(e) => set("diversityEnabled", e.target.checked)} />
            Enable per-author cap
          </label>
          {s.diversityEnabled && (
            <Field label="Max per author (1–50)">
              <Input type="number" min={1} max={50} step={1} value={s.perAuthorCap} onChange={(e) => set("perAuthorCap", Number(e.target.value))} />
            </Field>
          )}
        </CardContent>
      </Card>

      {/* Re-rank webhook */}
      <Card>
        <CardHeader>
          <CardTitle>Re-rank webhook</CardTitle>
          <CardDescription>Escape hatch: with <code>?rerank=true</code>, the candidate pool is POSTed (HMAC-signed) here and reordered. Fail-open.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="size-4 accent-primary" checked={s.rerankEnabled} onChange={(e) => set("rerankEnabled", e.target.checked)} />
            Enable re-rank webhook
          </label>
          {s.rerankEnabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="URL" className="sm:col-span-2">
                <Input type="url" placeholder="https://example.com/rerank" value={s.rerankUrl} onChange={(e) => set("rerankUrl", e.target.value)} />
              </Field>
              <Field
                label="Secret"
                className="sm:col-span-2"
                hint={s.rerankHasSecret ? "Leave blank to keep the current secret; re-enter to apply any change." : "Required — the webhook only activates once a secret is set."}
              >
                <Input type="password" placeholder={s.rerankHasSecret ? "•••••••• (unchanged)" : "shared HMAC secret"} value={s.rerankSecret} onChange={(e) => set("rerankSecret", e.target.value)} />
              </Field>
              <Field label="Timeout (ms)" hint="100–30000">
                <Input type="number" min={100} max={30_000} step={100} value={s.rerankTimeoutMs} onChange={(e) => set("rerankTimeoutMs", Number(e.target.value))} />
              </Field>
              <Field label="Over-fetch ×" hint="1–50 (candidate pool multiplier)">
                <Input type="number" min={1} max={50} step={1} value={s.rerankOverFetch} onChange={(e) => set("rerankOverFetch", Number(e.target.value))} />
              </Field>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {SETTINGS_READ_ONLY ? <span className="text-xs text-faint">View-only — saving disabled</span> : null}
        {mutation.isError ? <span className="text-xs text-danger">Not saved</span> : null}
        <Button type="submit" disabled={mutation.isPending || SETTINGS_READ_ONLY}>
          <Save />
          {mutation.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label className="capitalize">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}
