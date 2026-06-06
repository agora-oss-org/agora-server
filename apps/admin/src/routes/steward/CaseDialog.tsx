// Case detail + actions. Walks a conflict case through its lifecycle (assign → mediate → close) with
// a transformative-leaning outcome menu (repair/separation/protection/dismiss); escalation (which
// REMOVES the content) is its own danger action. Every action appends to the case timeline server-
// side, which we re-read on success. Mirrors the moderation ReviewDialog patterns.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban, CheckCircle2, Crosshair, FileText, Handshake, MessageSquarePlus, RotateCcw, UserCheck, UserMinus,
} from "lucide-react";
import type { Comment, Entity } from "@agora/contract";
import {
  addCaseNote, caseKey, caseUserLabel, escalateCase, getCase, patchCase,
  CLOSE_OUTCOMES, OUTCOME_LABEL, STATE_LABEL,
  type CaseDetail, type CaseEvent, type PatchCaseBody,
} from "../../lib/steward";
import { contentDeepLink } from "../../lib/moderation";
import { ApiError } from "../../lib/api";
import { relativeTime, shortId } from "../../lib/time";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Input } from "../../components/ui/Input";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { useAuth } from "../../auth/AuthContext";
import { ContentPreview } from "../moderation/ContentPreview";

export function CaseDialog({ caseId, onClose }: { caseId: string | null; onClose: () => void }) {
  const open = !!caseId;
  const query = useQuery({
    queryKey: caseId ? caseKey(caseId) : ["steward", "case", "none"],
    queryFn: () => getCase(caseId!),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-3xl">
        {query.isLoading || !query.data ? (
          <div className="p-6">
            <LoadingPanel label="Loading case…" />
          </div>
        ) : (
          <CaseBody c={query.data} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CaseBody({ c, onClose }: { c: CaseDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const me = user?.id;
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState(c.resolutionNote ?? "");

  useEffect(() => {
    setResolution(c.resolutionNote ?? "");
    setNote("");
  }, [c.id]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["steward"] });
    qc.invalidateQueries({ queryKey: caseKey(c.id) });
  };
  const onErr = (e: unknown) =>
    toast({ title: "Action failed", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" });

  const patch = useMutation({
    mutationFn: (body: PatchCaseBody) => patchCase(c.id, body),
    onSuccess: (_d, body) => {
      refresh();
      if (body.outcome) {
        toast({ title: `Case closed — ${OUTCOME_LABEL[body.outcome]}`, variant: "success" });
        onClose();
      }
    },
    onError: onErr,
  });
  const noteMutation = useMutation({
    mutationFn: () => addCaseNote(c.id, note.trim()),
    onSuccess: () => { setNote(""); refresh(); },
    onError: onErr,
  });
  const escalate = useMutation({
    mutationFn: () => escalateCase(c.id, resolution.trim() || undefined),
    onSuccess: () => {
      refresh();
      toast({ title: "Escalated — content removed", variant: "danger" });
      onClose();
    },
    onError: onErr,
  });

  const busy = patch.isPending || escalate.isPending;
  const closed = c.state === "closed";
  const subjectTarget: Entity | Comment | null = c.subject?.entity ?? c.subject?.comment ?? null;
  const canEscalate = !closed && !!c.subjectType; // entity | comment | message all removable now
  const deepLink =
    c.subject && (c.subject.type === "entity" || c.subject.type === "comment")
      ? contentDeepLink(c.subject.type, c.subject.id, subjectTarget)
      : null;

  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex flex-wrap items-center gap-2">
          <Handshake className="size-4 text-primary" />
          Case
          {closed && c.outcome ? (
            <Badge variant={c.outcome === "escalated" ? "danger" : "muted"}>{OUTCOME_LABEL[c.outcome]}</Badge>
          ) : (
            <Badge variant={c.state === "in_mediation" ? "info" : "warning"}>{STATE_LABEL[c.state]}</Badge>
          )}
          {c.asymmetry ? (
            <Badge variant="danger"><Crosshair className="size-3" /> Targeting</Badge>
          ) : null}
        </DialogTitle>
        <DialogDescription>{c.summary || "No summary."}</DialogDescription>
      </DialogHeader>

      <DialogBody className="min-h-0 flex-1 overflow-y-auto">
        {/* Parties */}
        <div className="grid grid-cols-2 gap-3">
          <Party label="Complainant" name={caseUserLabel(c.complainant)} rep={c.complainant?.reputation} />
          <Party label="Respondent" name={caseUserLabel(c.respondent)} rep={c.respondent?.reputation} />
        </div>

        {/* Subject content */}
        {c.subject ? (
          c.subject.type === "message" ? (
            <div className="space-y-2 rounded-lg border border-border bg-bg p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-fg">Chat message</p>
                <span className="font-mono text-xs text-faint">{shortId(c.subject.id)}</span>
              </div>
              {c.subject.message ? (
                <>
                  <p className="whitespace-pre-wrap break-words text-sm text-muted">
                    {c.subject.message.content ?? <span className="text-faint">(no text)</span>}
                  </p>
                  <p className="text-xs text-faint">by {caseUserLabel(c.subject.message.user)}</p>
                </>
              ) : (
                <p className="text-sm text-muted">Message not found (it may have been deleted).</p>
              )}
            </div>
          ) : (
            <ContentPreview
              targetType={c.subject.type}
              target={subjectTarget}
              isError={!subjectTarget}
              title={c.subject.type === "entity" ? (subjectTarget as Entity | null)?.title || "(untitled post)" : "Comment"}
              deepLink={deepLink}
            />
          )
        ) : (
          <p className="text-sm text-faint">No content attached to this case.</p>
        )}

        {/* Steward controls */}
        {!closed ? (
          <div className="space-y-3 rounded-lg border border-border bg-bg p-4">
            <div className="flex flex-wrap items-center gap-2">
              {c.assignedToId === me ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => patch.mutate({ assignedToId: null })}>
                  <UserMinus /> Unassign me
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => patch.mutate({ assignedToId: me ?? null })}>
                  <UserCheck /> Assign to me
                </Button>
              )}
              {c.state === "open" ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => patch.mutate({ state: "in_mediation" })}>
                  <Handshake /> Move to mediation
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => patch.mutate({ state: "open" })}>
                  <RotateCcw /> Back to open
                </Button>
              )}
              <Button
                size="sm"
                variant={c.asymmetry ? "danger-outline" : "outline"}
                disabled={busy}
                onClick={() => patch.mutate({ asymmetry: !c.asymmetry })}
              >
                <Crosshair /> {c.asymmetry ? "Clear targeting flag" : "Flag as targeting"}
              </Button>
            </div>
            <p className="text-xs text-faint">
              Mark “targeting” when this isn't a symmetric dispute — a pile-on or harassment of one member. It steers
              the case toward protection rather than both-sides mediation.
            </p>

            {/* Note */}
            <div className="flex items-center gap-2">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the case log…" />
              <Button size="sm" variant="secondary" disabled={noteMutation.isPending || !note.trim()} onClick={() => noteMutation.mutate()}>
                <MessageSquarePlus /> Note
              </Button>
            </div>
          </div>
        ) : null}

        {/* Timeline */}
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
            <FileText className="size-4 text-muted" /> Timeline
          </p>
          <ul className="space-y-2">
            {c.events.map((e) => (
              <Timeline key={e.id} e={e} />
            ))}
          </ul>
        </div>
      </DialogBody>

      <DialogFooter className="shrink-0 flex-col items-stretch gap-3 sm:flex-col">
        {!closed ? (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted">Resolution note (optional)</label>
              <Input value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="How was this resolved?" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-faint">Close as:</span>
                {CLOSE_OUTCOMES.map((o) => (
                  <Button
                    key={o}
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => patch.mutate({ outcome: o, resolutionNote: resolution.trim() || undefined })}
                  >
                    <CheckCircle2 /> {OUTCOME_LABEL[o]}
                  </Button>
                ))}
              </div>
              <Button
                size="sm"
                variant="danger"
                disabled={busy || !canEscalate}
                title={canEscalate ? undefined : "No removable content attached"}
                onClick={() => escalate.mutate()}
              >
                <Ban /> Escalate &amp; remove
              </Button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between gap-2 text-sm text-muted">
            <span>Closed {relativeTime(c.closedAt)}{c.resolutionNote ? ` — ${c.resolutionNote}` : ""}</span>
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        )}
      </DialogFooter>
    </>
  );
}

function Party({ label, name, rep }: { label: string; name: string; rep?: number }) {
  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-2">
      <p className="text-xs text-faint">{label}</p>
      <p className="text-sm text-fg">
        {name}
        {rep !== undefined ? <span className="ml-1.5 text-xs text-faint">{rep} rep</span> : null}
      </p>
    </div>
  );
}

function eventText(e: CaseEvent): string {
  const m = (e.meta ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case "opened": return "opened the case";
    case "note": return e.body ?? "added a note";
    case "state_change": return `moved ${String(m.from ?? "?")} → ${String(m.to ?? "?")}`;
    case "assignment": return m.to ? "assigned the case" : "unassigned the case";
    case "asymmetry": return m.asymmetry ? "flagged this as targeting" : "cleared the targeting flag";
    case "outcome": return `closed as ${String(m.outcome ?? "?")}`;
    case "escalation": return "escalated — removed the content";
    default: return e.kind;
  }
}

function Timeline({ e }: { e: CaseEvent }) {
  const emphasised = e.kind === "note" || e.kind === "escalation" || e.kind === "outcome";
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border-strong" />
      <div className="min-w-0">
        <p className={emphasised ? "text-fg" : "text-muted"}>
          <span className="font-medium text-fg">{caseUserLabel(e.actor)}</span> {eventText(e)}
        </p>
        <p className="text-xs text-faint">{relativeTime(e.createdAt)}</p>
      </div>
    </li>
  );
}
