// Stewardship settings — the conflict-resolution knobs an operator controls. Reads GET /settings/steward,
// PATCHes /settings/steward (project-admin only on the server). Three policies:
//   • notify policy   — who's told about a case, and when (#4 participant notifications)
//   • mediation mode  — caucus-only vs hybrid (caucus + optional consensual joint room)
//   • on close        — what happens to a case's mediation channels when it closes
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "../../components/ui/Card";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { ApiError } from "../../lib/api";
import {
  getStewardSettings, updateStewardSettings,
  type StewardConfigView, type StewardNotifyPolicy, type StewardMediationMode, type StewardMediationOnClose,
} from "../../lib/settings";

const NOTIFY_POLICIES: { value: StewardNotifyPolicy; label: string; desc: string }[] = [
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

const MEDIATION_MODES: { value: StewardMediationMode; label: string; desc: string }[] = [
  {
    value: "hybrid",
    label: "Hybrid (recommended)",
    desc: "Per-party caucus channels (steward ↔ each party, private) PLUS an optional joint room with both parties — offered only when both consent and the case isn't flagged Targeting. The flexible default.",
  },
  {
    value: "caucus",
    label: "Caucus only",
    desc: "Only per-party private channels; the steward bridges between them. No joint room is ever offered. Fully preserves respondent anonymity — the safest, most power-aware setting.",
  },
];

const ON_CLOSE: { value: StewardMediationOnClose; label: string; desc: string }[] = [
  {
    value: "archive-read-only",
    label: "Archive read-only (recommended)",
    desc: "When the case closes, channels lock (only the steward can post) and keep their full history; a 'case resolved' line is posted. A gentle wind-down that preserves the record.",
  },
  {
    value: "lock-leave",
    label: "Lock & remove parties",
    desc: "Lock posting and drop the parties from the channel (it disappears from their chat list). The steward retains read access for the audit trail.",
  },
  {
    value: "leave-open",
    label: "Leave open",
    desc: "Do nothing on close — the channel stays a normal active chat the parties can keep using.",
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
    mutationFn: (patch: Parameters<typeof updateStewardSettings>[0]) => updateStewardSettings(patch),
    onSuccess: (cfg) => {
      qc.setQueryData(["settings", "steward"], cfg);
      toast({ title: "Stewardship settings saved", variant: "success" });
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

  const cfg = data!;
  const disabled = mutation.isPending;
  return (
    <div className="space-y-4">
      <RadioCard<StewardNotifyPolicy>
        title="Case notifications"
        hint="Who gets notified about a conflict-resolution case, and when. Respondents are never told who raised a case."
        name="steward-notify-policy"
        options={NOTIFY_POLICIES}
        current={cfg.notifyPolicy}
        disabled={disabled}
        onPick={(v) => mutation.mutate({ notifyPolicy: v })}
      />
      <RadioCard<StewardMediationMode>
        title="Mediation channels"
        hint="How a steward talks the parties through a case. Caucus is always available; this controls whether a joint room can be offered."
        name="steward-mediation-mode"
        options={MEDIATION_MODES}
        current={cfg.mediationMode}
        disabled={disabled}
        onPick={(v) => mutation.mutate({ mediationMode: v })}
      />
      <RadioCard<StewardMediationOnClose>
        title="When a case closes"
        hint="What happens to the case's mediation channels once it's resolved."
        name="steward-mediation-on-close"
        options={ON_CLOSE}
        current={cfg.mediationOnClose}
        disabled={disabled}
        onPick={(v) => mutation.mutate({ mediationOnClose: v })}
      />
    </div>
  );
}

function RadioCard<T extends string>(props: {
  title: string;
  hint: string;
  name: string;
  options: { value: T; label: string; desc: string }[];
  current: T;
  disabled: boolean;
  onPick: (value: T) => void;
}) {
  const { title, hint, name, options, current, disabled, onPick } = props;
  return (
    <Card className="p-5">
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="mt-1 text-sm text-muted">{hint}</p>
      <fieldset className="mt-4 space-y-2" disabled={disabled}>
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
              current === o.value ? "border-primary bg-primary/5" : "border-border hover:bg-surface-2"
            }`}
          >
            <input
              type="radio"
              name={name}
              className="mt-1 size-4 shrink-0 accent-primary"
              checked={current === o.value}
              onChange={() => current !== o.value && onPick(o.value)}
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-fg">{o.label}</span>
              <span className="block text-xs text-muted">{o.desc}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Card>
  );
}

export type { StewardConfigView };
