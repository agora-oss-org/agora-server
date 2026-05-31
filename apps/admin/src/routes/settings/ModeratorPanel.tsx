// Moderator integration — everything about the @agora/moderator service for this project:
//   • the INTERNAL notifier the API fans content events to (separate from the external Project
//     webhook; no event list, no blocking — fire-and-forget internal monitoring), and
//   • the auto-action threshold + LLM-provider tuning the moderator overlays on its env defaults.
// GET/PATCH /settings/moderator + POST …/test. Project-admin / operator only on the server. The two
// secrets (notifier secret + LLM API key) are write-only — blank keeps the stored value unchanged.
// Tuning fields left blank are sent as null = "use the moderator's own server default".
//
// The .env-vs-admin model: the moderator ships env DEFAULTS; the admin writes per-project OVERRIDES.
// We fetch the moderator's running config (GET /moderation/config) to show the effective value behind
// each field (override ?? default) and surface the real default in every placeholder — so an operator
// sees what's running and only overrides what differs.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Send, ShieldCheck, Sparkles } from "lucide-react";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input, Label } from "../../components/ui/Input";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { ApiError } from "../../lib/api";
import {
  getModeratorConfig, updateModeratorConfig, testModeratorWebhook,
  type ModeratorConfigView, type ModeratorConfigPatch, type LlmProvider,
} from "../../lib/settings";
import {
  getModeratorRunningConfig, moderatorRunningConfigKey, type ModeratorRunningConfig,
} from "../../lib/moderation-ai";

type Defaults = ModeratorRunningConfig["config"]["defaults"];

const selectCls =
  "h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none transition-colors " +
  "hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/30";

export function ModeratorPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings", "moderator"],
    queryFn: ({ signal }) => getModeratorConfig(signal),
    staleTime: 30_000,
  });
  // The moderator's env defaults (effective behind blank fields). Operator-only + needs the moderator
  // service reachable — so tolerate failure (no retry) and degrade to generic placeholders.
  const running = useQuery({
    queryKey: moderatorRunningConfigKey,
    queryFn: () => getModeratorRunningConfig(),
    staleTime: 30_000,
    retry: false,
  });

  if (isLoading) return <LoadingPanel label="Loading moderator settings…" />;
  if (isError) {
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">Couldn’t load moderator config: {(error as Error)?.message ?? "unknown error"}</p>
        <p className="mt-1 text-xs text-faint">Moderator config is project-admin / operator only.</p>
      </Card>
    );
  }
  return <ModeratorForm initial={data!} running={running.data ?? null} runningFailed={running.isError} />;
}

// "" ⇄ null helpers — a blank tuning field means "use the moderator's env default" (sent as null).
const str = (v: string | number | null) => (v === null ? "" : String(v));
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function ModeratorForm({
  initial, running, runningFailed,
}: {
  initial: ModeratorConfigView;
  running: ModeratorRunningConfig | null;
  runningFailed: boolean;
}) {
  const defaults: Defaults | null = running?.config.defaults ?? null;
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState(initial.url ?? "");
  const [secret, setSecret] = useState(""); // write-only; blank = unchanged
  const [hasSecret, setHasSecret] = useState(initial.hasSecret);
  const [blockThreshold, setBlockThreshold] = useState(str(initial.blockAutoActionThreshold));
  const [reviewThreshold, setReviewThreshold] = useState(str(initial.reviewAutoActionThreshold));
  const [provider, setProvider] = useState<"" | LlmProvider>(initial.llmProvider ?? "");
  const [baseUrl, setBaseUrl] = useState(initial.llmBaseUrl ?? "");
  const [apiKey, setApiKey] = useState(""); // write-only; blank = unchanged
  const [hasLlmApiKey, setHasLlmApiKey] = useState(initial.hasLlmApiKey);
  const [model, setModel] = useState(initial.llmModel ?? "");
  const [maxTokens, setMaxTokens] = useState(str(initial.llmMaxTokens));

  const save = useMutation({
    mutationFn: (patch: ModeratorConfigPatch) => updateModeratorConfig(patch),
    onSuccess: (view) => {
      setHasSecret(view.hasSecret);
      setHasLlmApiKey(view.hasLlmApiKey);
      setSecret("");
      setApiKey("");
      qc.setQueryData(["settings", "moderator"], view);
      toast({ title: "Moderator settings saved", variant: "success" });
    },
    onError: (e) =>
      toast({ title: "Save failed", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  const test = useMutation({
    mutationFn: () => testModeratorWebhook(),
    onSuccess: (r) =>
      r.ok
        ? toast({ title: "Test ping delivered", description: `HTTP ${r.status}`, variant: "success" })
        : toast({ title: "Test ping failed", description: r.error ?? `HTTP ${r.status}`, variant: "danger" }),
    onError: (e) =>
      toast({ title: "Test ping failed", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const bt = blockThreshold.trim();
    const rt = reviewThreshold.trim();
    const mt = maxTokens.trim();
    const patch: ModeratorConfigPatch = {
      url: url.trim() ? url.trim() : null,          // empty → disable the notifier
      blockAutoActionThreshold: bt === "" ? null : Number(bt),
      reviewAutoActionThreshold: rt === "" ? null : Number(rt),
      llmProvider: provider || null,                // "" → use env default
      llmBaseUrl: orNull(baseUrl),
      llmModel: orNull(model),
      llmMaxTokens: mt === "" ? null : Number(mt),
    };
    if (secret.trim()) patch.secret = secret;       // write-only: only send when (re)entered
    if (apiKey.trim()) patch.llmApiKey = apiKey;
    save.mutate(patch);
  }

  const enabled = !!url.trim();

  // Effective value (override ?? server default) + its source, computed live from the form state so
  // the summary updates as you type. `null` default means the moderator's running config is
  // unavailable (operator-only / service down) — we then can't show what blank would resolve to.
  const dv = (override: string, fallback: string | number | null): Effective => {
    const o = override.trim();
    if (o !== "") return { value: o, source: "override" };
    if (fallback !== null && fallback !== undefined && fallback !== "") return { value: String(fallback), source: "default" };
    return { value: "—", source: "unset" };
  };
  const eff = {
    blockThreshold: dv(blockThreshold, defaults?.blockAutoActionThreshold ?? null),
    reviewThreshold: dv(reviewThreshold, defaults?.reviewAutoActionThreshold ?? null),
    provider: dv(provider, defaults?.llm.provider ?? null),
    baseUrl: dv(baseUrl, defaults?.llm.baseUrl ?? (defaults ? "provider default" : null)),
    model: dv(model, defaults?.llm.model ?? null),
    maxTokens: dv(maxTokens, defaults?.llm.maxTokens ?? null),
  };
  const apiKeyEff: Effective =
    apiKey.trim() !== "" || hasLlmApiKey
      ? { value: "set", source: "override" }
      : defaults?.llm.apiKeySet
        ? { value: "set", source: "default" }
        : { value: "not set", source: "unset" };

  // Placeholder text that surfaces the real default ("0.85 — server default") instead of a guess.
  const ph = (fallback: string | number | null | undefined, generic: string) =>
    fallback !== null && fallback !== undefined && fallback !== "" ? `${fallback} — server default` : generic;

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted" />
            Notifier endpoint
          </CardTitle>
          <CardDescription>
            The API fans every content event (<code>entity</code>/<code>comment</code>/<code>message</code>{" "}
            <code>*.complete</code>) here for the <strong>@agora/moderator</strong> service to assess.
            This is an <strong>internal</strong> notifier — separate from Project webhooks, with no event
            list and no blocking. Point it at the moderator’s <code>/webhooks/agora</code> route. Clear
            the URL to disable automated moderation.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Moderator webhook URL">
            <Input type="url" placeholder="http://localhost:4001/webhooks/agora" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field
            label="Signing secret"
            hint={hasSecret ? "Leave blank to keep the current secret." : "Required — the moderator only fires once a secret is set."}
          >
            <Input type="password" placeholder={hasSecret ? "•••••••• (unchanged)" : "shared HMAC secret"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted" />
            Automated moderation (LLM)
          </CardTitle>
          <CardDescription>
            Per-project overrides for the moderator’s LLM classifier and auto-removal. Any field left
            blank falls back to the moderator service’s own environment defaults — so you can run a
            single shared config from the server and only override what a given project needs.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <EffectiveSummary running={running} runningFailed={runningFailed} eff={eff} apiKeyEff={apiKeyEff} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Block auto-action threshold"
              hint="0–1 confidence to auto-remove a “block” verdict. 0 disables it (blocks queue for a human). Blank = server default."
            >
              <Input type="number" min={0} max={1} step={0.01} placeholder={ph(defaults?.blockAutoActionThreshold, "0.85 (default)")} value={blockThreshold} onChange={(e) => setBlockThreshold(e.target.value)} />
            </Field>
            <Field
              label="Review auto-action threshold"
              hint="0–1 confidence to auto-remove a “review” verdict. 0 (default) keeps reviews queuing for a human — raise it to auto-act on high-confidence reviews. Blank = server default."
            >
              <Input type="number" min={0} max={1} step={0.01} placeholder={ph(defaults?.reviewAutoActionThreshold, "0 (default)")} value={reviewThreshold} onChange={(e) => setReviewThreshold(e.target.value)} />
            </Field>
            <Field label="Provider" hint="Blank = server default.">
              <select className={selectCls} value={provider} onChange={(e) => setProvider(e.target.value as "" | LlmProvider)}>
                <option value="">{defaults ? `Server default (${defaults.llm.provider})` : "Server default"}</option>
                <option value="openai">openai (OpenAI-compatible)</option>
                <option value="anthropic">anthropic</option>
              </select>
            </Field>
            <Field label="API base URL" hint="OpenAI-compatible host (Groq, Together, Ollama, …). Blank = provider default.">
              <Input type="url" placeholder={ph(defaults?.llm.baseUrl, "https://api.openai.com/v1")} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            <Field
              label="API key"
              hint={
                hasLlmApiKey
                  ? "Leave blank to keep this project’s key."
                  : defaults?.llm.apiKeySet
                    ? "Blank = the server’s default key."
                    : "No server default key set — provide one here (or in the moderator’s env)."
              }
            >
              <Input type="password" placeholder={hasLlmApiKey ? "•••••••• (unchanged)" : "provider API key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
            <Field label="Model" hint="Blank = server default.">
              <Input type="text" placeholder={ph(defaults?.llm.model, "gpt-4o-mini")} value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
            <Field label="Max tokens" hint="Blank = server default.">
              <Input type="number" min={1} step={1} placeholder={ph(defaults?.llm.maxTokens, "512")} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!enabled || test.isPending || save.isPending}
          onClick={() => test.mutate()}
          title={enabled ? "Ping the saved moderator URL" : "Set and save a URL first"}
        >
          <Send />
          {test.isPending ? "Pinging…" : "Send test ping"}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          <Save />
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

// One resolved field: the effective value + where it came from (this project's override, the server
// env default, or neither — nothing configured).
type Effective = { value: string; source: "override" | "default" | "unset" };

function SourceTag({ source }: { source: Effective["source"] }) {
  const map = {
    override: { label: "override", cls: "bg-primary/10 text-primary" },
    default: { label: "default", cls: "bg-surface-2 text-muted" },
    unset: { label: "not set", cls: "bg-surface-2 text-faint" },
  } as const;
  const s = map[source];
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.cls}`}>{s.label}</span>;
}

function EffRow({ label, eff }: { label: string; eff: Effective }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-xs text-fg">{eff.value}</span>
        <SourceTag source={eff.source} />
      </span>
    </div>
  );
}

// Read-only "what's actually running for this project" box: override ?? the moderator's env default,
// computed live from the form. Degrades gracefully when the moderator's running config is unavailable.
function EffectiveSummary({
  running, runningFailed, eff, apiKeyEff,
}: {
  running: ModeratorRunningConfig | null;
  runningFailed: boolean;
  eff: Record<"blockThreshold" | "reviewThreshold" | "provider" | "baseUrl" | "model" | "maxTokens", Effective>;
  apiKeyEff: Effective;
}) {
  const writeBack = running?.config.writeBack;
  return (
    <div className="rounded-lg border border-border bg-bg/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Effective for this project</p>
        {running ? (
          <span className="text-[11px] text-faint">
            moderator up · write-back {writeBack?.enabled ? "on" : "off"}
          </span>
        ) : runningFailed ? (
          <span className="text-[11px] text-warning">moderator unreachable — defaults hidden</span>
        ) : null}
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <EffRow label="Provider" eff={eff.provider} />
        <EffRow label="Model" eff={eff.model} />
        <EffRow label="Block auto-action" eff={eff.blockThreshold} />
        <EffRow label="Review auto-action" eff={eff.reviewThreshold} />
        <EffRow label="Max tokens" eff={eff.maxTokens} />
        <EffRow label="API base URL" eff={eff.baseUrl} />
        <EffRow label="API key" eff={apiKeyEff} />
      </div>
    </div>
  );
}
