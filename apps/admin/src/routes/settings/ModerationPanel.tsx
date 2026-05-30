// Moderation config — controls how content moderated as "removed" is served to normal users.
// Reads GET /settings/moderation and PATCHes changes. Project-admin/operator only on the server.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, MessageSquareOff, Save } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { ApiError } from "../../lib/api";
import {
  getModerationConfig, updateModerationConfig,
  type ModerationConfigView, type RemovedContentBehavior,
} from "../../lib/settings";

const OPTIONS: { value: RemovedContentBehavior; label: string; desc: string; icon: typeof EyeOff }[] = [
  {
    value: "hide",
    label: "Hide completely",
    desc: "Removed entities and comments are filtered out of feeds, lists, and threads — and 404 on direct links — for everyone except moderators. Closest to “gone”. A removed comment's replies are hidden with it.",
    icon: EyeOff,
  },
  {
    value: "placeholder",
    label: "Show “[removed]” placeholder",
    desc: "The row stays in the feed/thread but its text and media are blanked, so clients can show a “[removed by moderator]” stub. Preserves reply chains and counts (Reddit-style).",
    icon: MessageSquareOff,
  },
];

export function ModerationPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings", "moderation"],
    queryFn: ({ signal }) => getModerationConfig(signal),
    staleTime: 30_000,
  });

  if (isLoading) return <LoadingPanel label="Loading moderation settings…" />;
  if (isError) {
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">
          Couldn’t load moderation settings: {(error as Error)?.message ?? "unknown error"}
        </p>
        <p className="mt-1 text-xs text-faint">Moderation config is project-admin/operator only.</p>
      </Card>
    );
  }
  return <ModerationForm initial={data!} />;
}

function ModerationForm({ initial }: { initial: ModerationConfigView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [behavior, setBehavior] = useState<RemovedContentBehavior>(initial.removedContentBehavior);
  const dirty = behavior !== initial.removedContentBehavior;

  const mutation = useMutation({
    mutationFn: () => updateModerationConfig({ removedContentBehavior: behavior }),
    onSuccess: (view) => {
      setBehavior(view.removedContentBehavior);
      qc.setQueryData(["settings", "moderation"], view);
      toast({ title: "Moderation settings saved", variant: "success" });
    },
    onError: (e) =>
      toast({
        title: "Save failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
      className="space-y-5"
    >
      <Card className="p-5">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-fg">When content is removed by a moderator…</legend>
          <p className="text-xs text-faint">
            Moderators and deployment operators always see removed content in the review queue, regardless of this setting.
          </p>
          <div className="space-y-3 pt-1">
            {OPTIONS.map((o) => {
              const Icon = o.icon;
              const selected = behavior === o.value;
              return (
                <label
                  key={o.value}
                  className={
                    "flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors " +
                    (selected ? "border-primary bg-primary/5" : "border-border hover:border-border-strong")
                  }
                >
                  <input
                    type="radio"
                    name="removedContentBehavior"
                    value={o.value}
                    checked={selected}
                    onChange={() => setBehavior(o.value)}
                    className="mt-1 size-4 shrink-0 accent-primary"
                  />
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-fg">
                      <Icon className="size-4 text-muted" />
                      {o.label}
                    </div>
                    <p className="text-xs text-muted">{o.desc}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {mutation.isError ? <span className="text-xs text-danger">Not saved</span> : null}
        <Button type="submit" disabled={!dirty || mutation.isPending}>
          <Save />
          {mutation.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
