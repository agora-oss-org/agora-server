// Social graph settings — the privacy tier and feature flags an operator controls.
// Reads GET /settings/social (returns { stored, effective }), PATCHes /settings/social.
// Only keys whose draft values differ from view.effective are sent (omit = unchanged).
// Five flags are corporate-tier-only; when the tier select is flipped to community, they are
// immediately clamped to false in draft state — mirroring the server's 400 clamp so the form
// never shows a state the server would refuse.
//
// Transparency note: the active privacy tier and enabled analytics are disclosed to members
// via the public /transparency endpoint — analytics are disclosed, never covert.
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NetworkIcon, Save } from "lucide-react";
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
  getSocialConfig, updateSocialConfig, recomputeConstellation,
  type SocialConfigView, type SocialConfigPatch, type ResolvedSocialConfig, type SocialPrivacyTier,
} from "../../lib/settings";
import { clampKFloor, ADAPTIVE_KFLOOR_TIERS } from "../../lib/social-kfloor";

// ── Corporate-tier-only flag keys — disabled + clamped to false when tier = community ──────────────
const CORPORATE_ONLY_FLAGS = [
  "influenceScoresEnabled",
  "siloDetectionEnabled",
  "engagementScoresEnabled",
  "frictionAnalyticsEnabled",
  "readReceiptsAllowed",
] as const satisfies ReadonlyArray<keyof ResolvedSocialConfig>;
type CorporateFlag = (typeof CORPORATE_ONLY_FLAGS)[number];

function clampDraftForTier(
  draft: ResolvedSocialConfig,
  tier: SocialPrivacyTier,
): ResolvedSocialConfig {
  if (tier === "community") {
    return {
      ...draft,
      privacyTier: tier,
      influenceScoresEnabled: false,
      siloDetectionEnabled: false,
      engagementScoresEnabled: false,
      frictionAnalyticsEnabled: false,
      readReceiptsAllowed: false,
    };
  }
  return { ...draft, privacyTier: tier };
}

// ── Select styling (mirrors ModeratorPanel's selectCls) ─────────────────────────────────────────────
const selectCls =
  "h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none transition-colors " +
  "hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/30";

// ── Panel ────────────────────────────────────────────────────────────────────────────────────────────

export function SocialGraphPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings", "social"],
    queryFn: ({ signal }) => getSocialConfig(signal),
    staleTime: 30_000,
  });

  if (isLoading) return <LoadingPanel label="Loading social graph settings…" />;
  if (isError) {
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">
          Couldn't load social graph settings: {(error as Error)?.message ?? "unknown error"}
        </p>
        <p className="mt-1 text-xs text-faint">Social graph config is operator only.</p>
      </Card>
    );
  }

  return <SocialGraphForm view={data!} />;
}

// ── Form ──────────────────────────────────────────────────────────────────────────────────────────────

function SocialGraphForm({ view }: { view: SocialConfigView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<ResolvedSocialConfig>(view.effective);

  // Update a single key in the draft.
  function set<K extends keyof ResolvedSocialConfig>(key: K, value: ResolvedSocialConfig[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // When the tier changes, immediately clamp the draft so corporate-only flags can't remain true.
  function onTierChange(tier: SocialPrivacyTier) {
    setDraft((d) => clampDraftForTier(d, tier));
  }

  const isCommunity = draft.privacyTier === "community";

  // Dirty = draft differs from the saved effective config (the same diff onSubmit sends). onSuccess
  // re-syncs `draft` to next.effective, so the banner clears after a save.
  const dirty = isDirty(draft, view.effective);

  const save = useMutation({
    mutationFn: (patch: SocialConfigPatch) => updateSocialConfig(patch),
    onSuccess: (next) => {
      qc.setQueryData(["settings", "social"], next);
      setDraft(next.effective);
      toast({ title: "Social graph settings saved", variant: "success" });
    },
    onError: (e) =>
      toast({
        title: "Save failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });

  const disabled = save.isPending || SETTINGS_READ_ONLY;

  const recompute = useMutation({
    mutationFn: () => recomputeConstellation(),
    onSuccess: (r) =>
      toast({
        title: r.recomputed
          ? "Constellation recomputed"
          : "Recompute ran — no snapshot produced yet",
        variant: "success",
      }),
    onError: (e) =>
      toast({
        title: "Recompute failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (SETTINGS_READ_ONLY) return;

    // Build a patch containing ONLY keys that differ from view.effective.
    const effective = view.effective;
    const patch: SocialConfigPatch = {};
    for (const _k of Object.keys(draft) as Array<keyof ResolvedSocialConfig>) {
      if (draft[_k] !== effective[_k]) {
        // TypeScript doesn't narrow the generic assign through the loop, so assert.
        (patch as Record<string, unknown>)[_k] = draft[_k];
      }
    }
    // Nothing changed — no-op.
    if (Object.keys(patch).length === 0) {
      toast({ title: "No changes to save", variant: "success" });
      return;
    }
    save.mutate(patch);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {dirty && !SETTINGS_READ_ONLY && <UnsavedBanner />}
      {/* ── Tier + transparency ──────────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <NetworkIcon className="size-4 text-muted" />
            Privacy tier
          </CardTitle>
          <CardDescription>
            The active privacy tier and all enabled analytics are disclosed to members via the public
            transparency endpoint — analytics are disclosed, never covert.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field
            label="Tier"
            hint="Community: member-centric, privacy-first, no operator analytics. Corporate: unlocks operator-facing analytics (influence scores, silo detection, engagement scores, friction analytics, read receipts)."
          >
            <select
              className={selectCls}
              value={draft.privacyTier}
              disabled={disabled}
              onChange={(e) => onTierChange(e.target.value as SocialPrivacyTier)}
            >
              <option value="community">community — member-centric, privacy-first</option>
              <option value="corporate">corporate — operator analytics unlocked</option>
            </select>
          </Field>
        </CardContent>
      </Card>

      {/* ── Feature flags ────────────────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Feature flags</CardTitle>
          <CardDescription>
            Toggle social-graph features. Corporate-tier-only flags are disabled and locked to off
            when the community tier is active.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-0">
          <ToggleRow
            label="Social graph"
            hint="Master switch — disabling this turns off all graph-backed features regardless of individual flags."
            checked={draft.graphEnabled}
            disabled={disabled}
            onChange={(v) => set("graphEnabled", v)}
          />
          <ToggleRow
            label="Weather"
            hint="Aggregate community-health gauge visible to members."
            checked={draft.weatherEnabled}
            disabled={disabled}
            onChange={(v) => set("weatherEnabled", v)}
          />
          <ToggleRow
            label="Constellation"
            hint="Anonymous cluster view visible to members, k-anonymized (floor controlled below)."
            checked={draft.constellationEnabled}
            disabled={disabled}
            onChange={(v) => set("constellationEnabled", v)}
          />
          <ToggleRow
            label="Neighborhood"
            hint="A member's own warm ties — self-view only, never exposed to others."
            checked={draft.neighborhoodEnabled}
            disabled={disabled}
            onChange={(v) => set("neighborhoodEnabled", v)}
          />
          <ToggleRow
            label="Neighborhood includes interactions"
            hint="Off: a member's Neighborhood shows only their follows and connections. On: it also includes people they've recently interacted with. This is the project default — members can override it for their own view."
            checked={draft.neighborhoodIncludeInteractions}
            disabled={disabled || !draft.neighborhoodEnabled}
            onChange={(v) => set("neighborhoodIncludeInteractions", v)}
          />
          <ToggleRow
            label="Read affinity"
            hint="Private per-viewer feed boost; never graph data — the member's own reading history, invisible to operators."
            checked={draft.readAffinityEnabled}
            disabled={disabled}
            onChange={(v) => set("readAffinityEnabled", v)}
          />
          <ToggleRow
            label="Steward friction context"
            hint="Friction signals visible to stewards within an open case — audited, in-context only."
            checked={draft.frictionVisibleToStewards}
            disabled={disabled}
            onChange={(v) => set("frictionVisibleToStewards", v)}
          />

          {/* Corporate-tier-only flags */}
          <div className="mt-3 rounded-lg border border-border/60 bg-surface-2/50 px-3 pt-3 pb-1">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Corporate tier only
            </p>
            <ToggleRow
              label="Influence scores"
              hint="PageRank-bridge analytics visible to operators."
              checked={draft.influenceScoresEnabled}
              disabled={disabled || isCommunity}
              corporateOnly={isCommunity}
              onChange={(v) => set("influenceScoresEnabled", v)}
            />
            <ToggleRow
              label="Silo detection"
              hint="Cross-team cluster analytics visible to operators."
              checked={draft.siloDetectionEnabled}
              disabled={disabled || isCommunity}
              corporateOnly={isCommunity}
              onChange={(v) => set("siloDetectionEnabled", v)}
            />
            <ToggleRow
              label="Engagement scores"
              hint="Per-person warmth score visible to operators."
              checked={draft.engagementScoresEnabled}
              disabled={disabled || isCommunity}
              corporateOnly={isCommunity}
              onChange={(v) => set("engagementScoresEnabled", v)}
            />
            <ToggleRow
              label="Friction analytics"
              hint="Aggregate conflict analytics visible to operators."
              checked={draft.frictionAnalyticsEnabled}
              disabled={disabled || isCommunity}
              corporateOnly={isCommunity}
              onChange={(v) => set("frictionAnalyticsEnabled", v)}
            />
            <ToggleRow
              label="Read receipts"
              hint="Per-space opt-in read receipts — announcement spaces only."
              checked={draft.readReceiptsAllowed}
              disabled={disabled || isCommunity}
              corporateOnly={isCommunity}
              onChange={(v) => set("readReceiptsAllowed", v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Numeric knobs ────────────────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Graph parameters</CardTitle>
          <CardDescription>
            Numeric tuning for k-anonymity and the half-life decay that governs warmth and friction
            signal staleness.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {/* ── k-floor: adaptive / fixed ─────────────────────────────────────────────────────── */}
          {(() => {
            const kFloorMode = draft.constellationKFloor === null ? "adaptive" : "fixed";
            return (
              <div className="sm:col-span-3 space-y-3">
                <Field
                  label="Constellation k-floor"
                  hint="Minimum cluster size for the constellation view. Adaptive is recommended — it picks the floor from your community's current size. The hard minimum is 2 (a blob always represents ≥ 2 people); raising the floor strengthens k-anonymity."
                >
                  <select
                    className={selectCls}
                    value={kFloorMode}
                    disabled={disabled}
                    onChange={(e) => {
                      if (e.target.value === "adaptive") {
                        set("constellationKFloor", null);
                      } else {
                        set("constellationKFloor", view.effective.constellationKFloor ?? 5);
                      }
                    }}
                  >
                    <option value="adaptive">Adaptive (recommended)</option>
                    <option value="fixed">Fixed floor</option>
                  </select>

                  {kFloorMode === "fixed" && (
                    <Input
                      type="number"
                      min={2}
                      max={1000}
                      step={1}
                      value={draft.constellationKFloor ?? ""}
                      disabled={disabled}
                      onChange={(e) => set("constellationKFloor", clampKFloor(Number(e.target.value)))}
                    />
                  )}

                  {kFloorMode === "adaptive" && (
                    <div className="rounded-lg border border-border/60 bg-surface-2/50 px-3 py-2 space-y-1.5">
                      <p className="text-xs font-medium text-muted mb-1.5">Adaptive floor by community size</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Community size</span>
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Floor</span>
                        {ADAPTIVE_KFLOOR_TIERS.map((tier) => (
                          <Fragment key={tier.range}>
                            <span className="text-xs text-muted">{tier.range}</span>
                            <span className="text-xs text-muted">{tier.floor}</span>
                          </Fragment>
                        ))}
                      </div>
                      <p className="text-xs text-faint pt-0.5">
                        Adaptive picks the floor from your community's current size — small communities see
                        their real shape while large ones keep a floor of 5.
                      </p>
                    </div>
                  )}
                </Field>

                {/* Recompute button */}
                <div className="space-y-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={recompute.isPending}
                    onClick={() => recompute.mutate()}
                  >
                    {recompute.isPending ? "Recomputing…" : "Recompute constellation now"}
                  </Button>
                  <p className="text-xs text-faint">
                    Runs GDS clustering synchronously against the saved settings — this can take a while
                    on a large community. Save your changes first.
                  </p>
                </div>
              </div>
            );
          })()}
          <Field
            label="Warmth half-life (days)"
            hint="How quickly warmth signal decays toward zero. Minimum 1 day."
          >
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.warmthHalfLifeDays}
              disabled={disabled}
              onChange={(e) => {
                const v = Math.max(1, Number(e.target.value));
                set("warmthHalfLifeDays", v);
              }}
            />
          </Field>
          <Field
            label="Friction half-life (days)"
            hint="How quickly friction signal decays toward zero. Minimum 1 day."
          >
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.frictionHalfLifeDays}
              disabled={disabled}
              onChange={(e) => {
                const v = Math.max(1, Number(e.target.value));
                set("frictionHalfLifeDays", v);
              }}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {SETTINGS_READ_ONLY ? (
          <span className="text-xs text-faint">View-only — saving disabled</span>
        ) : null}
        <Button type="submit" disabled={save.isPending || SETTINGS_READ_ONLY}>
          <Save />
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  corporateOnly = false,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  corporateOnly?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 border-b border-border/50 py-3 last:border-b-0 ${
        corporateOnly ? "opacity-50" : ""
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex items-center gap-2">
          <span className="block text-sm font-medium text-fg">{label}</span>
          {corporateOnly && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-surface-2 text-faint">
              corporate tier only
            </span>
          )}
        </span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}
