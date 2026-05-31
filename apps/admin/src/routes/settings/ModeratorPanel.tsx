// Moderator integration — everything about the @agora/moderator service for this project:
//   • the INTERNAL notifier the API fans content events to (separate from the external Project
//     webhook; no event list, no blocking — fire-and-forget internal monitoring), and
//   • the auto-action threshold + LLM-provider tuning the moderator overlays on its env defaults.
// GET/PATCH /settings/moderator + POST …/test. Project-admin / operator only on the server. The two
// secrets (notifier secret + LLM API key) are write-only — blank keeps the stored value unchanged.
// Tuning fields left blank are sent as null = "use the moderator's own server default".
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

const selectCls =
  "h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none transition-colors " +
  "hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/30";

export function ModeratorPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings", "moderator"],
    queryFn: ({ signal }) => getModeratorConfig(signal),
    staleTime: 30_000,
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
  return <ModeratorForm initial={data!} />;
}

// "" ⇄ null helpers — a blank tuning field means "use the moderator's env default" (sent as null).
const str = (v: string | number | null) => (v === null ? "" : String(v));
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function ModeratorForm({ initial }: { initial: ModeratorConfigView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState(initial.url ?? "");
  const [secret, setSecret] = useState(""); // write-only; blank = unchanged
  const [hasSecret, setHasSecret] = useState(initial.hasSecret);
  const [threshold, setThreshold] = useState(str(initial.autoActionThreshold));
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
    const t = threshold.trim();
    const mt = maxTokens.trim();
    const patch: ModeratorConfigPatch = {
      url: url.trim() ? url.trim() : null,          // empty → disable the notifier
      autoActionThreshold: t === "" ? null : Number(t),
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
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Auto-action threshold"
            hint="0–1 confidence to auto-remove a “block” verdict. 0 disables auto-removal (everything queues for a human). Blank = server default."
          >
            <Input type="number" min={0} max={1} step={0.01} placeholder="0.85 (default)" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </Field>
          <Field label="Provider" hint="Blank = server default.">
            <select className={selectCls} value={provider} onChange={(e) => setProvider(e.target.value as "" | LlmProvider)}>
              <option value="">Server default</option>
              <option value="openai">openai (OpenAI-compatible)</option>
              <option value="anthropic">anthropic</option>
            </select>
          </Field>
          <Field label="API base URL" hint="OpenAI-compatible host (Groq, Together, Ollama, …). Blank = provider default.">
            <Input type="url" placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
          <Field
            label="API key"
            hint={hasLlmApiKey ? "Leave blank to keep the current key." : "Blank = server default key (if the moderator has one)."}
          >
            <Input type="password" placeholder={hasLlmApiKey ? "•••••••• (unchanged)" : "provider API key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Field>
          <Field label="Model" hint="Blank = server default.">
            <Input type="text" placeholder="gpt-4o-mini" value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label="Max tokens" hint="Blank = server default.">
            <Input type="number" min={1} step={1} placeholder="512" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </Field>
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
