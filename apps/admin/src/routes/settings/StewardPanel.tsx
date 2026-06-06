// Stewardship settings — the case-notification policy (who gets told about a steward conflict case,
// and when). Reads GET /settings/steward, PATCHes /settings/steward. Project-admin only on the server.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "../../components/ui/Card";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { ApiError } from "../../lib/api";
import { getStewardSettings, updateStewardSettings, type StewardNotifyPolicy } from "../../lib/settings";

const POLICIES: { value: StewardNotifyPolicy; label: string; desc: string }[] = [
  {
    value: "power-aware",
    label: "Power-aware (recommended)",
    desc: "Complainant is kept informed at every stage. The respondent is notified only when their content is removed or a protective action is taken — never told who raised it. Honors privacy of the harmed.",
  },
  {
    value: "symmetric",
    label: "Symmetric",
    desc: "Both parties are notified at every stage (opened, in mediation, resolved). The respondent still never sees the complainant's identity, but is told from the start that a case involves their content.",
  },
  {
    value: "resolution-only",
    label: "Resolution-only",
    desc: "Quietest: no opened/mediation pings. Notify only at close — the complainant gets the outcome; the respondent only if their content was removed.",
  },
];

export function StewardPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings", "steward"],
    queryFn: ({ signal }) => getStewardSettings(signal),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (notifyPolicy: StewardNotifyPolicy) => updateStewardSettings({ notifyPolicy }),
    onSuccess: (cfg) => {
      qc.setQueryData(["settings", "steward"], cfg);
      toast({ title: "Notification policy saved", variant: "success" });
    },
    onError: (e) => toast({ title: "Couldn't save", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  if (isLoading) return <LoadingPanel label="Loading stewardship settings…" />;
  if (isError) {
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">Couldn’t load stewardship settings: {(error as Error)?.message ?? "unknown error"}</p>
        <p className="mt-1 text-xs text-faint">Stewardship config is project-admin only.</p>
      </Card>
    );
  }

  const current = data!.notifyPolicy;
  return (
    <Card className="p-5">
      <p className="text-sm font-medium text-fg">Case notifications</p>
      <p className="mt-1 text-sm text-muted">Who gets notified about a conflict-resolution case, and when. Respondents are never told who raised a case.</p>
      <fieldset className="mt-4 space-y-2" disabled={mutation.isPending}>
        {POLICIES.map((p) => (
          <label
            key={p.value}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
              current === p.value ? "border-primary bg-primary/5" : "border-border hover:bg-surface-2"
            }`}
          >
            <input
              type="radio"
              name="steward-notify-policy"
              className="mt-1 size-4 shrink-0 accent-primary"
              checked={current === p.value}
              onChange={() => current !== p.value && mutation.mutate(p.value)}
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-fg">{p.label}</span>
              <span className="block text-xs text-muted">{p.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Card>
  );
}
