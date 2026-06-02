import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Bot, Check, Flag, Sparkles } from "lucide-react";
import type { Comment, Entity, ModerationVerdict, Report } from "@agora/contract";
import { actOnReport, displayName, getReportTarget, reportDeepLink, type ModerationDecision } from "../../lib/moderation";
import { aiAnalysisKey, analyzeTarget, getAnalysis, targetText } from "../../lib/moderation-ai";
import { ApiError } from "../../lib/api";
import { track } from "../../lib/analytics";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Input } from "../../components/ui/Input";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { useAuth } from "../../auth/AuthContext";
import { shortId } from "../../lib/time";
import { ContentPreview } from "./ContentPreview";
import { Poster } from "./Poster";

type Action = ModerationDecision | "dismiss";

function targetTitle(target: Entity | Comment | null, report: Report): string {
  if (!target) return `${report.targetType} ${shortId(report.targetId)}`;
  if (report.targetType === "entity") return (target as Entity).title || "(untitled entity)";
  return "Comment";
}

export function ReviewDialog({ report, onClose }: { report: Report | null; onClose: () => void }) {
  const open = !!report;
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (report) setReason("");
  }, [report?.id]);

  const targetQuery = useQuery({
    queryKey: ["report-target", report?.targetType, report?.targetId],
    queryFn: () => getReportTarget(report!),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (action: Action) => actOnReport(report!, action, reason.trim() || undefined),
    onSuccess: (_d, action) => {
      track("admin-moderation-action", { surface: "report", action, targetType: report!.targetType });
      toast({
        title: action === "removed" ? "Content removed" : action === "approved" ? "Content kept" : "Report dismissed",
        variant: action === "removed" ? "danger" : "success",
      });
      qc.invalidateQueries({ queryKey: ["reports"] });
      onClose();
    },
    onError: (e) =>
      toast({ title: "Action failed", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  const target = targetQuery.data ?? null;
  // Deep link to the reported content in the consumer app (null for a comment until its parent
  // entity id loads with the target).
  const deepLink = report ? reportDeepLink(report, target) : null;
  const { isOperator } = useAuth();
  const scoped = !!report?.spaceId;
  // Space reports are actioned via the space flow; project-level reports (no space) only by operators.
  const canAct = scoped || isOperator;
  const busy = mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Flag className="size-4 text-warning" />
            Review {report?.targetType}
          </DialogTitle>
          <DialogDescription>Reported {report ? `for "${report.reason}"` : ""}</DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 overflow-y-auto">
          {report ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-border bg-bg px-4 py-2.5 text-sm">
              <span className="text-muted">Posted by <Poster user={report.author} bold /></span>
              <span className="text-muted">Flagged by <span className="font-medium text-fg">{displayName(report.reporter)}</span></span>
            </div>
          ) : null}
          {targetQuery.isLoading ? (
            <LoadingPanel label="Loading content…" />
          ) : (
            <>
              {report ? (
                <ContentPreview
                  targetType={report.targetType}
                  target={target}
                  isError={targetQuery.isError}
                  title={targetTitle(target, report)}
                  deepLink={deepLink}
                />
              ) : null}

              {report ? <AiAssessment report={report} target={target} /> : null}

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Meta label="Reason" value={report?.reason} />
                <Meta label="Reporter" value={shortId(report?.reporterId)} />
                <Meta label="Space" value={report?.spaceId ? shortId(report.spaceId) : "project-level"} />
                <Meta label="Target id" value={shortId(report?.targetId)} mono />
              </dl>

              {report?.details ? (
                <div className="rounded-lg border border-border bg-bg p-3 text-sm text-muted">{report.details}</div>
              ) : null}

              {canAct ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted">Moderation reason (optional)</label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being removed/kept?" />
                  {!scoped ? (
                    <p className="text-xs text-faint">Project-level report — actioning it uses your operator god-view.</p>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  This report isn't tied to a space, and your role can't action it — only a deployment operator can resolve project-level reports.
                </div>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => mutation.mutate("dismiss")} disabled={!canAct || busy}>
            Dismiss
          </Button>
          <Button variant="secondary" onClick={() => mutation.mutate("approved")} disabled={!canAct || busy}>
            <Check /> Keep
          </Button>
          <Button variant="danger" onClick={() => mutation.mutate("removed")} disabled={!canAct || busy}>
            <Ban /> Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const VERDICT_BADGE: Record<ModerationVerdict, "success" | "danger" | "warning"> = {
  allow: "success",
  block: "danger",
  review: "warning",
};

// AI assessment panel: shows the moderator service's stored verdict for the reported content and
// offers an on-demand re-analysis. Only entity/comment are analyzable from here (matches what the
// ReviewDialog loads). Degrades gracefully when the moderator service is unreachable.
function AiAssessment({ report, target }: { report: Report; target: Entity | Comment | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const analyzable = report.targetType === "entity" || report.targetType === "comment";
  const query = useQuery({
    queryKey: aiAnalysisKey(report.targetType, report.targetId),
    queryFn: () => getAnalysis(report.targetType, report.targetId),
    enabled: analyzable,
    retry: false,
  });

  const text = targetText(report.targetType, target);
  const mutation = useMutation({
    mutationFn: () =>
      analyzeTarget({ targetType: report.targetType, targetId: report.targetId, spaceId: report.spaceId, text }),
    onSuccess: (a) => {
      track("admin-reanalyze", { surface: "report", targetType: report.targetType });
      qc.setQueryData(aiAnalysisKey(report.targetType, report.targetId), a);
    },
    onError: (e) =>
      toast({ title: "Analysis failed", description: e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  if (!analyzable) return null;
  const a = query.data;
  const busy = mutation.isPending;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
          <Bot className="size-4 text-primary" /> AI assessment
        </p>
        <Button variant="ghost" onClick={() => mutation.mutate()} disabled={busy || !text}>
          <Sparkles className="size-3.5" /> {busy ? "Analyzing…" : a ? "Re-analyze" : "Analyze"}
        </Button>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted">Loading assessment…</p>
      ) : query.isError ? (
        <p className="text-sm text-muted">Moderator service unavailable.</p>
      ) : a ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={VERDICT_BADGE[a.verdict]}>{a.verdict}</Badge>
            <span className="text-xs text-muted">{Math.round(a.confidence * 100)}% confidence</span>
            {a.autoActioned ? <Badge variant="danger">auto-removed</Badge> : null}
            {a.categories.map((cat) => (
              <Badge key={cat} variant="default">{cat}</Badge>
            ))}
          </div>
          {a.reason ? <p className="whitespace-pre-wrap break-words text-sm text-muted">{a.reason}</p> : null}
          <p className="text-xs text-faint">{a.model}</p>
        </div>
      ) : (
        <p className="text-sm text-muted">Not analyzed yet.</p>
      )}
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className={mono ? "font-mono text-xs text-fg" : "text-fg"}>{value || "—"}</dd>
    </div>
  );
}
