// Project webhooks — the second Settings slice. GET/PATCH /webhooks/config + POST /webhooks/test.
// Project-admin / operator only on the server. Secret is write-only (GET exposes only hasSecret).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Send } from "lucide-react";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input, Label } from "../../components/ui/Input";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { SETTINGS_READ_ONLY } from "../../config";
import { ApiError } from "../../lib/api";
import {
  getWebhookConfig, updateWebhookConfig, testWebhook,
  WEBHOOK_VALIDATION_EVENTS, WEBHOOK_BROADCAST_EVENTS,
  type WebhookConfigView, type WebhookConfigPatch,
} from "../../lib/settings";

export function WebhooksPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings", "webhooks"],
    queryFn: ({ signal }) => getWebhookConfig(signal),
    staleTime: 30_000,
  });

  if (isLoading) return <LoadingPanel label="Loading webhook settings…" />;
  if (isError) {
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">Couldn’t load webhooks: {(error as Error)?.message ?? "unknown error"}</p>
        <p className="mt-1 text-xs text-faint">Webhook config is project-admin / operator only.</p>
      </Card>
    );
  }
  return <WebhookForm initial={data!} />;
}

function WebhookForm({ initial }: { initial: WebhookConfigView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState(initial.url ?? "");
  const [secret, setSecret] = useState(""); // write-only; blank = unchanged
  const [hasSecret, setHasSecret] = useState(initial.hasSecret);
  const [events, setEvents] = useState<Set<string>>(() => new Set(initial.events));

  const toggleEvent = (e: string, on: boolean) =>
    setEvents((prev) => {
      const next = new Set(prev);
      on ? next.add(e) : next.delete(e);
      return next;
    });

  const save = useMutation({
    mutationFn: (patch: WebhookConfigPatch) => updateWebhookConfig(patch),
    onSuccess: (view) => {
      setHasSecret(view.hasSecret);
      setSecret("");
      qc.setQueryData(["settings", "webhooks"], view);
      toast({ title: "Webhook settings saved", variant: "success" });
    },
    onError: (e) =>
      toast({ title: "Save failed", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  const test = useMutation({
    mutationFn: () => testWebhook(),
    onSuccess: (r) => {
      return r.ok
        ? toast({ title: "Test ping delivered", description: `HTTP ${r.status}`, variant: "success" })
        : toast({ title: "Test ping failed", description: r.error ?? `HTTP ${r.status}`, variant: "danger" });
    },
    onError: (e) =>
      toast({ title: "Test ping failed", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (SETTINGS_READ_ONLY) return;
    const trimmed = url.trim();
    const patch: WebhookConfigPatch = {
      url: trimmed ? trimmed : null, // empty → clear the webhook
      events: [...events],
    };
    if (secret.trim()) patch.secret = secret; // write-only: only send when (re)entered
    save.mutate(patch);
  }

  const enabled = !!url.trim();

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Endpoint</CardTitle>
          <CardDescription>
            Agora POSTs HMAC-signed events here (<code>x-signature</code> = HMAC-SHA256 of
            <code>{" timestamp.body"}</code>). Clear the URL to disable.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Webhook URL">
            <Input type="url" placeholder="https://example.com/agora/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field
            label="Signing secret"
            hint={hasSecret ? "Leave blank to keep the current secret." : "Required — the webhook only fires once a secret is set."}
          >
            <Input type="password" placeholder={hasSecret ? "•••••••• (unchanged)" : "shared HMAC secret"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Subscribed events</CardTitle>
          <CardDescription>
            Only subscribed events are delivered. <strong>Validation</strong> events are synchronous and
            blocking — your endpoint must reply <code>{"{ valid }"}</code> to allow or veto the write.
            <strong> Broadcast</strong> events are fire-and-forget.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <EventGroup title="Validation (blocking)" list={WEBHOOK_VALIDATION_EVENTS} events={events} onToggle={toggleEvent} />
          <EventGroup title="Broadcast (fire-and-forget)" list={WEBHOOK_BROADCAST_EVENTS} events={events} onToggle={toggleEvent} />
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {SETTINGS_READ_ONLY ? <span className="text-xs text-faint">View-only — saving disabled</span> : null}
        <Button
          type="button"
          variant="outline"
          disabled={!enabled || test.isPending || save.isPending}
          onClick={() => test.mutate()}
          title={enabled ? "Ping the saved webhook" : "Set and save a URL first"}
        >
          <Send />
          {test.isPending ? "Pinging…" : "Send test ping"}
        </Button>
        <Button type="submit" disabled={save.isPending || SETTINGS_READ_ONLY}>
          <Save />
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function EventGroup({
  title, list, events, onToggle,
}: {
  title: string;
  list: readonly string[];
  events: Set<string>;
  onToggle: (e: string, on: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
      <div className="space-y-1.5">
        {list.map((e) => (
          <label key={e} className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="size-4 accent-primary" checked={events.has(e)} onChange={(ev) => onToggle(e, ev.target.checked)} />
            <code className="text-xs">{e}</code>
          </label>
        ))}
      </div>
    </div>
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
